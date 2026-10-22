// Observer self-watchdog: the real race-service.mjs as a child process, throwaway state, short thresholds.
// Needs network (it talks to XYO's public endpoints like the observer does). Run: node tests/watchdog/watchdog.test.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url)), SERVICE = path.join(HERE, '..', '..', 'scripts', 'race', 'race-service.mjs')
const FAST = { RACE_WATCHDOG_STALL_MS: '12000', RACE_WATCHDOG_CHECK_MS: '3000', RACE_WATCHDOG_CONFIRM: '2', RACE_WATCHDOG_WINDOW_MS: '600000', RACE_WATCHDOG_COOLDOWN_MS: '0', RACE_WATCHDOG_VERIFY_MS: '15000', RACE_WATCHDOG_MAX: '3' }
let port = 18190
function run(state, env, ms, preload) {
  return new Promise((resolve) => {
    const args = [...(preload ? ['--import', pathToFileURL(preload).href] : []), SERVICE]
    const p = spawn(process.execPath, args, { env: { ...process.env, RACE_NETWORK: 'mainnet', RACE_STATE_DIR: state, RACE_PORT: String(port++), RACE_BUILDLOGS: 'none', RACE_GUARD_URL: '', RACE_POOL_MS: '750', ...FAST, ...env }, stdio: 'ignore' })
    const t = setTimeout(() => { p.kill(); resolve({ code: 'still-running' }) }, ms)
    p.on('exit', (code) => { clearTimeout(t); resolve({ code }) })
  })
}
const wdState = (s) => { try { return JSON.parse(fs.readFileSync(path.join(s, 'watchdog.json'), 'utf8')) } catch { return {} } }
const diags = (s) => { try { return fs.readdirSync(path.join(s, 'watchdog-diag')) } catch { return [] } }
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `wd-${n}-`))
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`) }
const iters = (w) => JSON.stringify(Object.fromEntries(Object.entries(w.loops ?? {}).map(([k, v]) => [k, v.iterations])))

// 1. frozen candidate loop -> diagnostics, exit 75 (the supervisor restarts), state recorded
const s1 = tmp('pool'); let r = await run(s1, { RACE_TEST_FREEZE: 'pool' }, 60000); let w = wdState(s1)
check('frozen candidate loop recovers by exiting', r.code === 75 && diags(s1).length === 1 && w.exits?.length === 1 && w.history?.at(-1)?.kind === 'recovery-exit', `exit ${r.code}, diag ${diags(s1).length}, history ${w.history?.map((h) => h.kind)}`)
// 2. the next process verifies the outcome
r = await run(s1, {}, 30000); w = wdState(s1)
check('next process verifies the recovery', w.lastResult === 'recovered' && !w.pendingVerify && r.code === 'still-running', `lastResult ${w.lastResult}, ${r.code}`)
// 3. frozen block-reading loop
const s2 = tmp('head'); r = await run(s2, { RACE_TEST_FREEZE: 'head' }, 60000)
check('frozen head loop recovers by exiting', r.code === 75 && (wdState(s2).history?.at(-1)?.loops ?? []).includes('head'), `exit ${r.code}, loops ${wdState(s2).history?.at(-1)?.loops}`)
// 4. repeated failure: at most 3 exits per window, then recovery-failed and it stays up
const s3 = tmp('limit'); const codes = []
for (let i = 0; i < 3; i++) codes.push((await run(s3, { RACE_TEST_FREEZE: 'pool' }, 60000)).code)
r = await run(s3, { RACE_TEST_FREEZE: 'pool' }, 45000); w = wdState(s3)
check('restart limit stops recovery (no loop)', codes.every((c) => c === 75) && r.code === 'still-running' && w.status === 'recovery-failed' && (w.history ?? []).some((h) => h.kind === 'limit-reached'), `first three ${codes}, fourth ${r.code}, status ${w.status}`)
// 5. cooldown survives a restart of the watchdog
const s4 = tmp('cool'); await run(s4, { RACE_TEST_FREEZE: 'pool' }, 60000)
r = await run(s4, { RACE_TEST_FREEZE: 'pool', RACE_WATCHDOG_COOLDOWN_MS: '300000' }, 45000); w = wdState(s4)
check('cooldown persists across restarts', r.code === 'still-running' && w.status === 'cooldown' && w.exits?.length === 1, `${r.code}, status ${w.status}, exits ${w.exits?.length}`)
// 6. upstream outage + frozen loop: no restart (a restart cannot fix the upstream)
const s5 = tmp('up'); r = await run(s5, { RACE_TEST_FREEZE: 'pool', RACE_TEST_UPSTREAM_DOWN: '1' }, 45000); w = wdState(s5)
check('upstream outage does not trigger restarts', r.code === 'still-running' && w.status === 'upstream-unavailable' && !(w.exits?.length), `${r.code}, status ${w.status}`)
// 7. DNS failure on every request, loops not frozen: they keep iterating, so no stall and no restart
const s6 = tmp('dns'); r = await run(s6, {}, 45000, path.join(HERE, 'fetch-dns-fail.mjs')); w = wdState(s6)
check('DNS failures are not a stall', r.code === 'still-running' && w.status === 'monitoring' && !(w.exits?.length) && Object.values(w.loops ?? {}).every((l) => l.iterations > 5), `${r.code}, status ${w.status}, iterations ${iters(w)}`)
// 8. healthy collection (quiet or busy mempool): no restart
const s7 = tmp('ok'); r = await run(s7, {}, 40000); w = wdState(s7)
check('healthy collection is left alone', r.code === 'still-running' && w.status === 'monitoring' && !(w.exits?.length), `${r.code}, status ${w.status}, iterations ${iters(w)}`)
// 9. passive mode: detects, never exits
const s8 = tmp('passive'); r = await run(s8, { RACE_TEST_FREEZE: 'pool', RACE_WATCHDOG: 'passive' }, 45000); w = wdState(s8)
check('passive mode detects without restarting', r.code === 'still-running' && w.status === 'stalled-passive', `${r.code}, status ${w.status}`)
// 10. off: no checks at all
const s9 = tmp('off'); r = await run(s9, { RACE_TEST_FREEZE: 'pool', RACE_WATCHDOG: 'off' }, 35000)
check('RACE_WATCHDOG=off disables it', r.code === 'still-running' && !fs.existsSync(path.join(s9, 'watchdog.json')), `${r.code}`)
// 12. the mode file switches passive -> recover live, without a restart
const s10 = tmp('modefile'); fs.writeFileSync(path.join(s10, 'watchdog.mode'), 'passive')
const p12 = run(s10, { RACE_TEST_FREEZE: 'pool' }, 70000)
await new Promise((x) => setTimeout(x, 30000)); const before = wdState(s10).status
fs.writeFileSync(path.join(s10, 'watchdog.mode'), 'recover'); r = await p12; w = wdState(s10)
check('mode file switches passive to recover without a restart', before === 'stalled-passive' && r.code === 75 && w.history?.at(-1)?.kind === 'recovery-exit', `before ${before}, then exit ${r.code}`)
// 13. mode file 'off' is an instant manual disable
const s11 = tmp('modeoff'); fs.writeFileSync(path.join(s11, 'watchdog.mode'), 'off'); r = await run(s11, { RACE_TEST_FREEZE: 'pool' }, 35000); w = wdState(s11)
check("mode file 'off' disables recovery", r.code === 'still-running' && w.status === 'off', `${r.code}, status ${w.status}`)
// 11. it can only ever stop itself: no process-control code in the watchdog section (fails closed by construction)
const src = fs.readFileSync(SERVICE, 'utf8'), section = src.slice(src.indexOf('// ---- self-watchdog'), src.indexOf('const until ='))
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')   // code only: the comments name what it must NOT do
const forbidden = ['execFile', 'spawn', 'exec(', '.kill(', 'docker', 'pm2 ', 'systemctl', 'taskkill', 'Stop-Process', 'process.kill']
const found = forbidden.filter((f) => section.includes(f)), exits = (section.match(/process\.exit\(/g) ?? []).length
check('watchdog cannot target another process', found.length === 0 && exits === 1, `forbidden found: ${found.join(',') || 'none'}; process.exit calls: ${exits}`)

const failed = results.filter((x) => !x.ok).length
console.log(`\n${results.length - failed}/${results.length} watchdog cases passed`); process.exit(failed ? 1 : 0)
