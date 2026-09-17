# ---- Build ----
# Run the build stage on the builder architecture (--platform=$BUILDPLATFORM).
# This avoids QEMU SIGILL failures during cross-architecture npm installs.
# Runtime dependencies are pure JavaScript, so copying them across architectures is safe.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ src/
COPY scripts/ scripts/
RUN npm run build

# Keep only runtime dependencies in the final image; typescript, vitest, and tsx are omitted.
RUN npm prune --omit=dev && npm cache clean --force

# ---- Runtime ----
FROM node:22-alpine
# node:sqlite is still experimental and would print a warning on every start.
ENV NODE_ENV=production TZ=Asia/Shanghai NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

COPY package*.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/

# Run as non-root; persist data/ because it contains the state database and OAuth tokens.
RUN adduser -D -u 10001 mailwatch \
 && mkdir -p /app/data \
 && chown -R mailwatch:mailwatch /app
USER mailwatch

VOLUME ["/app/data"]

# Check liveness rather than configuration; start-period allows the first backfill to finish.
HEALTHCHECK --interval=2m --timeout=20s --start-period=15m --retries=3 \
    CMD node dist/src/main.js --healthcheck || exit 1

CMD ["node", "dist/src/main.js"]
