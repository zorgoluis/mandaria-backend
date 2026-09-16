FROM node:24-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN npm run build
RUN npm prune --omit=dev


FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package*.json ./

COPY --chown=node:node scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh

USER node

EXPOSE 3000

HEALTHCHECK \
  --interval=15s \
  --timeout=8s \
  --start-period=60s \
  --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "scripts/docker-entrypoint.sh"]