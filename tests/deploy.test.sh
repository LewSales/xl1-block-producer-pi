#!/usr/bin/env bash
# deploy-dashboard.sh against stubbed ssh/scp. Asserts the rule that broke on
# 2026-10-11: no alert hold, no deploy -- and that a refused deploy copies nothing.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="${HERE}/../scripts/deploy-dashboard.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/bin"
FAILED=0
check() { if [[ "$2" == "$3" ]]; then printf '    ok   %s\n' "$1"; else printf '    FAIL %s\n         want: %s\n         got:  %s\n' "$1" "$3" "$2"; FAILED=$((FAILED+1)); fi; }

# The "Pi" is a directory; every remote command is logged, then run against it.
cat > "${WORK}/bin/ssh" <<'INNER'
#!/usr/bin/env bash
while [[ "$1" == -o ]]; do shift 2; done
shift # host
cmd="$*"
echo "ssh ${cmd}" >> "${STUB}/log"
case "${cmd}" in
  *"--hold "*)    [[ "${STUB_MODE}" == refuse ]] && exit 1; [[ "${STUB_MODE}" == noreadback ]] || touch "${STUB}/held"; exit 0 ;;
  *"--holds"*)    [[ -f "${STUB}/held" ]] && printf 'dashboard-unreachable\t9999999999\tdeploy\n' || echo "no active holds"; exit 0 ;;
  *"--release "*) rm -f "${STUB}/held"; exit 0 ;;
  *"docker stop"*) exit 0 ;;
  *"docker ps"*)  echo "Up 2 seconds"; exit 0 ;;
  *"api/status"*) printf '{"build":%s}' "$(cat "${STUB}/remote/build.json")"; exit 0 ;;
esac
eval "${cmd//\/srv\/xl1-dashboard/${STUB}/remote}"
INNER
cat > "${WORK}/bin/scp" <<'INNER'
#!/usr/bin/env bash
[[ "$1" == -q ]] && shift
echo "scp $1" >> "${STUB}/log"
cp "$1" "${STUB}/remote/$(basename "${2##*:}")"
INNER
chmod +x "${WORK}/bin/ssh" "${WORK}/bin/scp"

run() { # $1 mode, rest env
  local mode="$1"; shift
  rm -rf "${WORK}/s"; mkdir -p "${WORK}/s/remote"; : > "${WORK}/s/log"
  env PATH="${WORK}/bin:${PATH}" STUB="${WORK}/s" STUB_MODE="${mode}" "$@" bash "${DEPLOY}" pi@stub >/dev/null 2>&1
}
copies() { grep -c '^scp ' "${WORK}/s/log"; }
first() { grep -n -e "$1" "${WORK}/s/log" | head -1 | cut -d: -f1; }

run refuse;     check "hold refused: deploy exits non-zero"   "$?" 1
check "hold refused: nothing copied"                          "$(copies)" 0
check "hold refused: no restart"                              "$(grep -c 'docker stop' "${WORK}/s/log")" 0

run noreadback; check "hold not read back: deploy exits non-zero" "$?" 1
check "hold not read back: nothing copied"                    "$(copies)" 0

run ok;         check "hold set: deploy succeeds"             "$?" 0
check "hold set: three files copied"                          "$(copies)" 3
check "hold set before the first copy"                        "$(( $(first '--hold ') < $(first '^scp ') ))" 1
check "hold released after the deploy verified"               "$(( $(first '--release ') > $(first 'api/status') ))" 1
check "no hold left behind"                                   "$([[ -f "${WORK}/s/held" ]] && echo held || echo none)" none

run ok XL1_DEPLOY_NO_HOLD=1; check "explicit opt-out deploys" "$?" 0
check "explicit opt-out never touches holds"                  "$(grep -c -e '--hold' "${WORK}/s/log")" 0

exit $(( FAILED > 0 ))
