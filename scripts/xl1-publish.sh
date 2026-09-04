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
[[ -r "${ENV_FILE}" ]] && { set -a; . "${ENV_FILE}"; set +a; }

URL="${XL1_PUBLISH_URL:-http://127.0.0.1:8088/api/public}"
TOKEN="${XL1_PUBLISH_TOKEN:-}"
REPO="${XL1_PUBLISH_REPO:-}"
BRANCH="${XL1_PUBLISH_BRANCH:-main}"
SUBPATH="${XL1_PUBLISH_PATH:-xl1/rbpi3}"
WORKDIR="${XL1_PUBLISH_WORKDIR:-/var/lib/xl1/publish}"
GIT_NAME="${XL1_PUBLISH_GIT_NAME:-xl1-publisher}"
GIT_EMAIL="${XL1_PUBLISH_GIT_EMAIL:-xl1-publisher@users.noreply.github.com}"
PAGE="${XL1_PUBLISH_PAGE:-/srv/xl1-dashboard/public.html}"

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
[[ -f "${PAGE}" ]] && cp -f "${PAGE}" "${SUBPATH}/index.html"

if (( DRY )); then log "dry run: wrote ${WORKDIR}/${SUBPATH} (nothing pushed)"; exit 0; fi

git add -- "${SUBPATH}"
if git diff --cached --quiet; then log 'no change since the last publish'; exit 0; fi
git commit --quiet -m "${SUBPATH} at $(date -u '+%Y-%m-%d %H:%M:%S')Z"

# Two nodes push to one repository. Each writes only its own directory, so a
# rebase can never conflict -- but it can still be rejected for being behind,
# which is what this retries.
for _ in 1 2 3; do
  if git push --quiet origin "${BRANCH}" 2>/dev/null; then
    log "published ${SUBPATH}"; exit 0
  fi
  git fetch --quiet origin "${BRANCH}" 2>/dev/null
  git rebase --quiet "origin/${BRANCH}" 2>/dev/null || {
    git rebase --abort 2>/dev/null
    log 'rebase failed -- leaving the working copy alone for the next run'
    exit 1; }
done
log 'push rejected three times -- giving up until the next run'
exit 1
