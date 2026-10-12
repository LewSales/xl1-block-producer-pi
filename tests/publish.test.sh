#!/usr/bin/env bash
# xl1-publish.sh against a real git "origin" (a bare repo) shared with a second
# writer, the way rbpi3.json and windows.json share xl1-status-data. Covers the
# failure of 2026-10-11 -- a stray windows.json committed by the Pi, after which
# every rebase conflicted -- and the rest of what can go wrong around it.
#
# Needs git, curl (file://), python3; flock for the overlap case.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISH="${HERE}/../scripts/xl1-publish.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
FAILED=0
check() { if [[ "$2" == "$3" ]]; then printf '    ok   %s\n' "$1"; else printf '    FAIL %s\n         want: %s\n         got:  %s\n' "$1" "$3" "$2"; FAILED=$((FAILED+1)); fi; }
has()   { if grep -qE -- "$3" "$2"; then printf '    ok   %s\n' "$1"; else printf '    FAIL %s\n         no /%s/ in %s\n' "$1" "$3" "$(basename "$2")"; sed 's/^/         | /' "$2" | tail -5; FAILED=$((FAILED+1)); fi; }
hasnt() { if grep -qE -- "$3" "$2"; then printf '    FAIL %s\n         found /%s/\n' "$1" "$3"; FAILED=$((FAILED+1)); else printf '    ok   %s\n' "$1"; fi; }

for t in git curl python3; do command -v "$t" >/dev/null || { echo "  $t not installed; publisher tests skipped"; exit 0; }; done
python3 -c 'pass' 2>/dev/null || { echo "  python3 not usable; publisher tests skipped"; exit 0; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL="${WORK}/gitconfig"; git config --global init.defaultBranch main; git config --global advice.detachedHead false

# logger stub: the journal, as "<priority> <message>" lines.
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/logger" <<'INNER'
#!/usr/bin/env bash
prio=user.info
while [[ $# -gt 0 ]]; do case "$1" in -t) shift 2 ;; -p) prio="$2"; shift 2 ;; *) break ;; esac; done
printf '%s %s\n' "${prio#user.}" "$*" >> "${JOURNAL}"
INNER
chmod +x "${WORK}/bin/logger"

setup() {
  rm -rf "${WORK}/origin.git" "${WORK}/wc" "${WORK}/win" "${WORK}/seed" "${WORK}/tmp"; mkdir -p "${WORK}/tmp"
  git init -q --bare "${WORK}/origin.git"
  git init -q "${WORK}/seed"
  ( cd "${WORK}/seed" && echo '{"label":"rbpi3","v":0}' > rbpi3.json && echo '{"label":"windows","v":0}' > windows.json \
    && echo '{"r":0}' > race.json && git add . && git commit -qm seed && git push -q "file://${WORK}/origin.git" HEAD:main )
  git clone -q "file://${WORK}/origin.git" "${WORK}/win"
  : > "${WORK}/journal"
  payload 1
}
payload() { printf '{"schema":1,"label":"rbpi3","v":%s}' "$1" > "${WORK}/payload.json"; }
# The other node: a separate clone that writes windows.json and pushes.
windows_writes() {
  ( cd "${WORK}/win" && git pull -q --rebase origin main && printf '{"label":"windows","v":%s}' "$1" > windows.json \
    && git commit -qam "windows $1" && git push -q origin HEAD:main )
}
publish() {  # extra env as args; --status as the only arg runs that mode
  local mode=; [[ "${1:-}" == --status ]] && { mode=--status; shift; }
  env PATH="${WORK}/bin:${PATH}" JOURNAL="${WORK}/journal" TMPDIR="${WORK}/tmp" XL1_PUBLISH_ENV=/nonexistent \
    XL1_PUBLISH_REPO="file://${WORK}/origin.git" XL1_PUBLISH_BRANCH=main XL1_PUBLISH_PATH=. \
    XL1_PUBLISH_FILE=rbpi3.json XL1_PUBLISH_PAGE= XL1_PUBLISH_WORKDIR="${WORK}/wc" \
    XL1_PUBLISH_URL="file://${WORK}/payload.json" XL1_PUBLISH_GIT_TIMEOUT=20 \
    "$@" bash "${PUBLISH}" ${mode} > "${WORK}/out" 2>&1
}
origin_file() { git --git-dir="${WORK}/origin.git" show "main:$1"; }
last_commit_files() { git --git-dir="${WORK}/origin.git" show --format= --name-only main | tr '\n' ' ' | sed 's/ $//'; }
ahead() { git -C "${WORK}/wc" rev-list --count refs/remotes/origin/main..HEAD; }
state() { sed -n "s/^$1=//p" "${WORK}/wc/.git/xl1-publish.state"; }

echo "  first publish clones and pushes only rbpi3.json"
setup; publish; rc=$?
check "exit 0" "${rc}" 0
check "origin has the payload" "$(origin_file rbpi3.json)" '{"schema":1,"label":"rbpi3","v":1}'
check "commit touches only rbpi3.json" "$(last_commit_files)" "rbpi3.json"
check "windows.json untouched" "$(origin_file windows.json)" '{"label":"windows","v":0}'
check "state: failures 0" "$(state failures)" 0

echo "  both writers keep publishing without overwriting each other"
windows_writes 1; payload 2; publish; rc=$?
check "exit 0 after the other node pushed" "${rc}" 0
windows_writes 2; payload 3; publish
windows_writes 3
check "rbpi3.json is ours" "$(origin_file rbpi3.json)" '{"schema":1,"label":"rbpi3","v":3}'
check "windows.json is theirs" "$(origin_file windows.json)" '{"label":"windows","v":3}'

echo "  no change: nothing committed"
n0="$(git --git-dir="${WORK}/origin.git" rev-list --count main)"; publish; rc=$?
check "exit 0" "${rc}" 0
check "no new commit" "$(git --git-dir="${WORK}/origin.git" rev-list --count main)" "${n0}"
has "says no change" "${WORK}/out" 'no change since the last publish'

echo "  an unrelated modified file in the working copy is never committed"
echo '{"stale":true}' > "${WORK}/wc/windows.json"; payload 4; publish; rc=$?
check "exit 0" "${rc}" 0
check "commit touches only rbpi3.json" "$(last_commit_files)" "rbpi3.json"
check "windows.json still theirs" "$(origin_file windows.json)" '{"label":"windows","v":3}'
has "stray edit logged at warning" "${WORK}/journal" '^warning .*files this node does not own \(windows.json'

echo "  the 2026-10-11 failure: a local commit carrying windows.json, origin moved on"
( cd "${WORK}/wc" && echo '{"stale":true}' > windows.json && echo '{"schema":1,"label":"rbpi3","v":"old"}' > rbpi3.json && git commit -qam "rbpi3 at old" )
windows_writes 4; payload 5; : > "${WORK}/journal"; publish; rc=$?
check "exit 0 (recovers instead of conflicting forever)" "${rc}" 0
check "rbpi3.json published" "$(origin_file rbpi3.json)" '{"schema":1,"label":"rbpi3","v":5}'
check "windows.json not overwritten" "$(origin_file windows.json)" '{"label":"windows","v":4}'
check "the foreign commit is preserved on a branch" "$(git -C "${WORK}/wc" branch --list 'publisher-preserved-*' | wc -l | tr -d ' ')" 1
has "and reported at error priority" "${WORK}/journal" '^err .*did not own|^err .*does not own \(windows.json'
check "nothing left unpushed" "$(ahead)" 0

echo "  diverged with only our own snapshots: superseded, last kept on a ref"
( cd "${WORK}/wc" && echo '{"schema":1,"label":"rbpi3","v":"older"}' > rbpi3.json && git commit -qam "rbpi3 older" )
windows_writes 5; payload 6; : > "${WORK}/journal"; publish; rc=$?
check "exit 0" "${rc}" 0
check "superseded ref kept" "$(git -C "${WORK}/wc" rev-parse -q --verify refs/xl1-publish/superseded >/dev/null && echo yes)" yes
has "noted" "${WORK}/journal" '^notice .*superseded'
check "windows.json not overwritten" "$(origin_file windows.json)" '{"label":"windows","v":5}'

echo "  an unfinished rebase left by an interrupted run is cleared"
( cd "${WORK}/wc" && echo '{"x":1}' > windows.json && git commit -qam "conflicting" ) >/dev/null
windows_writes 6
( cd "${WORK}/wc" && git fetch -q origin && git rebase -q origin/main ) >/dev/null 2>&1
check "test set-up: rebase in progress" "$( [[ -d "${WORK}/wc/.git/rebase-merge" || -d "${WORK}/wc/.git/rebase-apply" ]] && echo yes)" yes
payload 7; publish; rc=$?
check "exit 0" "${rc}" 0
check "rbpi3.json published" "$(origin_file rbpi3.json)" '{"schema":1,"label":"rbpi3","v":7}'
check "windows.json not overwritten" "$(origin_file windows.json)" '{"label":"windows","v":6}'
check "no rebase left behind" "$( [[ -d "${WORK}/wc/.git/rebase-merge" || -d "${WORK}/wc/.git/rebase-apply" ]] && echo yes || echo no)" no

echo "  a push rejected once is rebuilt on the new tip and retried, never forced"
cat > "${WORK}/origin.git/hooks/pre-receive" <<INNER
#!/usr/bin/env bash
if [[ ! -f "${WORK}/rejected-once" ]]; then touch "${WORK}/rejected-once"; echo "rejected once by test hook" >&2; exit 1; fi
INNER
chmod +x "${WORK}/origin.git/hooks/pre-receive"
payload 8; publish; rc=$?
check "exit 0 on the retry" "${rc}" 0
check "published" "$(origin_file rbpi3.json)" '{"schema":1,"label":"rbpi3","v":8}'
rm -f "${WORK}/origin.git/hooks/pre-receive"

echo "  failed pushes: git's error kept (credentials scrubbed), escalated once, nothing left to diverge"
cat > "${WORK}/origin.git/hooks/pre-receive" <<'INNER'
#!/usr/bin/env bash
echo "denied by test hook: https://bot:ghp_SECRETSECRET123@github.com/x token=hunter2" >&2; exit 1
INNER
chmod +x "${WORK}/origin.git/hooks/pre-receive"
: > "${WORK}/journal"
for i in 1 2 3 4; do payload "9$i"; publish; rc=$?; done
check "exit 1" "${rc}" 1
has "git's own error reaches the journal" "${WORK}/journal" 'denied by test hook'
hasnt "no token in the journal" "${WORK}/journal" 'ghp_SECRET|hunter2|bot:'
hasnt "no token in the output" "${WORK}/out" 'ghp_SECRET|hunter2|bot:'
check "error-priority line exactly once in 4 failures" "$(grep -c '^err ' "${WORK}/journal")" 1
check "state: failures 4" "$(state failures)" 4
check "no local commit left ahead of origin" "$(ahead)" 0
rm -f "${WORK}/origin.git/hooks/pre-receive"
payload 10; : > "${WORK}/journal"; publish; rc=$?
check "recovers: exit 0" "${rc}" 0
has "recovery noted once" "${WORK}/journal" '^notice .*recovered after 4 failed run'
check "state: failures back to 0" "$(state failures)" 0

echo "  fetch failure: fails without leaving a commit behind"
mv "${WORK}/origin.git" "${WORK}/origin.moved"; payload 11; publish; rc=$?
check "exit 1" "${rc}" 1
has "says fetch failed with git's reason" "${WORK}/out" 'fetch failed: .+'
mv "${WORK}/origin.moved" "${WORK}/origin.git"
check "no local commit created" "$(git -C "${WORK}/wc" rev-list --count refs/remotes/origin/main..HEAD)" 0

echo "  a bad payload is never published"
n0="$(git --git-dir="${WORK}/origin.git" rev-list --count main)"
printf '{"error":"boom"}' > "${WORK}/payload.json"; publish; rc=$?
check "exit 1" "${rc}" 1
check "no new commit" "$(git --git-dir="${WORK}/origin.git" rev-list --count main)" "${n0}"

echo "  overlapping runs: the second skips"
if command -v flock >/dev/null; then
  payload 12
  lock="${WORK}/tmp/xl1-publish.$(printf '%s' "${WORK}/wc" | tr -c 'A-Za-z0-9' '_').lock"
  ( exec 9>"${lock}"; flock 9; sleep 4 ) & holder=$!
  sleep 1; publish; rc=$?
  wait "${holder}"
  check "exit 0" "${rc}" 0
  has "says another run is in progress" "${WORK}/out" 'another publish is still running'
  check "nothing published by the skipped run" "$(git --git-dir="${WORK}/origin.git" rev-list --count main)" "${n0}"
else
  echo "    (flock not installed; overlap case skipped)"
fi

echo "  --status prints the run state"
publish --status
has "shows lastSuccess" "${WORK}/out" '^lastSuccess='

exit $(( FAILED > 0 ))
