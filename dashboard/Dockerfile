# syntax=docker/dockerfile:1
# XL1 producer dashboard — cross-built for the Pi's arm64 CPU on a faster host.
ARG NODE_VERSION=24.14.1

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:${NODE_VERSION}-bookworm-slim
LABEL org.opencontainers.image.title="XL1 Pi Dashboard" \
  org.opencontainers.image.description="Status dashboard for an XL1 block producer on Raspberry Pi"

ENV NODE_ENV=production \
    DASH_PORT=8088 \
    DASH_BIND=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=192

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.mjs index.html ./

USER node
EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DASH_PORT||8088)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
