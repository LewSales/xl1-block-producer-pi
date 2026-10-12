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
XL1_ALERT_FRESH_FILES=
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
XL1_ALERT_FRESH_FILES=
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
XL1_ALERT_FRESH_FILES=
ENV
OUT3="$(XL1_ALERT_ENV="${WORK}/alert3.env" bash "${ALERT}" --status 2>&1)"
hasnt "a complaint the chain contradicts does not page" "ineligible"    "${OUT3}"
hasnt "a producing node is not called stalled"          "not-producing" "${OUT3}"

# The other two shapes the dashboard serves. Not landing for 500 blocks: the
# symptom pages as not-producing, and the complaint is NOT named as the cause.
cat > "${WORK}/status4.json" <<'JSON'
{"status":"degraded","health":{"ok":true},"chain":{"ok":true},
 "node":{"ok":true,"stale":false,"container":{"running":true},
         "eligibility":{"blocked":true,"key":"insufficient-stake","reason":"insufficient stake"},
         "eligibilityIgnored":true,"eligibilityCategory":"not-landing",
         "eligibilityNote":"not landing blocks: last one 500 blocks ago; the node reports insufficient stake (unconfirmed)"},
 "release":{"ok":true},"derived":{"blocksSinceLast":500,"secondsPerBlock":9},
 "system":{"throttle":{"undervoltageNow":false},"swap":{"usedPercent":0}}}
JSON
# Never seen on chain: the complaint is the only explanation, and pages with
# its evidence in the message.
cat > "${WORK}/status5.json" <<'JSON'
{"status":"degraded","health":{"ok":true},"chain":{"ok":true},
 "node":{"ok":true,"stale":false,"container":{"running":true},
         "eligibility":{"blocked":true,"key":"insufficient-stake","selfReport":"insufficient stake",
                        "reason":"insufficient stake (the node’s own report; no block from this node has been seen on chain)"},
         "eligibilityIgnored":false,"eligibilityCategory":"unconfirmed"},
 "release":{"ok":true},"derived":{},
 "system":{"throttle":{"undervoltageNow":false},"swap":{"usedPercent":0}}}
JSON
for n in 4 5; do cat > "${WORK}/alert${n}.env" <<ENV
XL1_ALERT_URL=http://127.0.0.1:${PORT}/status${n}.json
XL1_ALERT_STATE=${WORK}/.alert-state${n}
XL1_ALERT_NAME=testnode
XL1_ALERT_FRESH_FILES=
ENV
done
OUT4="$(XL1_ALERT_ENV="${WORK}/alert4.env" bash "${ALERT}" --status 2>&1)"
OUT5="$(XL1_ALERT_ENV="${WORK}/alert5.env" bash "${ALERT}" --status 2>&1)"
has   "not landing pages as not-producing"               "not-producing" "${OUT4}"
hasnt "a missing block is not called insufficient stake" "ineligible"    "${OUT4}"
has   "never seen on chain pages the complaint"          "ineligible"    "${OUT5}"
has   "and the page carries its evidence"                "no block from this node has been seen on chain" "${OUT5}"

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

# ---------------------------------------------------- maintenance holds (2.3.2)
# A planned dashboard restart must not page as an outage, and must not be done
# by switching alerting off. One named key, bounded, self-expiring.
HD="${WORK}/hold"; mkdir -p "${HD}"
DEAD="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
cat > "${WORK}/hold-dead.env" <<ENV
XL1_ALERT_URL=http://127.0.0.1:${DEAD}/status.json
XL1_ALERT_STATE=${HD}/.alert-state
XL1_ALERT_NAME=testnode
XL1_ALERT_FRESH_FILES=
ENV
H() { XL1_ALERT_ENV="${WORK}/hold-dead.env" bash "${ALERT}" "$@" 2>&1; }

has   "a critical key is refused without the override"  "producer is down"     "$(H --hold node-down 10 producer window)"
has   "a hold longer than the cap is refused"            "minutes must be"      "$(H --hold dashboard-unreachable 90 too long)"
has   "a hold needs a reason"                            "give a reason"        "$(H --hold dashboard-unreachable 5)"
has   "a hold is accepted"                               "held dashboard-unreachable for 5 min" "$(H --hold dashboard-unreachable 5 dashboard deploy)"
has   "--holds lists it"                                 "dashboard-unreachable" "$(H --holds)"
OUTH="$(H)"
hasnt "a held unreachable dashboard does not page"       "Dashboard API did not answer" "${OUTH}"
has   "the hold is logged on every run"                  "hold active: dashboard-unreachable" "${OUTH}"
check "nothing is recorded as firing"                    "$(grep -c . "${HD}/.alert-state" 2>/dev/null || true)" "0"
has   "the hold is published in .alert-status"           '"holds":\[{"key":"dashboard-unreachable"' "$(cat "${HD}/.alert-status")"

# Unrelated conditions keep firing during a hold (served fixture, readable).
python3 -m http.server ${PORT} --bind 127.0.0.1 --directory "${WORK}" >/dev/null 2>&1 & SRV=$!
for _ in $(seq 1 20); do curl -fsS --max-time 1 -o /dev/null 2>/dev/null "http://127.0.0.1:${PORT}/status.json" && break; sleep 0.3; done
cat > "${WORK}/hold-live.env" <<ENV
XL1_ALERT_URL=http://127.0.0.1:${PORT}/status.json
XL1_ALERT_STATE=${HD}/.alert-state
XL1_ALERT_NAME=testnode
XL1_ALERT_FRESH_FILES=
ENV
HL() { XL1_ALERT_ENV="${WORK}/hold-live.env" bash "${ALERT}" "$@" 2>&1; }
OUTL="$(HL)"
has   "other alerts still fire during a hold"            "Producer cannot produce" "${OUTL}"
has   "and the stall alert too"                          "not landing anything"    "${OUTL}"

# Held key that was already firing: no false recovery while held.
HL --hold ineligible 5 test >/dev/null
sed -i 's/"blocked":true/"blocked":false/' "${WORK}/status.json"
hasnt "a held key never reports recovered"               "recovered — ineligible" "$(HL)"
grep -q "^ineligible	" "${HD}/.alert-state" && printf '    ok   its state is carried forward\n' || { printf '    FAIL its state is carried forward\n'; FAILED=$((FAILED+1)); }
HL --release ineligible >/dev/null
has   "after release it resolves normally"               "recovered — ineligible" "$(HL)"

# An expired hold has no effect.
printf 'dashboard-unreachable\t1\told hold\n' > "${HD}/.alert-hold"
kill "${SRV}" 2>/dev/null; wait "${SRV}" 2>/dev/null; SRV=""
has   "an expired hold does not suppress"                "Dashboard API did not answer" "$(H)"
has   "--release clears everything"                      "released all holds" "$(H --release)"

# A hold that cannot be written must say so and fail -- never print "held".
# /proc cannot hold a directory even for root, which these tests run as.
cat > "${WORK}/hold-ro.env" <<ENV
XL1_ALERT_URL=http://127.0.0.1:${DEAD}/status.json
XL1_ALERT_STATE=/proc/xl1-no-such-dir/.alert-state
XL1_ALERT_NAME=testnode
XL1_ALERT_FRESH_FILES=
ENV
OUTRO="$(XL1_ALERT_ENV="${WORK}/hold-ro.env" bash "${ALERT}" --hold dashboard-unreachable 5 unwritable 2>&1)"; RC=$?
check "an unwritable hold exits nonzero"                 "${RC}" "1"
has   "and says no hold is active"                       "NO hold is active" "${OUTRO}"
hasnt "and never claims success"                         "^held "            "${OUTRO}"
XL1_ALERT_ENV="${WORK}/hold-ro.env" bash "${ALERT}" --release dashboard-unreachable >/dev/null 2>&1; RC=$?
check "releasing nothing in an unwritable place is not an error" "${RC}" "0"


# ------------------------------------------------------- public telemetry freshness
# The public files are read from a directory (file://), the dashboard from the
# served fixture. Nothing is delivered: no channel is configured, so send()
# only logs "no channel delivered: <title>", which is what these read.
echo "  public telemetry freshness"
FR="${WORK}/fresh"; mkdir -p "${FR}/pub" "${FR}/state" "${FR}/wc-site/.git" "${FR}/wc-race/.git"
iso() { date -u -d "@$1" '+%Y-%m-%dT%H:%M:%S.123Z'; }
NOWS="$(date +%s)"
pub() {  # pub <rbpi3 age s> <windows age s> <race age s> [windows status]
  printf '{"schema":1,"label":"rbpi3","status":"ok","generatedAt":"%s"}' "$(iso $(( NOWS - $1 )))" > "${FR}/pub/rbpi3.json"
  printf '{"schema":1,"label":"windows","status":"%s","generatedAt":"%s"}' "${4:-ok}" "$(iso $(( NOWS - $2 )))" > "${FR}/pub/windows.json"
  printf '{"schema":1,"generatedAt":%s}' "$(( (NOWS - $3) * 1000 ))" > "${FR}/pub/race-mainnet.json"
}
printf 'XL1_PUBLISH_WORKDIR=%s\n' "${FR}/wc-site" > "${FR}/publish-site.env"
printf 'XL1_PUBLISH_WORKDIR=%s\n' "${FR}/wc-race" > "${FR}/publish-race.env"
printf 'failures=0\nlastSuccess=2026-10-12T03:00:00Z\n' > "${FR}/wc-site/.git/xl1-publish.state"
printf 'failures=0\nlastSuccess=2026-10-12T03:00:00Z\n' > "${FR}/wc-race/.git/xl1-publish.state"
cat > "${WORK}/healthy.json" <<'JSON'
{"status":"ok","health":{"ok":true},"chain":{"ok":true},
 "node":{"ok":true,"stale":false,"container":{"running":true},"eligibility":{"blocked":false},"runSeconds":5000,"buildsThisRun":9},
 "release":{"ok":true},"derived":{"blocksSinceLast":0},
 "system":{"throttle":{"undervoltageNow":false},"swap":{"usedPercent":0}}}
JSON
python3 -m http.server ${PORT} --bind 127.0.0.1 --directory "${WORK}" >/dev/null 2>&1 & SRV=$!
for _ in $(seq 1 20); do curl -fsS --max-time 1 -o /dev/null 2>/dev/null "http://127.0.0.1:${PORT}/healthy.json" && break; sleep 0.3; done
fenv() {  # fenv <dashboard url> -- writes the config
cat > "${FR}/alert.env" <<ENV
XL1_ALERT_URL=$1
XL1_ALERT_STATE=${FR}/state/.alert-state
XL1_ALERT_NAME=testnode
XL1_ALERT_FRESH_BASE=file://${FR}/pub
XL1_ALERT_FRESH_EVERY=0
XL1_ALERT_FRESH_FILES="rbpi3.json=1200=${FR}/publish-site.env windows.json=1200 race-mainnet.json=2700=${FR}/publish-race.env"
ENV
}
F() { XL1_ALERT_ENV="${FR}/alert.env" bash "${ALERT}" "$@" 2>&1; }
fenv "http://127.0.0.1:${PORT}/healthy.json"

pub 60 60 300
check "all fresh: nothing firing"                         "$(F --status)" "nothing firing"
hasnt "--status writes no cache"                          "." "$(ls -A "${FR}/state")"

pub 1500 60 300
printf 'failures=5\nlastError=push rejected three times: remote: denied\nlastSuccess=2026-10-12T02:00:00Z\n' > "${FR}/wc-site/.git/xl1-publish.state"
OUT="$(F --status)"
has   "a stale Pi file is reported"                       "telemetry-stale-rbpi3|default|Public rbpi3.json is 25 min old (limit 20)" "${OUT}"
has   "with the local publisher's failure as the cause"    "publisher failing (5 run(s) in a row: push rejected three times" "${OUT}"
printf 'failures=0\nlastSuccess=2026-10-12T03:00:00Z\n' > "${FR}/wc-site/.git/xl1-publish.state"
has   "publisher healthy: blames GitHub/CDN, not the node" "publisher reports success .* GitHub or its CDN is behind" "$(F --status)"

pub 60 1500 300
has   "another host's stale file says the cause is not visible here" "telemetry-stale-windows|default|.*another host" "$(F --status)"
pub 60 60 3000
has   "the race feed has its own, longer limit (45 min)"   "telemetry-stale-race-mainnet|default|Public race-mainnet.json is 50 min old (limit 45)" "$(F --status)"
pub 60 60 2000
check "a race feed 33 min old is not stale"               "$(F --status)" "nothing firing"

pub 60 60 300 down
has   "a fresh windows.json reporting DOWN is its own alert" "telemetry-producer-down-windows|high" "$(F --status)"

pub 1500 60 300
fenv "http://127.0.0.1:1/none.json"
OUT="$(F --status)"
has   "dashboard down: the dashboard alert fires"          "dashboard-unreachable" "${OUT}"
hasnt "and the stale page it causes is not a second alert" "telemetry-stale-rbpi3" "${OUT}"
fenv "http://127.0.0.1:${PORT}/healthy.json"

echo '<html>rate limited</html>' > "${FR}/pub/rbpi3.json"
check "a 200 that is not the document is not freshness, nor stale on its own" "$(F --status)" "nothing firing"
printf '{"schema":1,"label":"rbpi3"}' > "${FR}/pub/rbpi3.json"
check "a document without generatedAt is not trusted either" "$(F --status)" "nothing firing"

# Transitions, as the timer runs it: one notice, no repeats, one recovery.
pub 60 60 300; F >/dev/null
pub 1500 60 300
OUT1="$(F)"; OUT2="$(F)"
has   "first stale run notifies"                          "no channel delivered: XL1 testnode: Public rbpi3.json is 25 min old" "${OUT1}"
hasnt "the next run does not repeat it"                   "Public rbpi3.json" "${OUT2}"
# A read failing now keeps the last good timestamp: still stale, still quiet.
rm -f "${FR}/pub/rbpi3.json"
OUT3="$(F)"
hasnt "a failed read is not a recovery"                   "recovered — telemetry-stale-rbpi3" "${OUT3}"
grep -q '^telemetry-stale-rbpi3	' "${FR}/state/.alert-state" && printf '    ok   the condition is carried through a failed read\n' || { printf '    FAIL the condition is carried through a failed read\n'; FAILED=$((FAILED+1)); }
pub 60 60 300
has   "fresh again: one recovery notice"                  "recovered — telemetry-stale-rbpi3" "$(F)"
hasnt "and no repeat of it"                               "recovered" "$(F)"

# Reads failing for over an hour: reported once, as its own condition.
awk -F'\t' -v OFS='\t' '$1=="windows.json"{$4=1} {print}' "${FR}/state/.telemetry-fresh" > "${FR}/c" && mv "${FR}/c" "${FR}/state/.telemetry-fresh"
rm -f "${FR}/pub/windows.json"
OUT="$(F)"
has   "an hour of failed reads is reported"               "Could not read public telemetry for over 60 min: windows.json" "${OUT}"
hasnt "and is not mistaken for a stale file"              "telemetry-stale-windows" "${OUT}"
pub 60 60 300
has   "and recovers when reads work again"                "recovered — telemetry-check-failing" "$(F)"

# A hold silences only the held key.
pub 1500 1500 300
F --hold telemetry-stale-rbpi3 5 publisher maintenance >/dev/null
OUT="$(F)"
hasnt "a held telemetry key does not notify"              "Public rbpi3.json" "${OUT}"
has   "other telemetry keys still do"                     "Public windows.json" "${OUT}"
F --release >/dev/null

kill "${SRV}" 2>/dev/null; wait "${SRV}" 2>/dev/null; SRV=""

exit $(( FAILED > 0 ))
