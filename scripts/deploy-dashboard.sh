#!/usr/bin/env bash
# Ship the dashboard to the Pi by copying three files.
#
#   ./scripts/deploy-dashboard.sh [host]
#
# What this replaces: cross-building an arm64 image and pushing 110 MB over the
# tunnel for a CSS change. That took ten to fifteen minutes, and three times it
# exited zero having copied nothing — leaving the Pi quietly serving an older
# build while the deploy reported success. The dashboard is three files.
#
# The image still provides node_modules, the runtime and the healthcheck, and it
# carries its own copies of these files; the bind mounts in xl1-dashboard.service
# shadow them. Rebuild the image when a dependency changes, not when the page does.
#
# Every step is verified on the far side. The last failure mode was a transfer
# that claimed success, so "it exited zero" is not evidence here.
set -euo pipefail

HOST="${1:-xl1pi@xl1pi}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST=/srv/xl1-dashboard

GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
ok()  { printf '  %s✓%s %s\n' "${GREEN}" "${RESET}" "$*"; }
die() { printf '  %s✗%s %s\n' "${RED}" "${RESET}" "$*" >&2; exit 1; }

# The stamp travels with the code. Without it the page would report the commit
# baked into whatever image is underneath, which is a wrong answer rather than a
# missing one. --dirty is deliberate: a build from uncommitted changes must not
# claim a commit that is on GitHub.
COMMIT="$(git -C "${HERE}" describe --always --dirty --abbrev=8 2>/dev/null || echo unknown)"
VERSION="$(node -e "process.stdout.write(require('${HERE}/dashboard/package.json').version)" 2>/dev/null || echo unknown)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(printf '{"version":"%s","commit":"%s","builtAt":"%s"}' "${VERSION}" "${COMMIT}" "${BUILT_AT}")"

printf '\ndeploying %s · %s to %s\n' "${VERSION}" "${COMMIT}" "${HOST}"

node --check "${HERE}/dashboard/server.mjs" || die "server.mjs does not parse — refusing to deploy"
ok "server.mjs parses"

ssh -o ConnectTimeout=10 "${HOST}" "mkdir -p ${DEST}" 2>/dev/null \
  || die "cannot create ${DEST} — run: sudo install -d -o \$USER -g \$USER -m 755 ${DEST}"

for f in server.mjs index.html; do
  scp -q "${HERE}/dashboard/${f}" "${HOST}:${DEST}/${f}" || die "copy failed: ${f}"
done
printf '%s' "${STAMP}" | ssh -o ConnectTimeout=10 "${HOST}" "cat > ${DEST}/build.json" || die "copy failed: build.json"
ssh -o ConnectTimeout=10 "${HOST}" "chmod 644 ${DEST}/server.mjs ${DEST}/index.html ${DEST}/build.json"

# Compare hashes rather than trusting exit codes, which is the failure this
# script exists to stop repeating.
LOCAL_SUM="$(cat "${HERE}/dashboard/server.mjs" "${HERE}/dashboard/index.html" | sha256sum | cut -d' ' -f1)"
REMOTE_SUM="$(ssh -o ConnectTimeout=10 "${HOST}" "cat ${DEST}/server.mjs ${DEST}/index.html | sha256sum | cut -d' ' -f1")"
[[ "${LOCAL_SUM}" == "${REMOTE_SUM}" ]] || die "files differ after copy (local ${LOCAL_SUM:0:12}, remote ${REMOTE_SUM:0:12})"
ok "files match on the far side (${LOCAL_SUM:0:12})"

# Restart-always brings it back on the same image with the new files. No sudo:
# xl1pi is in the docker group.
ssh -o ConnectTimeout=10 "${HOST}" 'docker rm -f xl1-dashboard >/dev/null 2>&1 || true'
for _ in $(seq 1 30); do
  sleep 2
  STATUS="$(ssh -o ConnectTimeout=10 "${HOST}" 'docker ps --filter name=xl1-dashboard --format "{{.Status}}"' 2>/dev/null || true)"
  [[ -n "${STATUS}" ]] && break
done
[[ -n "${STATUS:-}" ]] || die "container did not come back — check: journalctl -u xl1-dashboard -n 40"
ok "container up (${STATUS})"

# The page must actually report the build we just sent. Anything else means the
# mount is not in effect and the image underneath is being served instead.
for _ in $(seq 1 20); do
  sleep 2
  SERVING="$(ssh -o ConnectTimeout=10 "${HOST}" 'curl -s --max-time 10 http://127.0.0.1:8088/api/status' 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=JSON.parse(s).build;process.stdout.write(`${b.version} ${b.commit}`)}catch{}})' || true)"
  [[ -n "${SERVING}" ]] && break
done
[[ "${SERVING:-}" == "${VERSION} ${COMMIT}" ]] \
  || die "serving '${SERVING:-nothing}', expected '${VERSION} ${COMMIT}' — the bind mount is not in effect"
ok "serving ${SERVING}"
printf '  %sdone%s\n\n' "${DIM}" "${RESET}"
