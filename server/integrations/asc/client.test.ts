import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createAscClient,
  AscAuthError,
  AscNotFoundError,
} from './client.js'

const fetchMock = vi.fn()
const signMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  signMock.mockReset()
  signMock.mockReturnValue('fake.jwt.token')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function defaultOpts() {
  return {
    keyId: 'ABC123',
    issuerId: 'iss-uuid',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    signJwt: signMock,
    retryDelayMs: 0,
  }
}

describe('AscClient', () => {
  describe('JWT auth', () => {
    it('mints a JWT with correct claims and uses it as Bearer auth', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { data: [{ id: 'app1', attributes: { bundleId: 'com.x.y', name: 'X', sku: 'sku1', primaryLocale: 'en-US' } }] }),
      )

      const client = createAscClient(defaultOpts())
      await client.listApps()

      expect(signMock).toHaveBeenCalledTimes(1)
      const claims = signMock.mock.calls[0][0]
      expect(claims).toMatchObject({
        iss: 'iss-uuid',
        aud: 'appstoreconnect-v1',
      })
      expect(typeof claims.iat).toBe('number')
      expect(typeof claims.exp).toBe('number')
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60)

      const init = fetchMock.mock.calls[0][1] as RequestInit
      const headers = init.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer fake.jwt.token')
    })

    it('caches the JWT across calls within the TTL', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'app1', attributes: { bundleId: 'com.a', name: 'A', sku: 's', primaryLocale: 'en-US' } }] }))
        .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'app2', attributes: { bundleId: 'com.b', name: 'B', sku: 's', primaryLocale: 'en-US' } }] }))

      const client = createAscClient(defaultOpts())
      await client.listApps()
      await client.listApps()

      // Two HTTP calls, but only one JWT mint
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(signMock).toHaveBeenCalledTimes(1)
    })

    it('mints a new JWT after ttl elapses', async () => {
      vi.useFakeTimers()
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }))

      const client = createAscClient({ ...defaultOpts(), jwtTtlMs: 1000 })
      await client.listApps()
      vi.advanceTimersByTime(2000)
      await client.listApps()

      expect(signMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })
  })

  describe('app_id resolution from bundle_id', () => {
    it('resolves bundle_id → app_id via /v1/apps once and caches', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: [
              { id: 'app_mila', attributes: { bundleId: 'com.alfredo.mila', name: 'Mila', sku: 'mila', primaryLocale: 'en-US' } },
              { id: 'app_pep', attributes: { bundleId: 'com.alfredo.pepbuddy', name: 'PepBuddy', sku: 'pep', primaryLocale: 'en-US' } },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'b1', attributes: { version: '1.0', uploadedDate: '2026-01-01T00:00:00Z' } }] }))
        .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'b2', attributes: { version: '2.0', uploadedDate: '2026-01-02T00:00:00Z' } }] }))

      const client = createAscClient(defaultOpts())
      await client.listBuilds('com.alfredo.mila', { limit: 3 })
      await client.listBuilds('com.alfredo.pepbuddy', { limit: 3 })

      // 3 fetches: 1× /v1/apps (resolution) + 2× /v1/builds
      expect(fetchMock).toHaveBeenCalledTimes(3)
      const url1 = fetchMock.mock.calls[1][0] as string
      const url2 = fetchMock.mock.calls[2][0] as string
      expect(url1).toContain('filter%5Bapp%5D=app_mila')
      expect(url2).toContain('filter%5Bapp%5D=app_pep')
    })

    it('parallel resolveAppId calls share a single /v1/apps fetch', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: [
              { id: 'app_a', attributes: { bundleId: 'com.a', name: 'A', sku: 'a', primaryLocale: 'en-US' } },
              { id: 'app_b', attributes: { bundleId: 'com.b', name: 'B', sku: 'b', primaryLocale: 'en-US' } },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }))

      const client = createAscClient(defaultOpts())
      // Fire two listBuilds in parallel for different bundles before any
      // resolution has completed. Both should share one /v1/apps fetch.
      await Promise.all([
        client.listBuilds('com.a', { limit: 1 }),
        client.listBuilds('com.b', { limit: 1 }),
      ])

      // Expected: 1× /v1/apps + 2× /v1/builds = 3 total
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('throws AscNotFoundError when bundle_id is not in the team', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          data: [{ id: 'app1', attributes: { bundleId: 'com.other', name: 'Other', sku: 's', primaryLocale: 'en-US' } }],
        }),
      )

      const client = createAscClient(defaultOpts())
      await expect(
        client.listBuilds('com.does.not.exist', { limit: 3 }),
      ).rejects.toBeInstanceOf(AscNotFoundError)
    })
  })

  describe('errors + retries', () => {
    it('throws AscAuthError on 401', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { errors: [{ code: 'NOT_AUTHORIZED' }] }))

      const client = createAscClient(defaultOpts())
      await expect(client.listApps()).rejects.toBeInstanceOf(AscAuthError)
    })

    it('throws AscNotFoundError on 404 from a build endpoint', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'app1', attributes: { bundleId: 'com.x', name: 'X', sku: 's', primaryLocale: 'en-US' } }] }))
        .mockResolvedValueOnce(jsonResponse(404, { errors: [{ code: 'NOT_FOUND' }] }))

      const client = createAscClient(defaultOpts())
      await expect(client.getBuild('com.x', 'missing_build')).rejects.toBeInstanceOf(AscNotFoundError)
    })

    it('retries once on 429 and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(429, {}))
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }))

      const client = createAscClient(defaultOpts())
      const result = await client.listApps()
      expect(result).toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('throws after second 429', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(429, {}))
        .mockResolvedValueOnce(jsonResponse(429, {}))

      const client = createAscClient(defaultOpts())
      await expect(client.listApps()).rejects.toThrow(/rate limit/i)
    })

    it('retries once on 503 and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(503, {}))
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }))

      const client = createAscClient(defaultOpts())
      const result = await client.listApps()
      expect(result).toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('list endpoints', () => {
    it('listBuilds passes limit + processing_state filter', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'app1', attributes: { bundleId: 'com.a', name: 'A', sku: 's', primaryLocale: 'en-US' } }] }))
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }))

      const client = createAscClient(defaultOpts())
      await client.listBuilds('com.a', { limit: 5, processing_state: 'VALID' })

      const url = fetchMock.mock.calls[1][0] as string
      expect(url).toMatch(/limit=5/)
      expect(url).toMatch(/filter%5BprocessingState%5D=VALID/)
    })

    it('getLatestBuild returns the first build matching the filter', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'app1', attributes: { bundleId: 'com.a', name: 'A', sku: 's', primaryLocale: 'en-US' } }] }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: [
              { id: 'b3', attributes: { version: '1.0.3', buildNumber: '42', uploadedDate: '2026-03-01T00:00:00Z', processingState: 'VALID' } },
              { id: 'b2', attributes: { version: '1.0.2', buildNumber: '41', uploadedDate: '2026-02-01T00:00:00Z', processingState: 'VALID' } },
            ],
          }),
        )

      const client = createAscClient(defaultOpts())
      const latest = await client.getLatestBuild('com.a', { processing_state: 'VALID' })
      expect(latest.id).toBe('b3')
      expect(latest.version).toBe('1.0.3')
      expect(latest.build_number).toBe('42')
    })
  })
})
