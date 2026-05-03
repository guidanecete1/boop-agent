import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createRevenueCatClient,
  RevenueCatAuthError,
  RevenueCatNotFoundError,
} from './client.js'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
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

describe('RevenueCatClient', () => {
  describe('project_id resolution', () => {
    it('fetches /v2/projects on first call and caches the project_id', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, { items: [{ id: 'proj_abc' }] }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { id: 'cust_1', subscriptions: [] }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { id: 'cust_2', subscriptions: [] }),
        )

      const client = createRevenueCatClient()
      await client.getCustomer('sk_test', 'app_x', 'user_1')
      await client.getCustomer('sk_test', 'app_x', 'user_2')

      // 3 fetches: 1× /projects + 2× /customers; project_id reused
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(fetchMock.mock.calls[0][0]).toContain('/v2/projects')
      expect(fetchMock.mock.calls[1][0]).toContain('/projects/proj_abc/apps/app_x/customers/user_1')
      expect(fetchMock.mock.calls[2][0]).toContain('/projects/proj_abc/apps/app_x/customers/user_2')
    })

    it('caches project_id per API key (different keys hit /projects again)', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'proj_a' }] }))
        .mockResolvedValueOnce(jsonResponse(200, { id: 'c1' }))
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'proj_b' }] }))
        .mockResolvedValueOnce(jsonResponse(200, { id: 'c2' }))

      const client = createRevenueCatClient()
      await client.getCustomer('sk_key_a', 'app_x', 'u1')
      await client.getCustomer('sk_key_b', 'app_y', 'u1')

      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(fetchMock.mock.calls[1][0]).toContain('proj_a')
      expect(fetchMock.mock.calls[3][0]).toContain('proj_b')
    })
  })

  describe('auth + errors', () => {
    it('sends Bearer auth header on every call', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'p1' }] }))
        .mockResolvedValueOnce(jsonResponse(200, { id: 'c1' }))

      const client = createRevenueCatClient()
      await client.getCustomer('sk_test_xyz', 'app_x', 'u1')

      const projectsInit = fetchMock.mock.calls[0][1] as RequestInit
      const projectsHeaders = projectsInit.headers as Record<string, string>
      expect(projectsHeaders['Authorization']).toBe('Bearer sk_test_xyz')

      const customerInit = fetchMock.mock.calls[1][1] as RequestInit
      const customerHeaders = customerInit.headers as Record<string, string>
      expect(customerHeaders['Authorization']).toBe('Bearer sk_test_xyz')
    })

    it('throws RevenueCatAuthError on 401 from /projects', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { code: 'unauthorized' }),
      )

      const client = createRevenueCatClient()
      await expect(client.getCustomer('sk_bad', 'app_x', 'u1')).rejects.toBeInstanceOf(
        RevenueCatAuthError,
      )
    })

    it('throws RevenueCatNotFoundError on 404 from a customer endpoint', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'p1' }] }))
        .mockResolvedValueOnce(jsonResponse(404, { code: 'not_found' }))

      const client = createRevenueCatClient()
      await expect(
        client.getCustomer('sk_test', 'app_x', 'missing_user'),
      ).rejects.toBeInstanceOf(RevenueCatNotFoundError)
    })

    it('retries once on 429 and succeeds on the second attempt', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'p1' }] }))
        .mockResolvedValueOnce(jsonResponse(429, { code: 'rate_limit' }))
        .mockResolvedValueOnce(jsonResponse(200, { id: 'c1' }))

      const client = createRevenueCatClient({ retryDelayMs: 0 })
      const result = await client.getCustomer('sk_test', 'app_x', 'u1')
      expect(result).toEqual({ id: 'c1' })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('throws after a second 429', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'p1' }] }))
        .mockResolvedValueOnce(jsonResponse(429, {}))
        .mockResolvedValueOnce(jsonResponse(429, {}))

      const client = createRevenueCatClient({ retryDelayMs: 0 })
      await expect(client.getCustomer('sk_test', 'app_x', 'u1')).rejects.toThrow(/rate limit/i)
    })

    it('retries once on 503 and succeeds on the second attempt', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'p1' }] }))
        .mockResolvedValueOnce(jsonResponse(503, {}))
        .mockResolvedValueOnce(jsonResponse(200, { id: 'c1' }))

      const client = createRevenueCatClient({ retryDelayMs: 0 })
      const result = await client.getCustomer('sk_test', 'app_x', 'u1')
      expect(result).toEqual({ id: 'c1' })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe('list endpoints', () => {
    it('listSubscriptions passes status + limit query params', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'p1' }] }))
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'sub1' }] }))

      const client = createRevenueCatClient()
      await client.listSubscriptions('sk_test', 'app_x', { status: 'active', limit: 5 })

      const calledUrl = fetchMock.mock.calls[1][0] as string
      expect(calledUrl).toMatch(/status=active/)
      expect(calledUrl).toMatch(/limit=5/)
    })

    it('listPurchases passes since + limit', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'p1' }] }))
        .mockResolvedValueOnce(jsonResponse(200, { items: [] }))

      const client = createRevenueCatClient()
      await client.listPurchases('sk_test', 'app_x', { since: '2026-04-01T00:00:00Z', limit: 10 })

      const calledUrl = fetchMock.mock.calls[1][0] as string
      expect(calledUrl).toMatch(/since=2026-04-01/)
      expect(calledUrl).toMatch(/limit=10/)
    })

    it('getAppMetrics passes period', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'p1' }] }))
        .mockResolvedValueOnce(jsonResponse(200, { mrr: 1234 }))

      const client = createRevenueCatClient()
      await client.getAppMetrics('sk_test', 'app_x', { period: 'month' })

      const calledUrl = fetchMock.mock.calls[1][0] as string
      expect(calledUrl).toMatch(/period=month/)
    })
  })
})
