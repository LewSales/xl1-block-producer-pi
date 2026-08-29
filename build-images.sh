#!/usr/bin/env bash
# Cross-build both arm64 images on a workstation and emit the tarballs that
# provision.sh loads on the Pi.
#
# Run this on an amd64 machine with Docker and buildx — not on the Pi. That is
# the point: `npm install -g @xyo-network/xl1-cli` on a 1 GB Pi 3 is slow enough
# to be its own failure mode, and a laptop does it in about 80 seconds.
#
#   ./build-images.sh
#   XL1_CLI_VERSION=5.2.4 ./build-images.sh      # pin an older one
#
# Produces xl1-local-arm64.tar.gz and xl1-dashboard-arm64.tar.gz alongside this
# script. They are gitignored — they are build artifacts, and each exceeds
# GitHub's 100 MB per-file limit.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${HERE}/.build"
XL1_CLI_VERSION="${XL1_CLI_VERSION:-5.3.0}"
NODE_VERSION="${NODE_VERSION:-24.14.1}"
UPSTREAM="${UPSTREAM:-https://github.com/XYOracleNetwork/xl1-docker-images.git}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"

log() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found"
docker buildx version >/dev/null 2>&1 || die "docker buildx not available"

if ! docker buildx ls | grep -q 'linux/arm64'; then
  die "this Docker cannot build linux/arm64.
    Enable QEMU emulation first:  docker run --privileged --rm tonistiigi/binfmt --install arm64"
fi

# ---------------------------------------------------------- producer image

log "Producer image (xl1-cli ${XL1_CLI_VERSION})"

mkdir -p "${WORK}"
if [[ -d "${WORK}/xl1-docker-images/.git" ]]; then
  git -C "${WORK}/xl1-docker-images" fetch --depth 1 origin "${UPSTREAM_REF}"
  git -C "${WORK}/xl1-docker-images" reset --hard "origin/${UPSTREAM_REF}"
  git -C "${WORK}/xl1-docker-images" clean -fd
else
  git clone --depth 1 --branch "${UPSTREAM_REF}" "${UPSTREAM}" "${WORK}/xl1-docker-images"
fi

pushd "${WORK}/xl1-docker-images" >/dev/null

# The image COPYs dist/node — the preset entrypoint — so it has to be compiled
# first. This is plain TypeScript output, no native build, and it is why the Pi
# never needs the pnpm toolchain.
command -v pnpm >/dev/null || die "pnpm not found — needed to compile the entrypoint (npm i -g pnpm)"
pnpm install --frozen-lockfile
pnpm xy compile
[[ -f dist/node/entrypoint.mjs ]] || die "entrypoint did not compile"

docker build --platform linux/arm64 \
  -f docker/Dockerfile \
  --build-arg "NODE_VERSION=${NODE_VERSION}" \
  --build-arg "XL1_CLI_VERSION=${XL1_CLI_VERSION}" \
  -t xl1:local-arm64 .

popd >/dev/null

# --------------------------------------------------------- dashboard image

log "Dashboard image"
docker build --platform linux/arm64 -t xl1-dashboard:local-arm64 "${HERE}/dashboard"

# ------------------------------------------------------------------ export

log "Exporting tarballs"
docker save xl1:local-arm64           | gzip -1 > "${HERE}/xl1-local-arm64.tar.gz"
docker save xl1-dashboard:local-arm64 | gzip -1 > "${HERE}/xl1-dashboard-arm64.tar.gz"

log "Verifying"
docker run --rm --platform linux/arm64 --entrypoint xl1 xl1:local-arm64 --version \
  | sed 's/^/    xl1 /'

ls -lh "${HERE}"/*.tar.gz | sed 's/^/    /'

cat <<EOF

    Both images built for linux/arm64.

    Copy this whole directory to the Pi, then:  sudo ./provision.sh

EOF
