#!/usr/bin/env bash
# xl1-interval-trial against stubbed docker/systemctl and a scratch /etc/xl1. Asserts what
# must never go wrong in a live trial: only the interval changes, a failed switch undoes itself,
# and rollback puts back the exact original files.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIAL="${HERE}/../scripts/xl1-interval-trial"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
FAILED=0
check() { if [[ "$2" == "$3" ]]; then printf '    ok   %s\n' "$1"; else printf '    FAIL %s\n         want: %s\n         got:  %s\n' "$1" "$3" "$2"; FAILED=$((FAILED+1)); fi; }

setup() {
  rm -rf "${WORK}/etc" "${WORK}/state" "${WORK}/bin"; mkdir -p "${WORK}/etc/presets/roles" "${WORK}/state" "${WORK}/bin"
  cp "${HERE}/../presets/roles/producer.json" "${HERE}/../presets/roles/producer-rest.json" "${WORK}/etc/presets/roles/"
  : > "${WORK}/systemctl.log"
  # docker: the "container" loaded whatever producer-rest.json said at the last restart, and
  # reports it nested under "xl1" exactly as the entrypoint's generated config does
  # (or a frozen copy when STALE is set, to simulate a mount that did not update).
  cat > "${WORK}/bin/docker" <<INNER
#!/usr/bin/env bash
case "\$1" in
  inspect) [[ -f "${WORK}/unhealthy" ]] && echo "true unhealthy" || echo "true healthy" ;;
  exec) printf '{"xl1":'; cat "${WORK}/loaded.json"; printf '}' ;;  # shaped like /tmp/xl1-preset.xyo.config.json
esac
INNER
  cat > "${WORK}/bin/systemctl" <<INNER
#!/usr/bin/env bash
echo "\$*" >> "${WORK}/systemctl.log"
if [[ "\$1" == restart && ! -f "${WORK}/stale" ]]; then cp "${WORK}/etc/presets/roles/producer-rest.json" "${WORK}/loaded.json"; fi
exit 0
INNER
  chmod +x "${WORK}/bin/docker" "${WORK}/bin/systemctl"
  cp "${WORK}/etc/presets/roles/producer-rest.json" "${WORK}/loaded.json"
  rm -f "${WORK}/stale" "${WORK}/unhealthy"
}
trial() { PATH="${WORK}/bin:${PATH}" XL1_CONF_DIR="${WORK}/etc" XL1_STATE_DIR="${WORK}/state" XL1_TRIAL_NO_ROOT_CHECK=1 \
  XL1_TRIAL_HEALTH_DEADLINE=2 XL1_TRIAL_POLL=1 bash "${TRIAL}" "$@" >/dev/null 2>&1; }
interval() { python3 -c 'import json,sys;print([a for a in json.load(open(sys.argv[1]))["actors"] if a["name"]=="producer"][0]["blockProductionCheckInterval"])' "$1"; }
sans_interval() { python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
[a.pop("blockProductionCheckInterval",None) for a in d["actors"]]
print(json.dumps(d,sort_keys=True))' "$1"; }
R="${WORK}/etc/presets/roles"

setup
BEFORE_REST="$(sans_interval "${R}/producer-rest.json")"; BEFORE_RPC="$(sans_interval "${R}/producer.json")"
ORIG_SUM="$(cat "${R}"/producer.json "${R}"/producer-rest.json | cksum)"
trial set 3000; rc=$?
check "set 3000 succeeds"                        "${rc}" "0"
check "producer-rest now 3000"                   "$(interval "${R}/producer-rest.json")" "3000"
check "producer now 3000"                        "$(interval "${R}/producer.json")" "3000"
check "producer-rest bindings untouched"         "$(sans_interval "${R}/producer-rest.json")" "${BEFORE_REST}"
check "producer bindings untouched"              "$(sans_interval "${R}/producer.json")" "${BEFORE_RPC}"
check "exactly one restart"                      "$(grep -c '^restart' "${WORK}/systemctl.log")" "1"
check "switch verified in the log"               "$(grep -c 'live 3000 verified' "${WORK}/state/interval-trial/log.tsv")" "1"

trial set 5000; rc=$?
check "an off-menu interval is refused"          "${rc}" "1"
check "refusal restarts nothing"                 "$(grep -c '^restart' "${WORK}/systemctl.log")" "1"

trial rollback
check "rollback restores the exact bytes"        "$(cat "${R}"/producer.json "${R}"/producer-rest.json | cksum)" "${ORIG_SUM}"

# A mount that never picks up the change must not leave the node on an unverified config.
setup
touch "${WORK}/stale"
trial set 3000; rc=$?
check "unverified switch reports failure"        "${rc}" "1"
check "unverified switch restores originals"     "$(cat "${R}"/producer.json "${R}"/producer-rest.json | cksum)" "${ORIG_SUM}"
check "unverified switch stops the trial timer"  "$(grep -c '^disable --now' "${WORK}/systemctl.log")" "1"

# A preset that has grown something unexpected is not rewritten.
setup
python3 - "${R}/producer-rest.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); del d["actors"][0]["blockProductionCheckInterval"]; json.dump(d,open(p,"w"))
PY
trial set 3000; rc=$?
check "a preset without the key is refused"      "${rc}" "1"
check "and nothing was restarted"                "$(grep -c '^restart' "${WORK}/systemctl.log")" "0"

# Schedule: balanced arms, ABBA then BAAB.
setup
trial start 2 6
S="${WORK}/state/interval-trial/schedule"
check "two days of 6-hour blocks plus END"       "$(wc -l < "${S}" | tr -d ' ')" "9"
check "arm sequence ABBA BAAB"                   "$(head -n 8 "${S}" | cut -f2 | tr '\n' ' ')" "3000 4000 4000 3000 4000 3000 3000 4000 "
check "arms balanced"                            "$(head -n 8 "${S}" | cut -f2 | sort | uniq -c | awk '{print $1}' | tr '\n' ' ')" "4 4 "

# tick: applies the scheduled arm once the block has begun.
setup
mkdir -p "${WORK}/state/interval-trial"
printf '%s\t3000\n%s\tEND\n' "2000-01-01T00:00:00Z" "2999-01-01T00:00:00Z" > "${WORK}/state/interval-trial/schedule"
trial tick
check "tick applies the scheduled arm"           "$(interval "${R}/producer-rest.json")" "3000"
trial tick
check "a second tick on the same arm is a no-op" "$(grep -c '^restart' "${WORK}/systemctl.log")" "1"

# tick: two unhealthy ticks in a row end the trial on the original config.
touch "${WORK}/unhealthy"
trial tick; trial tick
rm -f "${WORK}/unhealthy"
check "unhealthy twice rolls back"               "$(interval "${R}/producer-rest.json")" "4000"

# The floor holds even when someone overrides the arms.
check "arms below 3000 are refused"              "$(PATH="${WORK}/bin:${PATH}" XL1_TRIAL_ARMS="1000 4000" bash "${TRIAL}" status >/dev/null 2>&1; echo $?)" "1"

# tick past the end restores the originals.
setup
mkdir -p "${WORK}/state/interval-trial"
trial set 3000
printf '%s\t3000\n%s\tEND\n' "2000-01-01T00:00:00Z" "2000-01-02T00:00:00Z" > "${WORK}/state/interval-trial/schedule"
trial tick
check "finished schedule restores originals"     "$(cat "${R}"/producer.json "${R}"/producer-rest.json | cksum)" "${ORIG_SUM}"

exit $(( FAILED > 0 ))
