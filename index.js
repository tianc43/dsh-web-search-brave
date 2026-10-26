/**
 * Brave Web Search provider for the DeepSeek Harness (DSH) web seam.
 *
 * Registers a `brave` search provider with `ctx.web`, backed by
 * `https://api.search.brave.com/res/v1/web/search`.
 *
 * Transport: the provider opens its own TLS socket and can tunnel it through an
 * HTTP CONNECT proxy (`proxy` config, or `HTTPS_PROXY` / `HTTP_PROXY` from the
 * environment), so it works on networks where Brave is only reachable through a
 * local proxy — without installing a process-wide dispatcher that would also
 * route model traffic.
 *
 * Credentials: the key is a DSH credential reference (default `BRAVE_API_KEY`)
 * resolved through `ctx.credentials` on every search, so rotating it needs no
 * plugin restart. It is never read from this repository.
 *
 * @module dsh-web-search-brave
 */

import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

/** Cordis plugin name. */
export const name = 'web-search-brave'

/** The one seam this provider registers into. */
export const inject = ['web']

const PROVIDER_ID = 'brave'
const DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1'
const DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'
const DEFAULT_COUNT = 10
const DEFAULT_TIMEOUT_MS = 30_000
/** Brave caps `count` at 20 for its web search endpoint. */
const MAX_COUNT = 20

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

/** Strip Brave's highlight markup and decode the entities its snippets use. */
function plainText(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, match => HTML_ENTITIES[match] ?? match)
    .replace(/\s+/g, ' ')
    .trim()
}

/** One normalized Brave result; optional fields are omitted when absent. */
function toSource(item) {
  const source = {}
  if (typeof item.url === 'string' && item.url.length > 0) source.url = item.url
  if (typeof item.title === 'string' && item.title.length > 0) source.title = plainText(item.title)
  const snippet = typeof item.description === 'string' && item.description.length > 0
    ? item.description
    : Array.isArray(item.extra_snippets) && typeof item.extra_snippets[0] === 'string'
      ? item.extra_snippets[0]
      : undefined
  if (snippet !== undefined) source.snippet = plainText(snippet)
  if (typeof item.page_age === 'string' && item.page_age.length > 0) source.publishedAt = item.page_age
  return source
}

/** Whether the `NO_PROXY` list asks for a direct connection to this host. */
function bypassesProxy(noProxy, host) {
  if (typeof noProxy !== 'string' || noProxy.trim().length === 0) return false
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '')
  return noProxy.split(',').some(entry => {
    const pattern = entry.trim().toLowerCase()
    if (pattern.length === 0) return false
    if (pattern === '*') return true
    const trimmed = pattern.replace(/^\./, '')
    return bare === trimmed || bare.endsWith(`.${trimmed}`)
  })
}

/**
 * An `https.Agent` that reaches the origin through an HTTP CONNECT tunnel.
 * One instance per request; sockets are not kept alive.
 */
class ProxyHttpsAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false })
    this.proxy = new URL(proxyUrl)
  }

  createConnection(options, callback) {
    const host = options.host
    const port = Number(options.port ?? 443)
    const proxyPort = Number(this.proxy.port.length > 0 ? this.proxy.port : 80)
    const socket = net.connect({ host: this.proxy.hostname, port: proxyPort })
    socket.once('error', callback)
    socket.once('connect', () => {
      const authorization = this.proxy.username.length > 0
        ? `Proxy-Authorization: Basic ${Buffer.from(
          `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`,
        ).toString('base64')}\r\n`
        : ''
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authorization}\r\n`)
      let buffered = ''
      const onData = chunk => {
        buffered += chunk.toString('latin1')
        const end = buffered.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.removeListener('data', onData)
        const status = Number(buffered.slice(9, 12))
        if (status !== 200) {
          socket.destroy()
          callback(new Error(`proxy CONNECT failed: ${buffered.split('\r\n')[0]}`))
          return
        }
        const secure = tls.connect({ socket, servername: host })
        secure.once('error', callback)
        secure.once('secureConnect', () => callback(null, secure))
      }
      socket.on('data', onData)
    })
  }
}

/** One HTTPS GET, returning the status code and the decoded body. */
function httpsGet(url, headers, options) {
  return new Promise((resolve, reject) => {
    const useProxy = options.proxy.length > 0 && !bypassesProxy(options.noProxy, url.hostname)
    const agent = useProxy ? new ProxyHttpsAgent(options.proxy) : undefined
    const request = https.get(url, { agent, headers, signal: options.signal }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        agent?.destroy()
      })
    })
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error('request timed out')))
    request.on('error', error => {
      agent?.destroy()
      reject(error)
    })
  })
}

/** A Brave-backed `WebSearchProvider` for `ctx.web`. */
export class BraveSearchProvider {
  constructor(options) {
    this.baseURL = options.baseURL
    this.count = options.count
    this.proxy = options.proxy
    this.noProxy = options.noProxy
    this.country = options.country
    this.searchLang = options.searchLang
    this.safesearch = options.safesearch
    this.timeoutMs = options.timeoutMs
    this.resolveApiKey = options.resolveApiKey
  }

  get id() {
    return PROVIDER_ID
  }

  /** Cheap local check: the key and the proxy are resolved per search, never here. */
  available() {
    return true
  }

  async search(request, signal) {
    if (signal?.aborted === true) throw new Error('brave search: aborted')
    const apiKey = await this.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('brave search: no API key; store one under the BRAVE_API_KEY credential')
    }
    const limit = request.maxResults !== undefined && request.maxResults > 0
      ? Math.min(request.maxResults, MAX_COUNT)
      : Math.min(this.count, MAX_COUNT)
    const url = new URL(`${this.baseURL}/web/search`)
    url.searchParams.set('q', request.query)
    url.searchParams.set('count', String(limit))
    url.searchParams.set('text_decorations', 'false')
    if (this.country !== undefined) url.searchParams.set('country', this.country)
    if (this.searchLang !== undefined) url.searchParams.set('search_lang', this.searchLang)
    if (this.safesearch !== undefined) url.searchParams.set('safesearch', this.safesearch)
    let response
    try {
      response = await httpsGet(url, {
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'close',
        'User-Agent': 'dsh-web-search-brave/0.1.0',
        'X-Subscription-Token': apiKey,
      }, {
        proxy: this.proxy,
        noProxy: this.noProxy,
        signal,
        timeoutMs: this.timeoutMs,
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw new Error(`brave search: request failed (${error instanceof Error ? error.message : String(error)})`)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `brave search: HTTP ${response.status}${response.body.length > 0 ? ` — ${response.body.slice(0, 200)}` : ''}`,
      )
    }
    let payload
    try {
      payload = JSON.parse(response.body)
    } catch {
      throw new Error(`brave search: unreadable response — ${response.body.slice(0, 200)}`)
    }
    const items = Array.isArray(payload?.web?.results) ? payload.web.results : []
    const sources = items.map(toSource).filter(source => source.url !== undefined)
    if (request.maxResults !== undefined && sources.length > request.maxResults) {
      return { sources: sources.slice(0, request.maxResults), truncated: true }
    }
    return { sources, truncated: false }
  }
}

/** Register the Brave provider with `ctx.web`. */
export function apply(ctx, config) {
  const settings = config ?? {}
  const credentialName = typeof settings.apiKeyEnv === 'string' && settings.apiKeyEnv.length > 0
    ? settings.apiKeyEnv
    : DEFAULT_API_KEY_ENV
  const proxy = typeof settings.proxy === 'string'
    ? settings.proxy
    : (process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '')
  const provider = new BraveSearchProvider({
    baseURL: typeof settings.baseURL === 'string' && settings.baseURL.length > 0
      ? settings.baseURL.replace(/\/+$/, '')
      : DEFAULT_BASE_URL,
    count: typeof settings.count === 'number' && settings.count > 0 ? settings.count : DEFAULT_COUNT,
    proxy,
    noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? '',
    country: typeof settings.country === 'string' && settings.country.length > 0 ? settings.country : undefined,
    searchLang: typeof settings.searchLang === 'string' && settings.searchLang.length > 0
      ? settings.searchLang
      : undefined,
    safesearch: typeof settings.safesearch === 'string' && settings.safesearch.length > 0
      ? settings.safesearch
      : undefined,
    timeoutMs: typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0
      ? settings.timeoutMs
      : DEFAULT_TIMEOUT_MS,
    resolveApiKey: async () => {
      const literal = settings.apiKey
      if (typeof literal === 'string' && literal.length > 0) return literal
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const hit = await credentials.resolve(credentialName)
        if (hit !== undefined && hit.value.length > 0) return hit.value
      }
      const ambient = process.env[credentialName]
      return ambient !== undefined && ambient.length > 0 ? ambient : undefined
    },
  })
  ctx.web.registerSearchProvider(provider)
}