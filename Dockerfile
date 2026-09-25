# syntax=docker/dockerfile:1.7
# Image de production Parc Auto : une étape de construction commune, puis une cible par rôle
# (api, worker, web, migrate). Versions épinglées par empreinte ; aucune balise « latest ».
# Construction : docker compose -f docker-compose.prod.yml build

ARG NODE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
# Proxy d'entreprise facultatif : HTTPS_PROXY en argument de construction (non conservé dans l'image) et
# autorité de certification en secret BuildKit « extra_ca » (jamais copiée dans une couche).
# NODE_USE_ENV_PROXY=1 fait lire HTTPS_PROXY au fetch de Node (corepack) ; sans proxy, il est sans effet.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && export NODE_USE_ENV_PROXY=1 \
 && corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

# --- Construction ---------------------------------------------------------------
FROM base AS build
COPY . .
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile \
 && pnpm --filter @parc-auto/web build \
 && node scripts/tests/check-secrets.mjs --bundle-only --require-bundle \
 && pnpm --filter @parc-auto/worker build \
 && mkdir -p /out/web \
 && cp -r apps/web/.next/standalone/. /out/web/ \
 && mkdir -p /out/web/apps/web/.next \
 && cp -r apps/web/.next/static /out/web/apps/web/.next/static \
 && if [ -d apps/web/public ]; then cp -r apps/web/public /out/web/apps/web/public; fi

# --- Exécution : utilisateur non privilégié, NODE_ENV=production -----------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# /data/storage existe dans l'image avec le bon propriétaire : un volume nommé neuf en hérite,
# ce qui permet à l'utilisateur non privilégié d'écrire les pièces jointes.
RUN addgroup -S parcauto && adduser -S parcauto -G parcauto \
 && mkdir -p /data/storage && chown -R parcauto:parcauto /data
WORKDIR /app

FROM runtime AS api
COPY --from=build --chown=parcauto:parcauto /app /app
USER parcauto
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3001/api/v1/health/live >/dev/null || exit 1
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=parcauto:parcauto /app /app
USER parcauto
CMD ["node", "apps/worker/dist/main.js"]

# Migrations explicites (CDC 16.3) : docker compose -f docker-compose.prod.yml run --rm migrate
FROM runtime AS migrate
COPY --from=build --chown=parcauto:parcauto /app /app
USER parcauto
WORKDIR /app/packages/db
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM runtime AS web
COPY --from=build --chown=parcauto:parcauto /out/web /app
USER parcauto
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
