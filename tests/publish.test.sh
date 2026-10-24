#!/usr/bin/env bash
# xl1-publish.sh working-copy recovery, against a throwaway local repository (no network):
#   1. a normal run publishes this node's file;
#   2. a run that finds files but no usable .git (an interrupted rebuild) rebuilds in place
#      and publishes, where a clone into a non-empty directory used to fail every run;
#   3. only the newest .git.broken-* copy is kept.
#   ./tests/publish.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../scripts/xl1-publish.sh"
T="$(mktemp -d)"; trap 'rm -rf "${T}"' EXIT
FAILED=0
ok()  { printf '  ok  %s\n' "$*"; }
bad() { printf '  BAD %s\n' "$*"; FAILED=$((FAILED+1)); }

git init --quiet --bare -b main "${T}/remote.git"
git clone --quiet "${T}/remote.git" "${T}/seed" 2>/dev/null
( cd "${T}/seed" && git config user.name t && git config user.email t@t && echo seed > README && git add README && git commit --quiet -m seed && git push --quiet origin HEAD:main )

run() {
  printf '{"schema":"test","n":%s}' "$1" > "${T}/public.json"
  XL1_PUBLISH_ENV=/nonexistent XL1_PUBLISH_URL="file://${T}/public.json" XL1_PUBLISH_REPO="${T}/remote.git" \
  XL1_PUBLISH_BRANCH=main XL1_PUBLISH_PATH=xl1/test XL1_PUBLISH_WORKDIR="${T}/work" XL1_PUBLISH_PAGE='' \
  XL1_PUBLISH_LOCK="${T}/lock" bash "${SCRIPT}" >"${T}/out.$1" 2>&1
}
published() { git --git-dir="${T}/remote.git" show main:xl1/test/status.json 2>/dev/null | grep -q "\"n\":$1"; }

run 1; published 1 && ok "a normal run publishes" || { bad "a normal run did not publish"; cat "${T}/out.1"; }

# An interrupted rebuild: the files are there, .git is gone.
rm -rf "${T}/work/.git"
run 2; published 2 && ok "files without .git: rebuilt in place and published" || { bad "files without .git: not recovered"; cat "${T}/out.2"; }

# A half-built .git (initialised, no commit) is no better than none.
rm -rf "${T}/work/.git"; git init --quiet -b main "${T}/work"
run 3; published 3 && ok "an empty .git: rebuilt and published" || { bad "an empty .git: not recovered"; cat "${T}/out.3"; }

# Old broken copies: only the newest is kept.
for s in 20261001T000000Z 20261002T000000Z 20261003T000000Z; do mkdir -p "${T}/work/.git.broken-${s}"; done
run 4
left="$(cd "${T}/work" && ls -1d .git.broken-* 2>/dev/null | tr '\n' ' ')"
# (run 3 set its empty .git aside with today's stamp, so that newest one is the one kept)
[[ "$(cd "${T}/work" && ls -1d .git.broken-* | wc -l)" -eq 1 && "${left}" != *"2026100"* ]] \
  && ok "older broken copies pruned (kept ${left% })" || bad "broken copies not pruned: ${left}"
published 4 && ok "and it still publishes" || bad "run 4 did not publish"

exit "${FAILED}"
