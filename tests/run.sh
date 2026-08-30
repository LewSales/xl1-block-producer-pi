#!/usr/bin/env bash
# Run every check in this repo. Same entry point locally and in CI.
#
#   ./tests/run.sh
#
# The SDK is stubbed when it is not installed: server.mjs imports it at load
# time, but none of the decisions under test touch it, and requiring a 100 MB
# install to test a version comparison makes a suite people skip.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"

GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
FAILED=0
step() { printf '\n%s==>%s %s%s%s\n' "${BOLD}" "${RESET}" "${BOLD}" "$*" "${RESET}"; }
ok()   { printf '  %s✓%s %s\n' "${GREEN}" "${RESET}" "$*"; }
bad()  { printf '  %s✗%s %s\n' "${RED}" "${RESET}" "$*"; FAILED=$((FAILED+1)); }

SHELL_SCRIPTS=(
  "${ROOT}/provision.sh" "${ROOT}/preflight.sh" "${ROOT}/build-images.sh"
  "${ROOT}/scripts/xl1-collect.sh" "${ROOT}/scripts/xl1-alert.sh"
  "${ROOT}/scripts/xl1ctl" "${ROOT}/scripts/xl1-screen-setup.sh" "${ROOT}/scripts/xl1-screen"
)

step "Shell syntax"
for f in "${SHELL_SCRIPTS[@]}"; do
  if bash -n "$f" 2>/dev/null; then ok "$(basename "$f")"; else bad "$(basename "$f") — syntax error"; fi
done

step "Shellcheck"
if command -v shellcheck >/dev/null; then
  if shellcheck --severity=error "${SHELL_SCRIPTS[@]}"; then ok "no errors"; else bad "shellcheck reported errors"; fi
  shellcheck --severity=warning "${SHELL_SCRIPTS[@]}" 2>/dev/null | head -20 || true
else
  printf '  %sshellcheck not installed; skipped%s\n' "${DIM}" "${RESET}"
fi

step "JavaScript syntax"
for f in "${ROOT}/dashboard/server.mjs" "${HERE}/dashboard.test.mjs"; do
  if node --check "$f" 2>/dev/null; then ok "$(basename "$f")"; else bad "$(basename "$f") — syntax error"; fi
done
if node -e "const h=require('fs').readFileSync('${ROOT}/dashboard/index.html','utf8'); new Function(h.match(/<script>([\s\S]*)<\/script>/)[1])" 2>/dev/null; then
  ok "index.html inline script parses"
else
  bad "index.html inline script does not parse"
fi

step "Dashboard behaviour"
SDK="${ROOT}/dashboard/node_modules/@xyo-network/xl1-sdk"
STUBBED=0
if [[ ! -d "${SDK}" ]]; then
  mkdir -p "${SDK}"
  cp "${HERE}/stubs/xl1-sdk-stub.mjs" "${SDK}/index.mjs"
  printf '{"name":"@xyo-network/xl1-sdk","version":"0.0.0-stub","type":"module","main":"index.mjs","exports":"./index.mjs"}\n' > "${SDK}/package.json"
  STUBBED=1
  printf '  %susing a stubbed SDK (real one not installed)%s\n' "${DIM}" "${RESET}"
fi
if node --test "${HERE}/dashboard.test.mjs"; then ok "dashboard tests passed"; else bad "dashboard tests failed"; fi
(( STUBBED )) && rm -rf "${ROOT}/dashboard/node_modules"

step "Collector behaviour"
if bash "${HERE}/collect.test.sh"; then ok "collector tests passed"; else bad "collector tests failed"; fi

step "Alerter behaviour"
if bash "${HERE}/alert.test.sh"; then ok "alerter tests passed"; else bad "alerter tests failed"; fi

printf '\n'
if (( FAILED )); then
  printf '%s✗ %d check(s) failed%s\n\n' "${RED}" "${FAILED}" "${RESET}"
  exit 1
fi
printf '%s✓ everything passed%s\n\n' "${GREEN}" "${RESET}"
