const API_BASE = 'https://api.revenuecat.com/v2'

export class RevenueCatAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevenueCatAuthError'
  }
}
export class RevenueCatNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevenueCatNotFoundError'
  }
}

export interface ListSubscriptionsOpts {
  status?: 'active' | 'expired' | 'all'
  limit?: number
}
export interface ListPurchasesOpts {
  since?: string
  limit?: number
}
export interface GetAppMetricsOpts {
  period?: 'day' | 'week' | 'month'
}

export interface RevenueCatClient {
  listSubscriptions(apiKey: string, appId: string, opts?: ListSubscriptionsOpts): Promise<unknown>
  listPurchases(apiKey: string, appId: string, opts?: ListPurchasesOpts): Promise<unknown>
  getCustomer(apiKey: string, appId: string, appUserId: string): Promise<unknown>
  getAppMetrics(apiKey: string, appId: string, opts?: GetAppMetricsOpts): Promise<unknown>
}

interface ClientOpts {
  /** Delay between the first failure and the single retry. Default 2000ms. */
  retryDelayMs?: number
}

export function createRevenueCatClient(opts: ClientOpts = {}): RevenueCatClient {
  const retryDelayMs = opts.retryDelayMs ?? 2000
  // Cache project_id per API key — RC API requires project_id in URLs but
  // each API key authenticates to exactly one project, so we resolve it
  // once and reuse.
  const projectIdByKey = new Map<string, Promise<string>>()

  async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let res: Response
    let retried = false
    try {
      res = await fetch(url, init)
    } catch (err) {
      // Network error — single retry
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

  function authHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    }
  }

  async function resolveProjectId(apiKey: string): Promise<string> {
    let cached = projectIdByKey.get(apiKey)
    if (cached) return cached
    cached = (async () => {
      const res = await fetchWithRetry(`${API_BASE}/projects`, {
        headers: authHeaders(apiKey),
      })
      if (res.status === 401) {
        throw new RevenueCatAuthError(
          'RevenueCat API key invalid or expired (401 from /v2/projects).',
        )
      }
      if (!res.ok) {
        throw new Error(`RevenueCat /v2/projects returned ${res.status}`)
      }
      const body = (await res.json()) as { items?: Array<{ id: string }> }
      const id = body.items?.[0]?.id
      if (!id) throw new Error('RevenueCat /v2/projects returned no project items.')
      return id
    })()
    projectIdByKey.set(apiKey, cached)
    try {
      return await cached
    } catch (err) {
      // Don't poison the cache on failure
      projectIdByKey.delete(apiKey)
      throw err
    }
  }

  async function call(
    apiKey: string,
    pathSegments: string[],
    query: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    const projectId = await resolveProjectId(apiKey)
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v))
    }
    const qs = params.toString()
    const url = `${API_BASE}/projects/${projectId}/${pathSegments.join('/')}${qs ? `?${qs}` : ''}`
    const res = await fetchWithRetry(url, { headers: authHeaders(apiKey) })
    if (res.status === 401) {
      throw new RevenueCatAuthError(`RevenueCat 401 — API key invalid or expired (${url}).`)
    }
    if (res.status === 404) {
      throw new RevenueCatNotFoundError(`RevenueCat 404 — resource not found (${url}).`)
    }
    if (res.status === 429) {
      throw new Error(`RevenueCat rate limit (429) after retry on ${url}.`)
    }
    if (!res.ok) {
      throw new Error(`RevenueCat ${res.status} on ${url}: ${await res.text().catch(() => '')}`)
    }
    return res.json()
  }

  return {
    listSubscriptions(apiKey, appId, opts = {}) {
      return call(apiKey, ['apps', appId, 'subscriptions'], {
        status: opts.status,
        limit: opts.limit,
      })
    },
    listPurchases(apiKey, appId, opts = {}) {
      return call(apiKey, ['apps', appId, 'purchases'], {
        since: opts.since,
        limit: opts.limit,
      })
    },
    getCustomer(apiKey, appId, appUserId) {
      return call(apiKey, ['apps', appId, 'customers', appUserId])
    },
    getAppMetrics(apiKey, appId, opts = {}) {
      return call(apiKey, ['apps', appId, 'metrics'], {
        period: opts.period,
      })
    },
  }
}
