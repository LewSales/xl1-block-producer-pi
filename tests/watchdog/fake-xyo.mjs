// Preload for tests only: an offline stand-in for XYO's public endpoints, so the watchdog tests send no
// traffic anywhere (2026-10-22: test traffic must never share the producers' internet connection).
// It answers exactly what race-service.mjs asks for: the RPC (pending blocks / transactions), the
// chain head and the block files. A new block every 2 s and a new candidate every poll keep the loops busy.
//   FAKE_XYO=ok (default)  normal answers
//   FAKE_XYO=down          every request fails fast like a refused connection (an upstream outage)
//   FAKE_XYO=dns-fail      every request fails fast like a DNS failure (getaddrinfo ENOTFOUND)
//   FAKE_XYO=hang          every request hangs and ignores its abort signal (this process's network wedged)
const mode = process.env.FAKE_XYO || 'ok'
const t0 = Date.now(), base = 1_000_000
const tip = () => base + Math.floor((Date.now() - t0) / 2000)
const addr = (i) => String(i % 7).repeat(40)
const time = (epoch) => [{ schema: 'network.xyo.time', epoch }]
const hash = (s) => s.padEnd(64, '0').slice(0, 64)
let seq = 0
const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const fail = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })

globalThis.fetch = async (url, init = {}) => {
  if (mode === 'hang') return new Promise(() => {})
  if (mode === 'down') throw fail('ECONNREFUSED')
  if (mode === 'dns-fail') throw fail('ENOTFOUND')
  const u = String(url)
  if (init.method === 'POST') {
    const { method } = JSON.parse(init.body || '{}')
    if (method === 'mempoolViewer_pendingBlocks') { seq++; const n = tip() + 1; return reply({ jsonrpc: '2.0', id: 1, result: [[{ _hash: hash(`c${seq}`), block: n, addresses: [addr(seq)] }, time(Date.now())]] }) }
    if (method === 'mempoolViewer_pendingTransactions') return reply({ jsonrpc: '2.0', id: 1, result: [] })
    return reply({ jsonrpc: '2.0', id: 1, result: null })
  }
  if (u.endsWith('/chain/head.json')) { const n = tip(); return reply([{ _hash: hash(`h${n}`), block: n, addresses: [addr(n)] }, time(t0 + (n - base) * 2000)]) }
  const m = /\/block\/number\/(\d+)\.json$/.exec(u)
  if (m) { const n = +m[1]; return reply([{ _hash: hash(`h${n}`), block: n, addresses: [addr(n)] }, time(t0 - (base - n) * 2000)]) }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
}
