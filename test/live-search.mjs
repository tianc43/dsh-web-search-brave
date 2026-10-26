// Live smoke test: registers the provider exactly like DSH does and runs one
// real Brave search. Requires network access (through `HTTPS_PROXY` when set).
//
//   BRAVE_API_KEY=... node test/live-search.mjs "画渣花小烙"
//
// Nothing in this file touches the key beyond handing it to the provider.

import { apply } from '../index.js'

const query = process.argv[2] ?? 'deepseek harness'

if (process.env.BRAVE_API_KEY === undefined || process.env.BRAVE_API_KEY.length === 0) {
  console.error('BRAVE_API_KEY is not set; run with BRAVE_API_KEY=<key> node test/live-search.mjs')
  process.exit(1)
}

const registered = []
const ctx = {
  get: name => (name === 'credentials'
    ? { resolve: async ref => ({ value: process.env[ref] ?? '' }) }
    : undefined),
  web: { registerSearchProvider: provider => registered.push(provider) },
}

apply(ctx, {
  apiKeyEnv: 'BRAVE_API_KEY',
  proxy: process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '',
})

const provider = registered[0]
if (provider === undefined || provider.id !== 'brave') {
  console.error('the plugin did not register a `brave` provider')
  process.exit(1)
}

const startedAt = Date.now()
const result = await provider.search({ query, maxResults: 3 })
console.log(`provider: ${provider.id} | query: ${query} | ${Date.now() - startedAt} ms`)
for (const source of result.sources) {
  console.log(`- ${source.title ?? '(untitled)'} | ${source.url}`)
  if (source.snippet !== undefined) console.log(`  ${source.snippet.slice(0, 120)}…`)
}
console.log(`sources: ${result.sources.length}, truncated: ${result.truncated}`)