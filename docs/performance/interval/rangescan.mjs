// Read-only: fetch [height, producer, epoch, anchor, txCount] for a height range from the public block CDN.
// Read-only: time payloads, producer and tx count for blocks [from, to] from the public block CDN.
import fs from 'node:fs'
const [from, toArg, outFile] = process.argv.slice(2)
const to = toArg === 'head' ? (await (await fetch('https://state.sequence.xyo.space/chain/head.json')).json())[0].block : +toArg
const nums = []; for (let n = +from; n <= to; n++) nums.push(n)
const rows = new Array(nums.length); let i = 0, done = 0, fails = 0
async function worker() {
  while (i < nums.length) {
    const k = i++, n = nums[k]
    for (let a = 0; a < 4; a++) {
      try {
        const r = await fetch(`https://blocks.sequence.xyo.space/block/number/${n}.json`, { signal: AbortSignal.timeout(8000) })
        if (!r.ok) throw new Error(r.status)
        const [bw, p] = await r.json()
        const t = p.find(x => x.schema === 'network.xyo.time')
        const txs = p.filter(x => x.schema === 'network.xyo.boundwitness' && x.fees).length
        rows[k] = [n, bw.addresses[0].slice(0, 8), t?.epoch ?? null, t?.ethereum ?? null, txs]
        break
      } catch { if (a === 3) fails++; else await new Promise(r => setTimeout(r, 300 * (a + 1))) }
    }
    if (++done % 5000 === 0) console.error(`${done}/${nums.length}`)
  }
}
await Promise.all([...Array(12)].map(worker))
fs.writeFileSync(outFile, JSON.stringify(rows.filter(Boolean)))
console.log(`scanned ${from}..${to}: ${rows.filter(Boolean).length} ok, ${fails} failed`)
