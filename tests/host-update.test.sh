#!/usr/bin/env bash
# xl1-host-update.sh's argument handling, against a stubbed apt. The case that
# matters: an argument it does not know must stop it before apt runs, because
# the fall-through is a full upgrade and, in auto mode, a reboot that restarts
# the producer.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../scripts/xl1-host-update.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/bin" "${WORK}/state"
FAILED=0
check() { if [[ "$2" == "$3" ]]; then printf '    ok   %s\n' "$1"; else printf '    FAIL %s\n         want: %s\n         got:  %s\n' "$1" "$3" "$2"; FAILED=$((FAILED+1)); fi; }

# apt-get and apt record every call; one runtime package is upgradable.
cat > "${WORK}/bin/apt-get" <<STUB
#!/usr/bin/env bash
echo "apt-get \$*" >> "${WORK}/calls"; exit 0
STUB
cat > "${WORK}/bin/apt" <<'STUB'
#!/usr/bin/env bash
echo "containerd.io/stable 2.0 arm64 [upgradable from: 1.9]"
STUB
chmod +x "${WORK}/bin/apt-get" "${WORK}/bin/apt"
run() { : > "${WORK}/calls"; PATH="${WORK}/bin:${PATH}" XL1_STATE_DIR="${WORK}/state" XL1_HOST_UPDATE_LOG="${WORK}/apt.log" XL1_HOST_UPDATE_REBOOT=notify \
  XL1_REBOOT_REQUIRED_FILE="${WORK}/no-reboot" bash "${SCRIPT}" "$@" >/dev/null 2>&1; echo $?; }

check "an unknown argument exits 2"            "$(run --runtme)" "2"
check "and runs nothing"                       "$(wc -l < "${WORK}/calls" | tr -d ' ')" "0"
check "an unknown second argument exits 2"     "$(run --check --bogus)" "2"
check "--runtime --check exits 0"              "$(run --runtime --check)" "0"
check "and upgrades nothing"                   "$(grep -c 'install' "${WORK}/calls")" "0"
check "--check --runtime, either order"        "$(run --check --runtime; grep -c 'install' "${WORK}/calls")" "$(printf '0\n0')"
check "--runtime alone upgrades the runtime"   "$(run --runtime; grep -c 'install --only-upgrade -y .* containerd.io' "${WORK}/calls")" "$(printf '0\n1')"
exit $(( FAILED > 0 ))
