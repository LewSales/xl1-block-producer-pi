// Read-only chain scan: time payloads of the last N finalized blocks from the public REST CDN.
// node chainscan.mjs 1440 chain.json  (writes chain.json; no producer involvement)
import fs from 'node:fs'
const B='https://blocks.sequence.xyo.space', N=+process.argv[2]||720
const head=(await (await fetch('https://state.sequence.xyo.space/chain/head.json')).json())
const top=head[0].block
const nums=[...Array(N+1)].map((_,i)=>top-N+i)
const out=new Map()
let i=0
async function worker(){while(i<nums.length){const n=nums[i++];for(let a=0;a<3;a++){try{const r=await fetch(`${B}/block/number/${n}.json`);if(r.ok){out.set(n,await r.json());break}}catch{}}}}
await Promise.all([...Array(12)].map(worker))
const rows=[]
for(const n of nums){const b=out.get(n);if(!b)continue;const [bw,p]=b;const t=p.find(x=>x.schema==='network.xyo.time');const tx=p.some(x=>x.schema==='network.xyo.boundwitness'&&x.fees)||bw.payload_schemas.filter(s=>s==='network.xyo.boundwitness').length>0&&p.some(x=>x.schema==='network.xyo.boundwitness'&&x.from);
rows.push({n,hash:bw._hash,prev:bw.previous,prod:bw.addresses[0],epoch:t?.epoch,eth:t?.ethereum,xl1:t?.xl1,xl1Hash:t?.xl1Hash,tx})}
fs.writeFileSync(process.argv[3]||'chain.json',JSON.stringify(rows))
console.log('fetched',rows.length,'of',nums.length,'top',top)
