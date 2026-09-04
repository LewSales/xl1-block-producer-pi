#!/usr/bin/env bash
# Publish this node's public status to the status repository.
#
# Fetches /api/public -- an allow-list projection of the dashboard, so this
# script never has to decide what is safe to publish and cannot get it wrong.
# It copies bytes; the redaction is upstream, in one place, with tests against a
# payload seeded with canary values.
#
# Writes into one directory of a shared repository, and only that directory, so
# two nodes publishing to the same repo cannot overwrite each other.
#
#   /etc/xl1/publish.env   configuration (see publish.env.template)
#   xl1-publish.timer      runs this every 5 minutes
#
#   ./xl1-publish.sh --dry-run   fetch and write locally, push nothing

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
GIT_NAME="${XL1_PUBLISH_GIT_NAME:-xl1-publisher}"
GIT_EMAIL="${XL1_PUBLISH_GIT_EMAIL:-xl1-publisher@users.noreply.github.com}"
PAGE="${XL1_PUBLISH_PAGE:-/srv/xl1-dashboard/public.html}"
# Optional: a URL that accepts the status document directly -- object storage, a
# Worker, anything that takes an HTTP PUT. Git ships the PAGE well, because a
# page is reviewed and versioned and changes rarely. It ships the DATA badly:
# every publish becomes a commit, a build and a CDN propagation, and the number
# on screen is minutes behind the node that produced it.
LIVE_URL="${XL1_PUBLISH_LIVE_URL:-}"
LIVE_AUTH="${XL1_PUBLISH_LIVE_AUTH:-}"
LIVE_METHOD="${XL1_PUBLISH_LIVE_METHOD:-PUT}"

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

log() {
  printf '%s\n' "$*"
  logger -t xl1-publish "$*" 2>/dev/null || true
}

[[ -n "${REPO}" || ${DRY} -eq 1 ]] || {
  log 'XL1_PUBLISH_REPO is empty -- nothing to publish to. See publish.env.template.'
  exit 0
}

# ------------------------------------------------------------------- fetch
FETCH="${URL}"
[[ -n "${TOKEN}" ]] && FETCH="${URL}?token=${TOKEN}"
BODY="$(curl -fsS --max-time 20 "${FETCH}" 2>/dev/null)" || {
  log "could not read ${URL}"; exit 1; }

# Parsed before it is written, so a truncated or error response is never
# published over a good one. A stale page is recoverable; a corrupt one is the
# page telling everybody the node is broken when it is not.
printf '%s' "${BODY}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not d.get("schema"): raise SystemExit("no schema field -- is this /api/public?")
' 2>/dev/null || { log 'refused to publish: response is not the public payload'; exit 1; }

# --------------------------------------------------------------- working copy
mkdir -p "${WORKDIR}"
# A dry run with no repository configured is the first thing anyone does. It
# writes the files and stops, rather than failing on a clone of "".
if (( DRY )) && [[ -z "${REPO}" ]]; then
  mkdir -p "${WORKDIR}/${SUBPATH}"
  printf '%s' "${BODY}" > "${WORKDIR}/${SUBPATH}/status.json"
  [[ -f "${PAGE}" ]] && cp -f "${PAGE}" "${WORKDIR}/${SUBPATH}/index.html"
  log "dry run: wrote ${WORKDIR}/${SUBPATH} (no repository configured)"
  exit 0
fi

if [[ ! -d "${WORKDIR}/.git" ]]; then
  # Shallow and single-branch: this repository is a delivery mechanism, and its
  # history is of no use on a producer.
  git clone --quiet --depth 1 --branch "${BRANCH}" --single-branch "${REPO}" "${WORKDIR}" 2>/dev/null || {
    log "clone of ${REPO} failed"; exit 1; }
fi
cd "${WORKDIR}" || exit 1
git config user.name "${GIT_NAME}"
git config user.email "${GIT_EMAIL}"

mkdir -p "${SUBPATH}"
printf '%s' "${BODY}" > "${SUBPATH}/status.json"

# The page travels with the data so a page fix reaches the site on the next
# publish, rather than needing somebody to remember to copy it.
if [[ -f "${PAGE}" ]]; then
  if [[ -n "${LIVE_URL}" ]]; then
    # Point the page at the live endpoint. A literal swap of one line, so the
    # page in the repository stays the readable default.
    sed "s|const DATA_URL = 'status.json'|const DATA_URL = '${LIVE_URL//|/\\|}'|" "${PAGE}" > "${SUBPATH}/index.html"
  else
    cp -f "${PAGE}" "${SUBPATH}/index.html"
  fi
fi

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

if (( DRY )); then log "dry run: wrote ${WORKDIR}/${SUBPATH} (nothing pushed)"; exit 0; fi

git add -- "${SUBPATH}"
if git diff --cached --quiet; then log 'no change since the last publish'; exit 0; fi
# The node's own name for itself, taken from the payload rather than from
# configuration -- a history of "." tells a reader nothing about which machine
# wrote it, and the path is "." whenever a repo holds a single node.
WHO="$(printf '%s' "${BODY}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("label") or "")' 2>/dev/null)"
[[ -n "${WHO}" ]] || WHO="${SUBPATH}"
[[ "${WHO}" == "." ]] && WHO=status
git commit --quiet -m "${WHO} at $(date -u '+%Y-%m-%d %H:%M:%S')Z"

# Two nodes push to one repository. Each writes only its own directory, so a
# rebase can never conflict -- but it can still be rejected for being behind,
# which is what this retries.
for _ in 1 2 3; do
  if git push --quiet origin "${BRANCH}" 2>/dev/null; then
    log "published ${WHO}"; exit 0
  fi
  git fetch --quiet origin "${BRANCH}" 2>/dev/null
  git rebase --quiet "origin/${BRANCH}" 2>/dev/null || {
    git rebase --abort 2>/dev/null
    log 'rebase failed -- leaving the working copy alone for the next run'
    exit 1; }
done
log 'push rejected three times -- giving up until the next run'
exit 1
