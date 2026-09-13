#!/usr/bin/env bash
# xl1-screen reads the dashboard through one long jq program, and jq abandons
# the REST OF THE PROGRAM on the first hard error. That makes a single stale
# path silent and wide: when the payload dropped its {t,v} trend objects for
# plain numbers, `.history.height[]?.v` began erroring, and every field declared
# below it -- both sparklines and the entire standings page -- came back empty.
# Nothing crashed. The panel just quietly stopped showing half of itself.
#
# So this asserts on the LAST variable the program declares. If any line above
# it throws, that variable is unset and this fails.
#
#   ./tests/screen.test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCREEN="${HERE}/../scripts/xl1-screen"
GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'
FAILED=0
ok()  { printf '  %s✓%s %s\n' "${GREEN}" "${RESET}" "$*"; }
bad() { printf '  %s✗%s %s\n' "${RED}" "${RESET}" "$*"; FAILED=$((FAILED+1)); }

if ! command -v jq >/dev/null 2>&1; then
  printf '  jq not installed; screen parsing not checked\n'
  exit 0
fi

# The filter, lifted from the script itself so the test cannot drift from it.
FILTER="$(mktemp)"; trap 'rm -f "${FILTER}"' EXIT
# Anchored on the eval block, not on "jq -r" -- page_peers runs its own jq
# earlier in the file, and matching that one extracts the wrong program.
sed -n '/eval "\$(printf/,/2>\/dev\/null)"/p' "${SCREEN}" \
  | sed -e "1s/.*jq -r '//" -e "\$s/' 2>\/dev\/null)\"//" > "${FILTER}"

# The last variable the program declares. Everything hangs off it: if any line
# above throws, jq stops and this never gets assigned.
ALL_VARS=($(grep -o '@sh "[A-Z0-9_]*=' "${FILTER}" | sed 's/@sh "//; s/=//'))
LAST_VAR="${ALL_VARS[-1]:-}"
[[ -n "${LAST_VAR}" ]] || { bad "could not find the last field in the filter"; exit 1; }

# eval assigns into this shell, so a value from an earlier case survives into a
# later one. That is not academic: it made two of the checks below pass while
# the very bug they exist to catch was present, because they were reading the
# previous case's numbers. Wipe the slate before every eval.
reset_vars() { local v; for v in "${ALL_VARS[@]}"; do unset "${v}"; done; }

status() {  # status <history-json>
  cat <<JSON
{ "status": "ok", "problems": [],
  "chain": { "ok": true, "currentBlock": 100, "networkName": "sequence",
             "balances": { "reward": { "xl1": "1,000.0", "sinceStart": { "xl1": "5.0" } } } },
  "node": { "recentLog": ["x"], "eligibility": { "blocked": false }, "container": {}, "os": {} },
  "health": { "ok": true }, "system": { "throttle": null, "memory": {}, "swap": {}, "disk": {} },
  "release": {}, "derived": {}, "history": $1,
  "peers": { "producers": 8, "scannedBlocks": 2647, "selfRank": 5,
             "top": [ { "sharePercent": 23.5 }, { "sharePercent": 9.8 } ] },
  "network": { "observed": { "daysStored": 4, "blocks": 2647 },
               "blockTime": { "medianSeconds": 60, "p90Seconds": 300, "meanSeconds": 114,
                              "samples": 784, "buckets": [1,2,3] },
               "concentration": { "nakamoto": 3, "leaderShare": 23.5, "top3Share": 68.1,
                                  "evenShare": 12.5, "producers": 8 } },
  "price": { "value": 0.0035, "change24h": 1.7, "id": "xyo-network", "currency": "usd",
             "notional": 50.9, "marketNote": "test token" },
  "alerts": { "installed": true, "running": true, "active": [], "armed": { "deadman": true } } }
JSON
}

# Both trend shapes: the plain numbers the payload sends now, and the {t,v}
# objects it used to. A panel may be older or newer than the dashboard it reads.
check() {  # check <label> <history-json> <expect-heights>
  local label="$1" hist="$2" want="$3" out
  out="$(status "${hist}" | jq -r -f "${FILTER}" 2>&1)"
  if printf '%s' "${out}" | grep -q '^jq: error'; then
    bad "${label}: jq errored — $(printf '%s' "${out}" | grep '^jq: error' | head -1)"
    return
  fi
  reset_vars
  eval "$(printf '%s' "${out}")" 2>/dev/null
  if [[ -z "${!LAST_VAR:-}" ]]; then
    bad "${label}: ${LAST_VAR} is unset — something above it aborted the program"
    return
  fi
  [[ "${HHEIGHT:-}" == "${want}" ]] \
    && ok "${label}: trend read, and every field through ${LAST_VAR} survived" \
    || bad "${label}: HHEIGHT was '${HHEIGHT:-}', expected '${want}'"
}

check "plain numbers" '{ "height": [1,2,3], "tempC": [] }' "1 2 3"
check "{t,v} objects" '{ "height": [{"t":0,"v":1},{"t":1,"v":2},{"t":2,"v":3}], "tempC": [] }' "1 2 3"

# The standings page is downstream of the trend lines, and was the casualty
# nobody noticed. Name it, so a future break points at the symptom.
out="$(status '{ "height": [1,2,3], "tempC": [] }' | jq -r -f "${FILTER}" 2>/dev/null)"
reset_vars
eval "$(printf '%s' "${out}")" 2>/dev/null
[[ "${PEERN:-}" == "8" && "${PEERRANK:-}" == "5" ]] \
  && ok "the standings page still gets its numbers" \
  || bad "standings fields empty (PEERN='${PEERN:-}' PEERRANK='${PEERRANK:-}')"
[[ "${NAKA:-}" == "3" && -n "${PVAL:-}" && "${ALINST:-}" == "1" ]] \
  && ok "network, price and alerts reach the panel" \
  || bad "network/price/alerts empty (NAKA='${NAKA:-}' PVAL='${PVAL:-}' ALINST='${ALINST:-}')"

exit $(( FAILED > 0 ))
