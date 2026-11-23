# ---- Build ----
# Run the build stage on the builder architecture (--platform=$BUILDPLATFORM).
# This avoids QEMU SIGILL failures during cross-architecture npm installs.
# Runtime dependencies are pure JavaScript, so copying them across architectures is safe.
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ src/
COPY scripts/ scripts/
RUN npm run build

# Keep only runtime dependencies in the final image; typescript, vitest, and tsx are omitted.
RUN npm prune --omit=dev && npm cache clean --force

# ---- Runtime ----
FROM node:26-alpine
ARG MAILSIFT_VERSION=dev
# node:sqlite is still experimental and would print a warning on every start.
# Everything else is configured in the web view and stored in the volumes below.
# MCP_BIND=0.0.0.0 lets Docker's port forwarding reach the service; compose
# publishes the port on the host's loopback only.
ENV NODE_ENV=production TZ=Asia/Shanghai NODE_OPTIONS="--disable-warning=ExperimentalWarning --dns-result-order=ipv4first" \
    MAILSIFT_VERSION=$MAILSIFT_VERSION MCP_BIND=0.0.0.0 MCP_PORT=8410 \
    STATE_DB_PATH=/app/data/mailsift.db MAILSIFT_KEY_FILE=/app/secrets/mailsift.key
WORKDIR /app

COPY package*.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/

# Run as non-root. data/ holds the database (settings, encrypted credentials,
# triage records); secrets/ holds the key the credentials are encrypted with.
RUN adduser -D -u 10001 mailsift \
 && mkdir -p /app/data /app/secrets \
 && chown -R mailsift:mailsift /app \
 && chmod 700 /app/data /app/secrets
USER mailsift

VOLUME ["/app/data", "/app/secrets"]
EXPOSE 8410

# Asks the running service; waiting for setup counts as healthy.
HEALTHCHECK --interval=1m --timeout=15s --start-period=30s --retries=3 \
    CMD node dist/src/main.js --healthcheck || exit 1

# The supervisor restarts the service when settings saved in the web view need it.
CMD ["node", "dist/src/server.js"]
