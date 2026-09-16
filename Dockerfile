# ---- 构建 ----
# 固定在构建机本身的架构上跑（--platform=$BUILDPLATFORM）。
# 跨架构构建 arm64 镜像时，若让这一段跟着目标架构走，npm 会在 QEMU 模拟下执行，
# 大概率直接 SIGILL（exit 132）。运行时依赖全是纯 JS，没有原生扩展，
# 所以在 amd64 上装好再拷到 arm64 镜像里是安全的。
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ src/
COPY scripts/ scripts/
RUN npm run build

# 编译完再把 node_modules 收敛成只剩运行时依赖，
# typescript / vitest / tsx 不进最终镜像
RUN npm prune --omit=dev && npm cache clean --force

# ---- 运行 ----
FROM node:22-alpine
# node:sqlite 目前仍标记为实验特性，每次启动都会打一行警告，压掉免得刷日志
ENV NODE_ENV=production TZ=Asia/Shanghai NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

COPY package*.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/

# 以非 root 运行；data/ 放状态库和 OAuth token，必须持久化
RUN adduser -D -u 10001 mailwatch \
 && mkdir -p /app/data \
 && chown -R mailwatch:mailwatch /app
USER mailwatch

VOLUME ["/app/data"]

# 查存活而非查配置：start-period 给足首轮回溯时间（可能有几百封要分诊）
HEALTHCHECK --interval=2m --timeout=20s --start-period=15m --retries=3 \
    CMD node dist/src/main.js --healthcheck || exit 1

CMD ["node", "dist/src/main.js"]
