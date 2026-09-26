// Shipped anchor (getBlockNumber then getBlock(n)) vs proposed (getBlock('latest')), through the
// same ethers 6.17.0 JsonRpcProvider construction xl1-sdk uses for the EVM connection.
import { JsonRpcProvider } from 'ethers'
const URL = process.env.EVM || 'https://ethereum-sepolia-rpc.publicnode.com'
const ROUNDS = +(process.env.ROUNDS || 60)
const mk = () => new JsonRpcProvider(URL, 11155111, { polling: true, staticNetwork: true })
const A = mk(), B = mk()
const shipped = async (p) => { const n = await p.getBlockNumber(); const b = await p.getBlock(n); if (!b?.hash) throw new Error('null'); return n }
const proposed = async (p) => { const b = await p.getBlock('latest'); if (!b?.hash) throw new Error('null'); return b.number }
const time = async (f, p) => { const t = performance.now(); const n = await f(p); return [performance.now() - t, n] }
for (let i = 0; i < 3; i++) { await time(shipped, A); await time(proposed, B) }
const sa = [], sb = [], fresh = []; let errA = 0, errB = 0
for (let i = 0; i < ROUNDS; i++) {
  const order = i % 2 ? [['a', shipped, A], ['b', proposed, B]] : [['b', proposed, B], ['a', shipped, A]]
  const h = {}
  for (const [k, f, p] of order) { try { const [ms, n] = await time(f, p); (k === 'a' ? sa : sb).push(ms); h[k] = n } catch { k === 'a' ? errA++ : errB++ } }
  if (h.a !== undefined && h.b !== undefined) fresh.push(h.b - h.a)
  await new Promise(r => setTimeout(r, 600))
}
const q = (a, p) => { a = [...a].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))]) }
const mean = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length)
console.log(JSON.stringify({ where: process.env.WHERE, rounds: ROUNDS,
  shipped: { p50: q(sa, .5), p90: q(sa, .9), mean: mean(sa), errors: errA },
  proposed: { p50: q(sb, .5), p90: q(sb, .9), mean: mean(sb), errors: errB },
  savedP50: q(sa, .5) - q(sb, .5),
  heightDiff_proposedMinusShipped: { min: Math.min(...fresh), max: Math.max(...fresh), mean: +(fresh.reduce((x, y) => x + y, 0) / fresh.length).toFixed(3) } }))
