// Observer self-watchdog: the real race-service.mjs as a child process, throwaway state, short thresholds.
// Fully offline: every child loads fake-xyo.mjs, an in-process stand-in for XYO's endpoints, and the
// harness refuses to start unless that is so. No traffic leaves the machine.
// Run: node tests/watchdog/watchdog.test.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url)), SERVICE = path.join(HERE, '..', '..', 'scripts', 'race', 'race-service.mjs')
const FAKE_FILE = path.join(HERE, 'fake-xyo.mjs'), FAKE = pathToFileURL(FAKE_FILE).href
if (!fs.existsSync(FAKE_FILE) || !/globalThis\.fetch\s*=/.test(fs.readFileSync(FAKE_FILE, 'utf8'))) { console.error('fake-xyo.mjs missing: refusing to run (the tests must never reach the network)'); process.exit(2) }
const FAST = { RACE_WATCHDOG_STALL_MS: '12000', RACE_WATCHDOG_CHECK_MS: '3000', RACE_WATCHDOG_CONFIRM: '2', RACE_WATCHDOG_WINDOW_MS: '600000', RACE_WATCHDOG_COOLDOWN_MS: '0', RACE_WATCHDOG_VERIFY_MS: '15000', RACE_WATCHDOG_MAX: '3' }
let port = 18190
// Runs the observer for up to `ms`; `atMs` optionally reads its /health (localhost only) while it runs.
function run(state, env, ms, atMs) {
  return new Promise((resolve) => {
    const myPort = port++
    const p = spawn(process.execPath, ['--import', FAKE, SERVICE], { env: { ...process.env, RACE_NETWORK: 'mainnet', RACE_STATE_DIR: state, RACE_PORT: String(myPort), RACE_BUILDLOGS: 'none', RACE_GUARD_URL: '', RACE_POOL_MS: '750', ...FAST, ...env }, stdio: 'ignore' })
    let health = null
    if (atMs) setTimeout(async () => { try { health = await (await fetch(`http://127.0.0.1:${myPort}/health`)).json() } catch {} }, atMs)
    const t = setTimeout(() => { p.kill(); resolve({ code: 'still-running', health }) }, ms)
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, health }) })
  })
}
const wdState = (s) => { try { return JSON.parse(fs.readFileSync(path.join(s, 'watchdog.json'), 'utf8')) } catch { return {} } }
const diags = (s) => { try { return fs.readdirSync(path.join(s, 'watchdog-diag')) } catch { return [] } }
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `wd-${n}-`))
const latchedState = (s) => fs.writeFileSync(path.join(s, 'watchdog.json'), JSON.stringify({ exits: [], history: [], status: 'recovery-failed' }))
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`) }
const iters = (w) => JSON.stringify(Object.fromEntries(Object.entries(w.loops ?? {}).map(([k, v]) => [k, v.iterations])))
const kinds = (w) => (w.history ?? []).map((h) => h.kind).join(',') || 'none'
let r, w

// 0. the fake is really in place: a healthy run must see the fake's candidates (block heights >= 1,000,000)
const s0 = tmp('offline'); r = await run(s0, {}, 12000)
const ev = (() => { try { return fs.readFileSync(path.join(s0, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } })()
const offline = ev.length > 0 && ev.filter((e) => e.k === 'cand').every((e) => e.block >= 1_000_000 && e.block < 1_100_000)
check('runs offline against the fake network', offline, `${ev.length} events, candidate blocks ${[...new Set(ev.filter((e) => e.k === 'cand').map((e) => e.block))].slice(0, 3).join(',')}…`)
if (!offline) { console.error('not offline: stopping before any further run'); process.exit(2) }

// 1. frozen candidate loop -> diagnostics, exit 75 (the supervisor restarts), state recorded
const s1 = tmp('pool'); r = await run(s1, { RACE_TEST_FREEZE: 'pool' }, 60000); w = wdState(s1)
check('frozen candidate loop recovers by exiting', r.code === 75 && diags(s1).length === 1 && w.exits?.length === 1 && w.history?.at(-1)?.kind === 'recovery-exit', `exit ${r.code}, diag ${diags(s1).length}, history ${kinds(w)}`)
// 2. the next process verifies the outcome
r = await run(s1, {}, 30000); w = wdState(s1)
check('next process verifies the recovery', w.lastResult === 'recovered' && !w.pendingVerify && r.code === 'still-running', `lastResult ${w.lastResult}, ${r.code}`)
// 3. frozen block-reading loop
const s2 = tmp('head'); r = await run(s2, { RACE_TEST_FREEZE: 'head' }, 60000)
check('frozen head loop recovers by exiting', r.code === 75 && (wdState(s2).history?.at(-1)?.loops ?? []).includes('head'), `exit ${r.code}, loops ${wdState(s2).history?.at(-1)?.loops}`)
// 4. repeated failure: at most 3 exits per window, then the latch, and it stays up
const s3 = tmp('limit'); const codes = []
for (let i = 0; i < 3; i++) codes.push((await run(s3, { RACE_TEST_FREEZE: 'pool' }, 60000)).code)
r = await run(s3, { RACE_TEST_FREEZE: 'pool' }, 45000); w = wdState(s3)
check('restart limit latches (no loop)', codes.every((c) => c === 75) && r.code === 'still-running' && w.status === 'recovery-failed' && w.latched === true && (w.history ?? []).some((h) => h.kind === 'limit-reached'), `first three ${codes}, fourth ${r.code}, status ${w.status}, latched ${w.latched}`)
// 5. cooldown survives a restart of the watchdog
const s4 = tmp('cool'); await run(s4, { RACE_TEST_FREEZE: 'pool' }, 60000)
r = await run(s4, { RACE_TEST_FREEZE: 'pool', RACE_WATCHDOG_COOLDOWN_MS: '300000' }, 45000); w = wdState(s4)
check('cooldown persists across restarts', r.code === 'still-running' && w.status === 'cooldown' && w.exits?.length === 1, `${r.code}, status ${w.status}, exits ${w.exits?.length}`)
// 6. upstream refusing connections + frozen loop: no restart (a restart cannot fix the upstream)
const s5 = tmp('down'); r = await run(s5, { RACE_TEST_FREEZE: 'pool', FAKE_XYO: 'down' }, 45000); w = wdState(s5)
check('upstream outage does not trigger restarts', r.code === 'still-running' && w.status === 'upstream-unavailable' && !(w.exits?.length), `${r.code}, status ${w.status}`)
// 7. DNS failing on every request, loops not frozen: they keep iterating, so no stall and no restart
const s6 = tmp('dns'); r = await run(s6, { FAKE_XYO: 'dns-fail' }, 45000); w = wdState(s6)
check('DNS failures are not a stall', r.code === 'still-running' && w.status === 'monitoring' && !(w.exits?.length) && Object.values(w.loops ?? {}).every((l) => l.iterations > 5), `${r.code}, status ${w.status}, iterations ${iters(w)}`)
// 8. a DNS outage with a frozen loop: the probe fails fast and blocks the restart
const s7 = tmp('dnsfrozen'); r = await run(s7, { RACE_TEST_FREEZE: 'pool', FAKE_XYO: 'dns-fail' }, 45000); w = wdState(s7)
check('a DNS outage blocks the restart', r.code === 'still-running' && w.status === 'upstream-unavailable' && !(w.exits?.length), `${r.code}, status ${w.status}`)
// 9. this process's network wedged (every request hangs): the loops stall, the probe times out, and it recovers
const s8 = tmp('hang'); r = await run(s8, { FAKE_XYO: 'hang', RACE_WATCHDOG_PROBE_MS: '2000' }, 60000); w = wdState(s8)
check('a wedged network (probe timeout) still recovers', r.code === 75 && w.history?.at(-1)?.kind === 'recovery-exit' && w.history.at(-1).probe?.timedOut === true, `exit ${r.code}, probe ${JSON.stringify(w.history?.at(-1)?.probe)}`)
// 10. healthy collection: no restart
const s9 = tmp('ok'); r = await run(s9, {}, 40000); w = wdState(s9)
check('healthy collection is left alone', r.code === 'still-running' && w.status === 'monitoring' && !(w.exits?.length), `${r.code}, status ${w.status}, iterations ${iters(w)}`)
// 11. passive mode: detects, never exits
const s10 = tmp('passive'); r = await run(s10, { RACE_TEST_FREEZE: 'pool', RACE_WATCHDOG: 'passive' }, 45000); w = wdState(s10)
check('passive mode detects without restarting', r.code === 'still-running' && w.status === 'stalled-passive', `${r.code}, status ${w.status}`)
// 12. env off: no checks at all, and it reports off even if a mode file says recover
const s11 = tmp('off'); fs.writeFileSync(path.join(s11, 'watchdog.mode'), 'recover')
r = await run(s11, { RACE_TEST_FREEZE: 'pool', RACE_WATCHDOG: 'off' }, 30000, 20000)
check('env off is a hard off, and is reported as off', r.code === 'still-running' && !fs.existsSync(path.join(s11, 'watchdog.json')) && r.health?.watchdog?.mode === 'off', `${r.code}, published mode ${r.health?.watchdog?.mode}`)
// 13. the mode file switches passive -> recover live, without a restart
const s12 = tmp('modefile'); fs.writeFileSync(path.join(s12, 'watchdog.mode'), 'passive')
const p13 = run(s12, { RACE_TEST_FREEZE: 'pool' }, 70000)
await new Promise((x) => setTimeout(x, 30000)); const before = wdState(s12).status
fs.writeFileSync(path.join(s12, 'watchdog.mode'), 'recover'); r = await p13; w = wdState(s12)
check('mode file switches passive to recover without a restart', before === 'stalled-passive' && r.code === 75 && w.history?.at(-1)?.kind === 'recovery-exit', `before ${before}, then exit ${r.code}`)
// 14. mode file 'off' is an instant manual disable
const s13 = tmp('modeoff'); fs.writeFileSync(path.join(s13, 'watchdog.mode'), 'off'); r = await run(s13, { RACE_TEST_FREEZE: 'pool' }, 35000); w = wdState(s13)
check("mode file 'off' disables recovery", r.code === 'still-running' && w.status === 'off', `${r.code}, status ${w.status}`)
// 15. the latch holds while frozen, even with an empty window
const s14 = tmp('latch'); latchedState(s14); r = await run(s14, { RACE_TEST_FREEZE: 'pool' }, 40000); w = wdState(s14)
check('the latch holds while a loop is frozen', r.code === 'still-running' && w.status === 'recovery-failed' && !(w.exits?.length), `${r.code}, status ${w.status}`)
// 16. the latch clears only after every loop has kept iterating for the verify period
const s15 = tmp('clear'); latchedState(s15); r = await run(s15, {}, 35000); w = wdState(s15)
const cleared = (w.history ?? []).find((h) => h.kind === 'recovery-failed-cleared')
check('the latch clears after sustained health', r.code === 'still-running' && w.status === 'monitoring' && w.latched === false && cleared?.healthyForS >= 15, `${r.code}, status ${w.status}, healthy for ${cleared?.healthyForS} s`)
// 17. (review M1) a loop that freezes AFTER startup must not clear the latch: one healthy check is not enough
const s16 = tmp('m1'); latchedState(s16); r = await run(s16, { RACE_TEST_FREEZE: 'pool', RACE_POOL_MS: '1500' }, 45000); w = wdState(s16)
check('a loop freezing after startup does not clear the latch', r.code === 'still-running' && w.status === 'recovery-failed' && w.latched === true && !kinds(w).includes('cleared'), `${r.code}, status ${w.status}, history ${kinds(w)}`)
// 18. switching to off and back does not clear the latch
const s17 = tmp('latchmode'); latchedState(s17); fs.writeFileSync(path.join(s17, 'watchdog.mode'), 'off')
const p18 = run(s17, { RACE_TEST_FREEZE: 'pool' }, 40000)
await new Promise((x) => setTimeout(x, 12000)); fs.writeFileSync(path.join(s17, 'watchdog.mode'), 'recover'); r = await p18; w = wdState(s17)
check('mode off and back does not clear the latch', r.code === 'still-running' && w.status === 'recovery-failed' && w.latched === true, `${r.code}, status ${w.status}`)
// 19. empty, zero or non-numeric settings fall back to the defaults (no stall-everything, no tight loop)
const s18 = tmp('settings'); r = await run(s18, { RACE_WATCHDOG_CHECK_MS: 'abc', RACE_WATCHDOG_STALL_MS: '', RACE_WATCHDOG_WINDOW_MS: '0', RACE_WATCHDOG_PROBE_MS: '0', RACE_WATCHDOG_MAX: '0' }, 20000)
check('empty, zero or invalid settings use the defaults', r.code === 'still-running' && !fs.existsSync(path.join(s18, 'watchdog.json')), `${r.code}, state written ${fs.existsSync(path.join(s18, 'watchdog.json'))} (first check at the 60 s default)`)
// 20. a state file that is valid JSON but not an object does not crash startup
const s19 = tmp('badstate'); fs.writeFileSync(path.join(s19, 'watchdog.json'), 'null'); r = await run(s19, { RACE_WATCHDOG_CHECK_MS: '3000' }, 15000); w = wdState(s19)
check('malformed state does not crash it', r.code === 'still-running' && w.status === 'monitoring', `${r.code}, status ${w.status}`)
// 21. it can only ever stop itself: no process-control code in the watchdog section (comments stripped, any line ending)
const src = fs.readFileSync(SERVICE, 'utf8'), section = src.slice(src.indexOf('// ---- self-watchdog'), src.indexOf('const until ='))
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
const forbidden = ['execFile', 'spawn', 'exec(', '.kill(', 'docker', 'pm2 ', 'systemctl', 'taskkill', 'Stop-Process', 'process.kill']
const found = forbidden.filter((f) => section.includes(f)), exits = (section.match(/process\.exit\(/g) ?? []).length
check('watchdog cannot target another process', found.length === 0 && exits === 1, `forbidden found: ${found.join(',') || 'none'}; process.exit calls: ${exits}`)

const failed = results.filter((x) => !x.ok).length
console.log(`\n${results.length - failed}/${results.length} watchdog cases passed (offline: no network traffic)`); process.exit(failed ? 1 : 0)
