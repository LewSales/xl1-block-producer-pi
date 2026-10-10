#!/usr/bin/env bash
# xl1-alert.sh against a served fixture. The cases here are the ones that made
# the alerter lie: reporting nothing while three problems were live, and
# reporting recoveries for conditions it could not see.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALERT="${HERE}/../scripts/xl1-alert.sh"
WORK="$(mktemp -d)"; SRV=""
trap 'rm -rf "${WORK}"; [[ -n "${SRV}" ]] && kill "${SRV}" 2>/dev/null' EXIT
FAILED=0
check() { if [[ "$2" == "$3" ]]; then printf '    ok   %s\n' "$1"; else printf '    FAIL %s\n         want: %s\n         got:  %s\n' "$1" "$3" "$2"; FAILED=$((FAILED+1)); fi; }
has()   { if grep -q "$2" <<< "$3"; then printf '    ok   %s\n' "$1"; else printf '    FAIL %s (no /%s/ in output)\n' "$1" "$2"; FAILED=$((FAILED+1)); fi; }
hasnt() { if grep -q "$2" <<< "$3"; then printf '    FAIL %s (unexpected /%s/)\n' "$1" "$2"; FAILED=$((FAILED+1)); else printf '    ok   %s\n' "$1"; fi; }

command -v jq >/dev/null || { echo "    skipped: jq not installed"; exit 0; }

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"

cat > "${WORK}/status.json" <<'JSON'
{"status":"degraded",
 "problems":["producer ineligible: not on the allowed-producer list"],
 "health":{"ok":true},"chain":{"ok":true},
 "node":{"ok":true,"stale":false,"container":{"running":true},
         "eligibility":{"blocked":true,"key":"not-allowed","reason":"not on the allowed-producer list"},
         "eligibilityIgnored":false,"cliVersion":"5.2.2",
         "os":{"securityUpdates":30,"rebootRequired":false}},
 "release":{"ok":true,"latest":"5.3.0","installed":"5.2.2","lag":"behind"},
 "derived":{"blocksSinceLast":150,"secondsPerBlock":57},
 "system":{"throttle":{"undervoltageNow":false},"swap":{"usedPercent":0}}}
JSON
python3 -m http.server ${PORT} --bind 127.0.0.1 --directory "${WORK}" >/dev/null 2>&1 &
SRV=$!
for _ in $(seq 1 20); do curl -fsS --max-time 1 -o /dev/null 2>/dev/null "http://127.0.0.1:${PORT}/status.json" && break; sleep 0.3; done

cat > "${WORK}/alert.env" <<ENV
XL1_ALERT_URL=http://127.0.0.1:${PORT}/status.json
XL1_ALERT_STATE=${WORK}/.alert-state
XL1_ALERT_NAME=testnode
ENV
A() { XL1_ALERT_ENV="${WORK}/alert.env" bash "${ALERT}" "$@" 2>&1; }

# A launch that came up non-producing, served separately so the state-machine
# sequence below is not perturbed. --status only; it writes nothing.
mk2() {
cat > "${WORK}/status2.json" <<JSON
{"status":"ok","health":{"ok":true},"chain":{"ok":true},
 "node":{"ok":true,"stale":false,"container":{"running":true},
         "eligibility":{"blocked":false},"runSeconds":${1},"buildsThisRun":${2}},
 "release":{"ok":true},"derived":{"blocksSinceLast":0},
 "system":{"throttle":{"undervoltageNow":false},"swap":{"usedPercent":0}}}
JSON
cat > "${WORK}/alert2.env" <<ENV
XL1_ALERT_URL=http://127.0.0.1:${PORT}/status2.json
XL1_ALERT_STATE=${WORK}/.alert-state2
XL1_ALERT_NAME=testnode
ENV
XL1_ALERT_ENV="${WORK}/alert2.env" bash "${ALERT}" --status 2>&1; }

has   "a launch that never produced is caught"  "never-produced" "$(mk2 1800 0)"
hasnt "a producing launch is not accused"       "never-produced" "$(mk2 1800 4)"
hasnt "a young container is given its grace"    "never-produced" "$(mk2 60 0)"

# 2026-10-10: the node said "insufficient stake" about itself on Mainnet while
# landing a block every few minutes. The dashboard now serves that complaint as
# contradicted by the chain (eligibilityIgnored: true) -- this is the exact
# shape it serves, and the alerter must not page "cannot produce" on it.
cat > "${WORK}/status3.json" <<'JSON'
{"status":"ok","health":{"ok":true},"chain":{"ok":true},
 "node":{"ok":true,"stale":false,"container":{"running":true},
         "eligibility":{"blocked":true,"key":"insufficient-stake","reason":"insufficient stake"},
         "eligibilityIgnored":true,"eligibilityContradicted":true,
         "eligibilityNote":"the chain shows this node produced 11 blocks ago"},
 "release":{"ok":true},"derived":{"blocksSinceLast":11},
 "system":{"throttle":{"undervoltageNow":false},"swap":{"usedPercent":0}}}
JSON
cat > "${WORK}/alert3.env" <<ENV
XL1_ALERT_URL=http://127.0.0.1:${PORT}/status3.json
XL1_ALERT_STATE=${WORK}/.alert-state3
XL1_ALERT_NAME=testnode
ENV
OUT3="$(XL1_ALERT_ENV="${WORK}/alert3.env" bash "${ALERT}" --status 2>&1)"
hasnt "a complaint the chain contradicts does not page" "ineligible"    "${OUT3}"
hasnt "a producing node is not called stalled"          "not-producing" "${OUT3}"

OUT="$(A --status)"
has  "real conditions are detected"      "ineligible"   "${OUT}"
has  "version lag is detected"           "cli-behind"   "${OUT}"
has  "security updates are detected"     "os-security"  "${OUT}"
# A node that is up, healthy and winning nothing looked perfectly fine to every
# other predicate for two hours on 2026-08-31.
has  "a healthy node winning nothing is caught" "not-producing" "${OUT}"

OUT="$(A)"
check "first run tracks all four"        "$(wc -l < "${WORK}/.alert-state")" "4"
OUT="$(A)"
hasnt "second run is silent"             "XL1 testnode" "${OUT}"

# The dashboard dying must not read as everything healing.
kill "${SRV}" 2>/dev/null; wait "${SRV}" 2>/dev/null; SRV=""
for _ in $(seq 1 20); do curl -fsS --max-time 1 -o /dev/null 2>/dev/null "http://127.0.0.1:${PORT}/status.json" || break; sleep 0.3; done
OUT="$(A)"
has   "outage itself is reported"        "did not answer" "${OUT}"
hasnt "no false recovery for ineligible" "recovered"      "${OUT}"
check "prior conditions preserved"       "$(grep -c . "${WORK}/.alert-state")" "5"

OUT="$(A --status)"
has  "--status admits it could not look" "COULD NOT READ STATUS" "${OUT}"

exit $(( FAILED > 0 ))
