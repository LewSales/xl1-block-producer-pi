#!/usr/bin/env bash
# xl1-autoupdate — check the published manifest and install a newer bundle.
#
#   xl1-autoupdate.sh            check, and update if a newer release exists
#   xl1-autoupdate.sh --check    report only, change nothing
#
# Deliberately thin. Everything hard is already written:
#
#   xl1ctl update --release   downloads the release, verifies SHA256SUMS before
#                             touching a running image, tags the outgoing one for
#                             rollback, and refuses to restart if a load failed
#   xl1ctl rollback           goes back to the tagged previous image
#
# This adds only the two things that were missing: something that runs on a
# timer, and a reason not to run. Without the second, a timer re-downloads the
# same release forever.
#
# The manifest is the same shape the WinLEW APK already updates from -- a small
# JSON on winlew.co naming the current version and where to get it. One pattern
# for both, rather than a second one invented here.

set -uo pipefail

MANIFEST="${XL1_UPDATE_MANIFEST:-https://winlew.co/xl1/latest.json}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

log() { printf '%s xl1-autoupdate: %s\n' "$(date -Is)" "$*"; }

command -v jq >/dev/null 2>&1 || { log "jq is required"; exit 1; }

# Installed xl1-cli, read the same way xl1ctl reads it.
installed="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' xl1:local 2>/dev/null)"
[[ -z "${installed}" || "${installed}" == "<no value>" ]] && \
  installed="$(docker run --rm --entrypoint xl1 xl1:local --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
if [[ -z "${installed}" ]]; then
  log "cannot determine the installed xl1-cli version — refusing to update blind"
  exit 1
fi

doc="$(curl -fsS --max-time 20 --retry 2 "${MANIFEST}" 2>/dev/null)" || {
  # A manifest that cannot be fetched is not a reason to do anything. Silence
  # here means "unknown", never "up to date".
  log "could not fetch ${MANIFEST} — leaving ${installed} alone"
  exit 0
}

want="$(printf '%s' "${doc}" | jq -r '.cli // empty')"
tag="$(printf '%s' "${doc}" | jq -r '.tag // empty')"
notes="$(printf '%s' "${doc}" | jq -r '.notes // ""')"
if [[ -z "${want}" || -z "${tag}" ]]; then
  log "manifest has no cli/tag — ignoring it rather than guessing"
  exit 0
fi

# Strictly newer only. sort -V so 5.10.0 beats 5.9.0, which a string compare
# gets backwards, and equality is not an upgrade.
newest="$(printf '%s\n%s\n' "${installed}" "${want}" | sort -V | tail -n1)"
if [[ "${want}" == "${installed}" || "${newest}" != "${want}" ]]; then
  log "xl1-cli ${installed} is current (published ${want}) — nothing to do"
  exit 0
fi

log "xl1-cli ${installed} -> ${want} available as ${tag}${notes:+ (${notes})}"
if (( CHECK_ONLY )); then
  log "--check given, stopping here"
  exit 0
fi

# Hand off to the tested path rather than reimplementing download and verify.
log "running: xl1ctl update --release ${tag}"
if xl1ctl update --release "${tag}"; then
  now="$(docker run --rm --entrypoint xl1 xl1:local --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
  log "updated, now running ${now:-unknown}"
else
  # xl1ctl refuses to restart anything when a load fails, so the node is still
  # on the old image here. Say so plainly: a failed update that reads as an
  # outage sends someone hunting the wrong problem.
  log "update FAILED — still running ${installed}; roll back with: xl1ctl rollback"
  exit 1
fi
