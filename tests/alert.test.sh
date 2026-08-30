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

OUT="$(A --status)"
has  "real conditions are detected"      "ineligible"   "${OUT}"
has  "version lag is detected"           "cli-behind"   "${OUT}"
has  "security updates are detected"     "os-security"  "${OUT}"

OUT="$(A)"
check "first run tracks all three"       "$(wc -l < "${WORK}/.alert-state")" "3"
OUT="$(A)"
hasnt "second run is silent"             "XL1 testnode" "${OUT}"

# The dashboard dying must not read as everything healing.
kill "${SRV}" 2>/dev/null; wait "${SRV}" 2>/dev/null; SRV=""
for _ in $(seq 1 20); do curl -fsS --max-time 1 -o /dev/null 2>/dev/null "http://127.0.0.1:${PORT}/status.json" || break; sleep 0.3; done
OUT="$(A)"
has   "outage itself is reported"        "did not answer" "${OUT}"
hasnt "no false recovery for ineligible" "recovered"      "${OUT}"
check "prior conditions preserved"       "$(grep -c . "${WORK}/.alert-state")" "4"

OUT="$(A --status)"
has  "--status admits it could not look" "COULD NOT READ STATUS" "${OUT}"

exit $(( FAILED > 0 ))
