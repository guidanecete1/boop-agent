import jwt from 'jsonwebtoken'

const API_BASE = 'https://api.appstoreconnect.apple.com'

export class AscAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AscAuthError'
  }
}
export class AscNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AscNotFoundError'
  }
}

export interface AscApp {
  id: string
  bundle_id: string
  name: string
  sku: string
  primary_locale: string
}

export interface AscBuild {
  id: string
  version?: string
  build_number?: string
  processing_state?: 'PROCESSING' | 'VALID' | 'INVALID' | 'FAILED'
  uploaded_date?: string
  expiration_date?: string
}

export interface ListBuildsOpts {
  limit?: number
  processing_state?: 'PROCESSING' | 'VALID' | 'INVALID' | 'FAILED'
}

export interface AscClient {
  listApps(): Promise<AscApp[]>
  listBuilds(bundleId: string, opts?: ListBuildsOpts): Promise<AscBuild[]>
  getBuild(bundleId: string, buildId: string): Promise<AscBuild>
  getLatestBuild(bundleId: string, opts?: ListBuildsOpts): Promise<AscBuild>
}

export interface ClientOpts {
  keyId: string
  issuerId: string
  privateKeyPem: string
  /** Override the signer (tests). Defaults to jsonwebtoken.sign. */
  signJwt?: (claims: object, privateKey: string, options: jwt.SignOptions) => string
  /** Retry-once delay (default 2000 ms). Tests pass 0. */
  retryDelayMs?: number
  /** JWT lifetime; defaults to 19 min. ASC max is 20 min. */
  jwtTtlMs?: number
}

interface CachedToken {
  jwt: string
  expiresAt: number
}

export function createAscClient(opts: ClientOpts): AscClient {
  const retryDelayMs = opts.retryDelayMs ?? 2000
  const jwtTtlMs = opts.jwtTtlMs ?? 19 * 60 * 1000
  const signJwt = opts.signJwt ?? jwt.sign

  let cachedToken: CachedToken | null = null
  // Cache app_id by bundle_id; populated lazily by resolveAppId.
  const appIdByBundle = new Map<string, string>()
  // In-flight dedup: parallel callers share a single /v1/apps fetch.
  // Cleared after each fetch completes so subsequent (sequential) listApps()
  // calls still re-fetch — this preserves the JWT-caching test's contract
  // that listApps() twice in a row hits fetch twice.
  let inFlightAppsFetch: Promise<AscApp[]> | null = null

  function getJwt(): string {
    const now = Date.now()
    if (cachedToken && cachedToken.expiresAt > now + 30_000) {
      return cachedToken.jwt
    }
    const iat = Math.floor(now / 1000)
    const exp = iat + Math.floor(jwtTtlMs / 1000)
    const token = signJwt(
      { iss: opts.issuerId, iat, exp, aud: 'appstoreconnect-v1' },
      opts.privateKeyPem,
      {
        algorithm: 'ES256',
        header: { alg: 'ES256', kid: opts.keyId, typ: 'JWT' },
      },
    )
    cachedToken = { jwt: token, expiresAt: now + jwtTtlMs }
    return token
  }

  async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let res: Response
    let retried = false
    try {
      res = await fetch(url, init)
    } catch (err) {
      retried = true
      await new Promise((r) => setTimeout(r, retryDelayMs))
      res = await fetch(url, init)
    }
    if (!retried && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, retryDelayMs))
      res = await fetch(url, init)
    }
    return res
  }

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${getJwt()}`, Accept: 'application/json' }
  }

  async function call(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v))
    }
    const qs = params.toString()
    const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`
    const res = await fetchWithRetry(url, { headers: authHeaders() })
    if (res.status === 401) throw new AscAuthError(`ASC 401 — API key invalid (${url})`)
    if (res.status === 404) throw new AscNotFoundError(`ASC 404 — not found (${url})`)
    if (res.status === 429) throw new Error(`ASC rate limit (429) after retry on ${url}`)
    if (!res.ok) throw new Error(`ASC ${res.status} on ${url}: ${await res.text().catch(() => '')}`)
    return res.json()
  }

  async function populateAppsCache(): Promise<AscApp[]> {
    const body = (await call('/v1/apps', { limit: 200 })) as {
      data: Array<{ id: string; attributes: { bundleId: string; name: string; sku: string; primaryLocale: string } }>
    }
    const apps: AscApp[] = body.data.map((d) => ({
      id: d.id,
      bundle_id: d.attributes.bundleId,
      name: d.attributes.name,
      sku: d.attributes.sku,
      primary_locale: d.attributes.primaryLocale,
    }))
    for (const a of apps) appIdByBundle.set(a.bundle_id, a.id)
    return apps
  }

  async function fetchAllApps(): Promise<AscApp[]> {
    // If another caller is mid-fetch, share their result instead of firing a
    // duplicate /v1/apps request. After the in-flight resolves, the ref is
    // cleared so subsequent (sequential) calls fetch fresh — the JWT-caching
    // test relies on this (two listApps() calls in a row should hit fetch
    // twice).
    if (inFlightAppsFetch) {
      return inFlightAppsFetch
    }
    const promise = populateAppsCache()
    inFlightAppsFetch = promise
    try {
      return await promise
    } finally {
      inFlightAppsFetch = null
    }
  }

  async function resolveAppId(bundleId: string): Promise<string> {
    const cached = appIdByBundle.get(bundleId)
    if (cached) return cached
    await fetchAllApps()
    const found = appIdByBundle.get(bundleId)
    if (!found) {
      throw new AscNotFoundError(`No app with bundle_id "${bundleId}" in this ASC team.`)
    }
    return found
  }

  function buildFromAttributes(d: { id: string; attributes: Record<string, unknown> }): AscBuild {
    const a = d.attributes
    return {
      id: d.id,
      version: a.version as string | undefined,
      build_number: a.buildNumber as string | undefined,
      processing_state: a.processingState as AscBuild['processing_state'],
      uploaded_date: a.uploadedDate as string | undefined,
      expiration_date: a.expirationDate as string | undefined,
    }
  }

  return {
    async listApps() {
      return fetchAllApps()
    },
    async listBuilds(bundleId, optsArg = {}) {
      const appId = await resolveAppId(bundleId)
      const query: Record<string, string | number | undefined> = {
        'filter[app]': appId,
        limit: optsArg.limit ?? 10,
        sort: '-uploadedDate',
      }
      if (optsArg.processing_state) {
        query['filter[processingState]'] = optsArg.processing_state
      }
      const body = (await call('/v1/builds', query)) as {
        data: Array<{ id: string; attributes: Record<string, unknown> }>
      }
      return body.data.map(buildFromAttributes)
    },
    async getBuild(bundleId, buildId) {
      // Resolve to ensure the bundle is in our team (defensive — and primes cache).
      await resolveAppId(bundleId)
      const body = (await call(`/v1/builds/${buildId}`)) as {
        data: { id: string; attributes: Record<string, unknown> }
      }
      return buildFromAttributes(body.data)
    },
    async getLatestBuild(bundleId, optsArg = {}) {
      const appId = await resolveAppId(bundleId)
      const query: Record<string, string | number | undefined> = {
        'filter[app]': appId,
        limit: 1,
        sort: '-uploadedDate',
      }
      if (optsArg.processing_state) {
        query['filter[processingState]'] = optsArg.processing_state
      }
      const body = (await call('/v1/builds', query)) as {
        data: Array<{ id: string; attributes: Record<string, unknown> }>
      }
      const first = body.data[0]
      if (!first) {
        throw new AscNotFoundError(`No matching build for bundle_id "${bundleId}"`)
      }
      return buildFromAttributes(first)
    },
  }
}
