#!/usr/bin/env bash
# xl1-collect.sh against a stubbed Docker. Asserts the behaviours that have
# actually broken: eligibility detection, cache invalidation on a schema change,
# and refusing to publish a snapshot when the container vanishes mid-cycle.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECT="${HERE}/../scripts/xl1-collect.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/bin" "${WORK}/state"
FAILED=0
check() { if [[ "$2" == "$3" ]]; then printf '    ok   %s\n' "$1"; else printf '    FAIL %s\n         want: %s\n         got:  %s\n' "$1" "$3" "$2"; FAILED=$((FAILED+1)); fi; }

mkdocker() { # $1 image id, $2 version, $3 log line
cat > "${WORK}/bin/docker" <<INNER
#!/usr/bin/env bash
case "\$1" in
  inspect) [[ "\$*" == *--format* ]] && echo "running true 2026-01-01T00:00:00Z 0 xl1:local healthy sha256:$1"; exit 0 ;;
  logs) echo "$3"; exit 0 ;;
  exec) echo "xl1 $2"; exit 0 ;;
esac
exit 0
INNER
chmod +x "${WORK}/bin/docker"; }

run() { PATH="${WORK}/bin:${PATH}" XL1_STATE_DIR="${WORK}/state" bash "${COLLECT}" >/dev/null 2>&1; }
field() { python3 -c "import json,sys;d=json.load(open('${WORK}/state/producer-status.json'));print(json.dumps(d$1))" 2>/dev/null; }

mkdocker aaa 5.3.0 "[xl1-producer] Producer has insufficient stake."
run
check "eligibility key detected"      "$(field "['eligibility']['key']")"  '"insufficient-stake"'
check "cli version read"              "$(field "['cliVersion']")"          '"5.3.0"'
EXPECT_SCHEMA="$(grep -m1 -oE '^CACHE_SCHEMA=[0-9]+' "${COLLECT}" | cut -d= -f2)"
check "schema stamp written"          "$(cat "${WORK}/state/.cache-schema")" "${EXPECT_SCHEMA}"

# A version can only change when the image does; the cache must not outlive it.
mkdocker bbb 5.4.0 "[xl1-producer] all good"
run
check "new image invalidates version" "$(field "['cliVersion']")"          '"5.4.0"'

# An old-format cache used to leave a field empty, produce invalid JSON, and
# freeze the snapshot for up to six hours.
printf '3 0 1.2\n' > "${WORK}/state/.os-updates"
printf 'reason-only\n' > "${WORK}/state/.eligibility"
rm -f "${WORK}/state/.cache-schema"
run
check "stale cache self-invalidates"  "$(field "['os']['updates'] is not None")" "true"

# docker logs failing must not cache "no complaint" — the whole point of the
# signal is that a blocked producer looks healthy from outside.
cat > "${WORK}/bin/docker" <<'INNER'
#!/usr/bin/env bash
case "$1" in
  inspect) [[ "$*" == *--format* ]] && echo "running true 2026-01-01T00:00:00Z 0 xl1:local healthy sha256:ccc"; exit 0 ;;
  logs) exit 1 ;;
  exec) echo "xl1 5.4.0"; exit 0 ;;
esac
exit 0
INNER
chmod +x "${WORK}/bin/docker"
rm -f "${WORK}/state/.eligibility"
printf '[xl1-producer] Producer has insufficient stake.\n' > /dev/null
run
check "failed log read is not cached"  "$([[ -f "${WORK}/state/.eligibility" ]] && echo present || echo absent)" "absent"

# A publish must record which block, not merely that one happened.
mkdocker ddd 5.4.0 "[BlockRunner] published block 575735 ok"
rm -f "${WORK}/state/.collect-cursor" "${WORK}/state/.last-published"
run
check "last published block captured" "$(field "['lastPublishedBlock']")" "575735"
check "publish timestamp captured"    "$([[ -n "$(field "['lastPublishedAt']")" ]] && echo yes || echo no)" "yes"

# The real line carries a hash after the height, and reading the last digit run
# off it produced a slice of the hash. When that slice began with a zero the
# height was emitted as 0540 — digits, but not a JSON number. jq 1.7 accepts it,
# so validation passed and the dashboard's JSON.parse took the Producer panel
# down instead. `field` parses strictly, so an invalid snapshot fails here too.
mkdocker eee 5.4.0 "[xl1-producer] Published block: 579361 [0xdeadbeef0540]"
rm -f "${WORK}/state/.collect-cursor" "${WORK}/state/.last-published"
run
check "height read past the hash"     "$(field "['lastPublishedBlock']")" "579361"

# The container disappearing mid-cycle must produce a valid document, not commas.
cat > "${WORK}/bin/docker" <<'INNER'
#!/usr/bin/env bash
[[ "$1" == "inspect" ]] && exit 1
exit 0
INNER
chmod +x "${WORK}/bin/docker"
run
check "vanished container stays valid JSON" "$(field "['container']")" "null"

exit $(( FAILED > 0 ))
