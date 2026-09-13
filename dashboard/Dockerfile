# syntax=docker/dockerfile:1
# XL1 producer dashboard — cross-built for the Pi's arm64 CPU on a faster host.
ARG NODE_VERSION=24.14.1

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
# A cache mount rather than a plain install: package.json changes on every
# version bump, which invalidates this layer and re-downloads the whole SDK.
# The cache lives outside the image, so nothing is added to the layer and the
# `npm cache clean` this used to end with would only throw away the thing that
# makes the next build survive a bad connection.
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim
LABEL org.opencontainers.image.title="XL1 Pi Dashboard" \
  org.opencontainers.image.description="Status dashboard for an XL1 block producer on Raspberry Pi"

# Build stamp. Passed at build time so the running page can say which build it
# is — "xl1-dashboard:local" is the same tag before and after every deploy, and
# without this there is no way to tell a redeploy landed except by watching a
# number change and hoping. Defaults keep an argument-less `docker build`
# working; build-images.sh and Build.ps1 fill them in.
ARG DASH_COMMIT=unknown
ARG DASH_BUILT_AT=unknown
ENV NODE_ENV=production \
    DASH_PORT=8088 \
    DASH_BIND=0.0.0.0 \
    DASH_COMMIT=${DASH_COMMIT} \
    DASH_BUILT_AT=${DASH_BUILT_AT} \
    NODE_OPTIONS=--max-old-space-size=192

LABEL org.opencontainers.image.revision="${DASH_COMMIT}" \
      org.opencontainers.image.created="${DASH_BUILT_AT}"

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.mjs index.html ./

USER node
EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DASH_PORT||8088)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
