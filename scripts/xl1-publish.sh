#!/usr/bin/env bash
# Publish this node's public status to the status repository.
#
# Fetches /api/public -- an allow-list projection of the dashboard, so this
# script never has to decide what is safe to publish and cannot get it wrong.
# It copies bytes; the redaction is upstream, in one place, with tests against a
# payload seeded with canary values.
#
# Writes one file of a shared repository, and stages only that file, so two
# nodes publishing to the same repo cannot overwrite each other. Each run builds
# its commit on the branch tip and pushes without force; git's errors are kept,
# scrubbed, in the journal; a persistent failure escalates once, not every run.
#
#   /etc/xl1/publish.env   configuration (see publish.env.template)
#   xl1-publish.timer      runs this every 5 minutes
#
#   ./xl1-publish.sh --dry-run   fetch and write locally, push nothing
#   ./xl1-publish.sh --status    last success, consecutive failures, last error

set -uo pipefail

ENV_FILE="${XL1_PUBLISH_ENV:-/etc/xl1/publish.env}"
# A config file that exists and cannot be read is a different fault from one
# that was never written, and the two used to look identical: every setting
# stayed at its default, the repository came out empty, and the script reported
# "nothing to publish to" and exited 0. That is a silent failure wearing the
# costume of a healthy no-op -- the service unit called it success and the timer
# repeated it every five minutes.
if [[ -e "${ENV_FILE}" && ! -r "${ENV_FILE}" ]]; then
  echo "xl1-publish: ${ENV_FILE} exists but is not readable by $(id -un) -- check its owner and mode" >&2
  logger -t xl1-publish "config unreadable: ${ENV_FILE}" 2>/dev/null || true
  exit 1
fi
[[ -r "${ENV_FILE}" ]] && { set -a; . "${ENV_FILE}"; set +a; }

URL="${XL1_PUBLISH_URL:-http://127.0.0.1:8088/api/public}"
TOKEN="${XL1_PUBLISH_TOKEN:-}"
REPO="${XL1_PUBLISH_REPO:-}"
BRANCH="${XL1_PUBLISH_BRANCH:-main}"
SUBPATH="${XL1_PUBLISH_PATH:-xl1/rbpi3}"
# Not under /var/lib/xl1: that belongs to the dashboard, is bind-mounted into
# its container, and is root-owned -- while this runs as the operator. A git
# checkout has no business in the directory whose disk usage the dashboard
# reports either.
WORKDIR="${XL1_PUBLISH_WORKDIR:-/var/lib/xl1-publish}"
# The file this node writes. One repository can hold several nodes' data when
# each writes its own name -- which is what lets the site own every page while
# the nodes own only what they measure.
DATA_FILE="${XL1_PUBLISH_FILE:-status.json}"
GIT_NAME="${XL1_PUBLISH_GIT_NAME:-xl1-publisher}"
GIT_EMAIL="${XL1_PUBLISH_GIT_EMAIL:-xl1-publisher@users.noreply.github.com}"
# ${VAR-default}, not ${VAR:-default}: the colon form falls back when the value
# is EMPTY as well as unset, and empty is a real choice here -- it means "this
# destination already owns its pages, do not write one". With the colon the
# node wrote a second copy of the producer page into the data directory,
# where nothing serves it and it would have gone stale beside live data.
PAGE="${XL1_PUBLISH_PAGE-/srv/xl1-dashboard/public.html}"
# Optional: a URL that accepts the status document directly -- object storage, a
# Worker, anything that takes an HTTP PUT. Git ships the PAGE well, because a
# page is reviewed and versioned and changes rarely. It ships the DATA badly:
# every publish becomes a commit, a build and a CDN propagation, and the number
# on screen is minutes behind the node that produced it.
LIVE_URL="${XL1_PUBLISH_LIVE_URL:-}"
LIVE_AUTH="${XL1_PUBLISH_LIVE_AUTH:-}"
LIVE_METHOD="${XL1_PUBLISH_LIVE_METHOD:-PUT}"

# Bound every network step: a hung fetch or push must end this run, not hold
# the next one off. BatchMode stops ssh from ever waiting on a prompt. An
# existing GIT_SSH_COMMAND from the config is respected as it is.
GIT_TIMEOUT="${XL1_PUBLISH_GIT_TIMEOUT:-60}"
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=15}"
# Consecutive failed runs before the journal gets an error-priority line, and
# how many more before it is repeated (72 runs at 5 minutes is six hours).
ESCALATE_AFTER="${XL1_PUBLISH_ESCALATE_AFTER:-3}"
ESCALATE_EVERY="${XL1_PUBLISH_ESCALATE_EVERY:-72}"

DRY=0; STATUS=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  --status)  STATUS=1 ;;
esac

log() {
  printf '%s\n' "$*"
  logger -t xl1-publish "$*" 2>/dev/null || true
}
# Same, at a chosen journal priority (warning, err, notice).
logp() {
  local prio="$1"; shift
  printf '%s\n' "$*"
  logger -t xl1-publish -p "user.${prio}" "$*" 2>/dev/null || true
}

# Anything git says goes to the journal, so it must never carry a credential:
# userinfo in a URL, a GitHub token, or a key=value secret. Bounded, one line.
scrub() {
  sed -E \
    -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]]+@#\1<redacted>@#g' \
    -e 's#(gh[pousr]_|github_pat_)[A-Za-z0-9_]+#<redacted>#g' \
    -e 's#((token|password|passwd|secret|authorization|auth)[[:space:]]*[=:][[:space:]]*)[^[:space:]]+#\1<redacted>#Ig' \
  | tr '\n\r\t' '   ' | tr -s ' ' | cut -c1-600
}

# Run git with its stderr kept (scrubbed and bounded) in GIT_ERR instead of
# thrown away. Until 2026-10-11 every git error went to /dev/null, and the one
# failure that mattered could not be explained afterwards.
GIT_ERR=''
g() {
  local errf rc
  errf="$(mktemp)"
  timeout "${GIT_TIMEOUT}" git "$@" 2>"${errf}"; rc=$?
  GIT_ERR="$(tail -c 4000 "${errf}" | scrub)"
  rm -f "${errf}"
  (( rc == 124 )) && GIT_ERR="timed out after ${GIT_TIMEOUT}s ${GIT_ERR}"
  return "${rc}"
}

# ------------------------------------------------------------- run state
# Kept beside the working copy, never inside what gets committed. A deleted
# working copy loses only the failure count.
STATE_FILE="${WORKDIR}/.git/xl1-publish.state"
state_get() { [[ -r "${STATE_FILE}" ]] && sed -n "s/^$1=//p" "${STATE_FILE}" | head -1; }
state_put() {  # key=value ...
  [[ -d "${WORKDIR}/.git" ]] || return 0
  local tmp="${STATE_FILE}.tmp" kv k
  { [[ -r "${STATE_FILE}" ]] && cat "${STATE_FILE}"; } > "${tmp}.old" 2>/dev/null || : > "${tmp}.old"
  cp "${tmp}.old" "${tmp}"
  for kv in "$@"; do
    k="${kv%%=*}"
    grep -v "^${k}=" "${tmp}" > "${tmp}.new" 2>/dev/null; mv "${tmp}.new" "${tmp}"
    printf '%s\n' "${kv}" >> "${tmp}"
  done
  mv "${tmp}" "${STATE_FILE}"; rm -f "${tmp}.old"
}

if (( STATUS )); then
  if [[ -r "${STATE_FILE}" ]]; then cat "${STATE_FILE}"; else echo "no state recorded yet (${STATE_FILE})"; fi
  exit 0
fi

# A failed run: logged every time at warning, escalated to error once the
# failures persist, and repeated only rarely after that -- a stalled publisher
# should be findable, not a line every five minutes in the error stream.
fail() {
  local msg="$1" n since
  n=$(( $(state_get failures || echo 0) + 1 ))
  since="$(state_get failingSince)"; [[ -n "${since}" ]] || since="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  state_put "failures=${n}" "failingSince=${since}" "lastError=$(printf '%s' "${msg}" | tr '\n' ' ' | cut -c1-600)" "lastAttempt=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  logp warning "${msg}"
  if (( n == ESCALATE_AFTER || (n > ESCALATE_AFTER && (n - ESCALATE_AFTER) % ESCALATE_EVERY == 0) )); then
    logp err "publishing ${DATA_FILE} has failed ${n} runs in a row since ${since}; last error: ${msg}"
  fi
  exit 1
}
succeed() {
  local msg="$1" n
  n="$(state_get failures)"; n="${n:-0}"
  if (( n > 0 )); then logp notice "publishing ${DATA_FILE} recovered after ${n} failed run(s) since $(state_get failingSince)"; fi
  state_put "failures=0" "failingSince=" "lastSuccess=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "lastAttempt=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  log "${msg}"
  exit 0
}

# ------------------------------------------------------------- one at a time
# The timer never overlaps a oneshot, but a hand-run beside it would: two
# processes in one working copy is exactly how a half-finished checkout gets
# committed. Keyed by working copy, so the race and site publishers, which
# have their own, never wait on each other.
LOCK="${XL1_PUBLISH_LOCK:-${TMPDIR:-/tmp}/xl1-publish.$(printf '%s' "${WORKDIR}" | tr -c 'A-Za-z0-9' '_').lock}"
if command -v flock >/dev/null; then
  exec 9>"${LOCK}"
  flock -n 9 || { log "another publish is still running in ${WORKDIR} -- skipping this run"; exit 0; }
fi

[[ -n "${REPO}" || ${DRY} -eq 1 ]] || {
  log 'XL1_PUBLISH_REPO is empty -- nothing to publish to. See publish.env.template.'
  exit 0
}

# ------------------------------------------------------------------- fetch
FETCH="${URL}"
[[ -n "${TOKEN}" ]] && FETCH="${URL}?token=${TOKEN}"
BODY="$(curl -fsS --max-time 20 "${FETCH}" 2>/dev/null)" || {
  [[ -d "${WORKDIR}/.git" ]] && fail "could not read ${URL}"
  log "could not read ${URL}"; exit 1; }

# Parsed before it is written, so a truncated or error response is never
# published over a good one. A stale page is recoverable; a corrupt one is the
# page telling everybody the node is broken when it is not.
printf '%s' "${BODY}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not d.get("schema"): raise SystemExit("no schema field -- is this /api/public?")
' 2>/dev/null || {
  [[ -d "${WORKDIR}/.git" ]] && fail 'refused to publish: response is not the public payload'
  log 'refused to publish: response is not the public payload'; exit 1; }

# --------------------------------------------------------------- working copy
mkdir -p "${WORKDIR}"
# A dry run with no repository configured is the first thing anyone does. It
# writes the files and stops, rather than failing on a clone of "".
if (( DRY )) && [[ -z "${REPO}" ]]; then
  mkdir -p "${WORKDIR}/${SUBPATH}"
  printf '%s' "${BODY}" > "${WORKDIR}/${SUBPATH}/${DATA_FILE}"
  [[ -f "${PAGE}" ]] && cp -f "${PAGE}" "${WORKDIR}/${SUBPATH}/index.html"
  log "dry run: wrote ${WORKDIR}/${SUBPATH} (no repository configured)"
  exit 0
fi

if [[ ! -d "${WORKDIR}/.git" ]]; then
  # Shallow and single-branch: this repository is a delivery mechanism, and its
  # history is of no use on a producer.
  g clone --quiet --depth 1 --branch "${BRANCH}" --single-branch "${REPO}" "${WORKDIR}" || {
    log "clone of ${REPO} failed: ${GIT_ERR}"; exit 1; }
fi
cd "${WORKDIR}" || exit 1
git config user.name "${GIT_NAME}"
git config user.email "${GIT_EMAIL}"

# The only paths this node owns. Nothing else is ever staged: two writers share
# one repository, and `git add .` once committed the other node's file here
# (2026-10-11), after which every rebase conflicted and this node's page went
# six hours stale.
DATA_PATH="${DATA_FILE}"; [[ "${SUBPATH}" != "." ]] && DATA_PATH="${SUBPATH%/}/${DATA_FILE}"
OWNED=("${DATA_PATH}")
if [[ -f "${PAGE}" ]]; then
  PAGE_PATH="index.html"; [[ "${SUBPATH}" != "." ]] && PAGE_PATH="${SUBPATH%/}/index.html"
  OWNED+=("${PAGE_PATH}")
fi
is_owned() { local p; for p in "${OWNED[@]}"; do [[ "$1" == "${p}" ]] && return 0; done; return 1; }

# A dry run writes this node's files into the working copy as it stands and
# stops: no fetch, no reset, no commit.
if (( DRY )); then
  mkdir -p "${SUBPATH}"
  printf '%s' "${BODY}" > "${DATA_PATH}"
  [[ -n "${PAGE_PATH:-}" ]] && cp -f "${PAGE}" "${PAGE_PATH}"
  log "dry run: wrote ${WORKDIR}/${SUBPATH} (nothing pushed)"
  exit 0
fi

# --- 1. Leftovers from an interrupted run. The lock above means no other run is
# in here, so an unfinished rebase or merge, or a stale index lock, is debris.
if [[ -d .git/rebase-merge || -d .git/rebase-apply ]]; then
  logp warning "found an unfinished rebase in ${WORKDIR}; aborting it"
  g rebase --abort || g reset --quiet --merge || fail "could not clear an unfinished rebase: ${GIT_ERR}"
fi
if [[ -f .git/MERGE_HEAD ]]; then
  logp warning "found an unfinished merge in ${WORKDIR}; aborting it"
  g merge --abort || fail "could not clear an unfinished merge: ${GIT_ERR}"
fi
if [[ -f .git/index.lock ]]; then
  logp warning "removing a stale .git/index.lock left by an interrupted run"
  rm -f .git/index.lock
fi

# --- 2. Where the shared branch is now. Nothing is committed until this works,
# so a network failure leaves no local commit behind to diverge later.
g fetch --quiet origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" || fail "fetch failed: ${GIT_ERR}"
UPSTREAM="refs/remotes/origin/${BRANCH}"

# --- 3. Local commits the branch does not have. Each run now builds on the
# branch tip, so this is normally empty; if it is not, decide what they are
# before moving past them.
ahead="$(git rev-list --count "${UPSTREAM}..HEAD" 2>/dev/null || echo 0)"
if (( ahead > 0 )); then
  foreign="$(git log --format= --name-only "${UPSTREAM}..HEAD" | sort -u | while read -r f; do [[ -n "${f}" ]] && ! is_owned "${f}" && printf '%s ' "${f}"; done)"
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  if [[ -n "${foreign}" ]]; then
    # Not ours to drop: keep them on a branch, say so at error priority, and
    # publish from the shared tip.
    git branch -f "publisher-preserved-${stamp}" HEAD >/dev/null 2>&1 \
      || fail "could not preserve ${ahead} unpublished local commit(s) touching ${foreign}-- leaving the working copy alone"
    logp err "${ahead} unpublished local commit(s) touched files this node does not own (${foreign}); kept on branch publisher-preserved-${stamp}, publishing from origin/${BRANCH}"
  else
    # Older snapshots of this node's own file: the payload about to be written
    # supersedes them. The last is kept on a ref, so nothing is lost silently.
    git update-ref refs/xl1-publish/superseded HEAD
    logp notice "${ahead} unpublished snapshot(s) of ${DATA_PATH} superseded by this run (last kept at refs/xl1-publish/superseded)"
  fi
fi

# --- 4. Stray edits to tracked files. Never staged (see OWNED), but logged, and
# replaced by the branch's copy when the working copy is moved to the tip.
stray="$(git status --porcelain --untracked-files=no | cut -c4- | while read -r f; do ! is_owned "${f}" && printf '%s ' "${f}"; done)"
[[ -n "${stray}" ]] && logp warning "working copy had local edits to files this node does not own (${stray}); replacing them with origin/${BRANCH}"

# Write this node's files on the branch tip and commit them, and only them.
# Returns 3 when there is nothing new to commit.
commit_on_tip() {
  if ! g reset --quiet --hard "${UPSTREAM}"; then
    # A working copy that cannot lock its own HEAD -- with no lock file on disk
    # and no other git running (the flock above guarantees the latter) -- never
    # heals: on 2026-10-14 both copies on this Pi failed this way for two days,
    # 500+ runs in a row, while the page froze. The copy is disposable and the
    # remote holds everything worth keeping, so keep the broken .git for
    # inspection and rebuild one in place. In place, because the parent
    # (/var/lib) is root's and this runs as the operator.
    if [[ "${GIT_ERR}" == *"cannot lock ref"* ]]; then
      local aside=".git.broken-$(date -u '+%Y%m%dT%H%M%SZ')" first="${GIT_ERR}"
      logp err "working copy could not lock HEAD (${first}); kept as ${WORKDIR}/${aside}, rebuilding from origin/${BRANCH}"
      mv .git "${aside}" \
        && g init --quiet -b "${BRANCH}" \
        && g remote add origin "${REPO}" \
        && git config user.name "${GIT_NAME}" && git config user.email "${GIT_EMAIL}" \
        && g fetch --quiet --depth 1 origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" \
        && g reset --quiet --hard "${UPSTREAM}" \
        || fail "could not rebuild the working copy after a HEAD lock failure: ${GIT_ERR}"
    else
      fail "could not move the working copy to origin/${BRANCH}: ${GIT_ERR}"
    fi
  fi
  mkdir -p "${SUBPATH}"
  printf '%s' "${BODY}" > "${DATA_PATH}"
  # The page travels with the data so a page fix reaches the site on the next
  # publish, rather than needing somebody to remember to copy it.
  if [[ -n "${PAGE_PATH:-}" ]]; then
    if [[ -n "${LIVE_URL}" ]]; then
      # Point the page at the live endpoint. A literal swap of one line, so the
      # page in the repository stays the readable default.
      sed "s|const DATA_URL = 'status.json'|const DATA_URL = '${LIVE_URL//|/\\|}'|" "${PAGE}" > "${PAGE_PATH}"
    else
      cp -f "${PAGE}" "${PAGE_PATH}"
    fi
  fi
  g add -- "${OWNED[@]}" || fail "could not stage ${OWNED[*]}: ${GIT_ERR}"
  if git diff --cached --quiet; then return 3; fi
  g commit --quiet -m "${WHO} at $(date -u '+%Y-%m-%d %H:%M:%S')Z" || fail "commit failed: ${GIT_ERR}"
  return 0
}

# The node's own name for itself, taken from the payload rather than from
# configuration -- a history of "." tells a reader nothing about which machine
# wrote it, and the path is "." whenever a repo holds a single node.
WHO="$(printf '%s' "${BODY}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("label") or "")' 2>/dev/null)"
[[ -n "${WHO}" ]] || WHO="${SUBPATH}"
[[ "${WHO}" == "." ]] && WHO=status

# Straight to the live endpoint, before the git push: this is the copy people
# actually read, and it should not wait on a commit. Never fatal -- the git copy
# is the fallback, and a page a few minutes stale beats a publisher that stopped.
if [[ -n "${LIVE_URL}" ]]; then
  if printf '%s' "${BODY}" | curl -fsS --max-time 20 -X "${LIVE_METHOD}" \
       -H 'content-type: application/json' \
       ${LIVE_AUTH:+-H "authorization: ${LIVE_AUTH}"} \
       --data-binary @- "${LIVE_URL}" >/dev/null 2>&1; then
    log 'live endpoint updated'
  else
    log 'live endpoint failed -- falling back to the git copy'
  fi
fi

commit_on_tip; rc=$?
(( rc == 3 )) && succeed 'no change since the last publish'

# Two nodes push to one branch. A push can be rejected for being behind; the
# answer is to fetch and rebuild this one commit on the new tip -- it touches
# only this node's file, so there is nothing to merge -- never to force.
for attempt in 1 2 3; do
  if g push --quiet origin "HEAD:refs/heads/${BRANCH}"; then
    succeed "published ${WHO}"
  fi
  perr="${GIT_ERR}"
  (( attempt == 3 )) && break
  g fetch --quiet origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" || fail "push rejected (${perr}); then fetch failed: ${GIT_ERR}"
  commit_on_tip; rc=$?
  (( rc == 3 )) && succeed 'no change since the last publish'
done
# Reset to the tip so a failed push leaves no local commit to diverge from.
g reset --quiet --hard "${UPSTREAM}" || true
fail "push rejected three times: ${perr}"
