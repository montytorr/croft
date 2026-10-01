# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# --- dependencies ----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# --- build -----------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules

# Declared before `COPY . .` so that changing the SHA busts only the layers
# below it, leaving the dependency layers cached.
ARG GIT_SHA=unknown
COPY . .
RUN echo "$GIT_SHA" > public/build-version.txt || (mkdir -p public && echo "$GIT_SHA" > public/build-version.txt)
# When, so a CLI whose fingerprint disagrees can tell which side is newer:
# its own mtime against this (CROFT-290). Below `COPY . .`, so it is rebuilt
# with every source change rather than cached from the first build.
RUN date -u +%Y-%m-%dT%H:%M:%SZ > public/build-time.txt
# The fingerprint of the CLI this image was built beside, so a copied
# ~/.local/bin/croft can tell whether it is the current file rather than
# whether it belongs to the current release — 133 commits fitted inside
# v0.5.1, so the version answers almost nothing (CROFT-261). Written here
# because the standalone build does not trace `cli/`, and into public/ because
# that directory is already carried into the runtime image.
RUN node -e "const{createHash}=require('node:crypto'),{readFileSync,writeFileSync}=require('node:fs');writeFileSync('public/cli-hash.txt',createHash('sha256').update(readFileSync('cli/croft.mjs')).digest('hex').slice(0,16))"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- migrations ------------------------------------------------------------
FROM base AS migrator
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY migrations ./migrations
CMD ["node", "scripts/migrate.mjs"]

# --- runtime ---------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# -G nodejs matters: busybox adduser defaults the primary group to `nogroup`,
# so without it the group created on the line before has no members, the
# --chown=nextjs:nodejs below sets a group the process is not in, and every
# group permission bit in the image is inert. Owner permissions carried it, so
# nothing failed — it just made "make it group-writable" a plausible fix that
# could never work.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Next 16 standalone still reads this metadata from the root .next at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/.next/required-server-files.json ./.next/
# Migrations and the first administrator, for a platform that cannot run the
# `migrator` target as a one-off (scripts/start.mjs; off unless asked for), and
# the operator's break-glass reset link (scripts/reset-password.mjs).
# pg and bcryptjs are already in the standalone node_modules: the server uses both.
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts/start.mjs /app/scripts/migrate.mjs /app/scripts/create-operator.mjs /app/scripts/reset-password.mjs ./scripts/

# Amazon RDS's certificate authorities, so a verified TLS connection to a
# managed database needs only NODE_EXTRA_CA_CERTS pointing here and
# `sslmode=verify-full` in DATABASE_URL. Node trusts nothing extra by default.
# Fetched at build time like the npm packages above; unused, and harmless,
# on a deployment that talks to its own Postgres container.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

CMD ["node", "scripts/start.mjs"]
