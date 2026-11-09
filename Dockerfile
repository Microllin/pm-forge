# PMForge 镜像：多阶段构建。
#
# 为什么两阶段：前端打包那一步内存峰值约 1GB，而运行时只需要几百 MB。
# 把构建工具（vite / rolldown / typescript）留在构建阶段，运行阶段只带
# 生产依赖与已经打好的产物，2 核 4G 的机器才跑得从容。
#
# node 版本：仓库 engines 要求 >=24，这里钉 26 与 .node-version 一致。
# better-sqlite3 自带 linux-x64 预编译二进制，运行阶段不需要编译工具链。

# ── 阶段一：安装依赖 + 构建前端 ──────────────────────────────
FROM node:26-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 的预编译二进制按 Node ABI 版本发布，Node 26 还没有对应包，
# 安装时会回退到源码编译。这里补齐编译工具链；编译只发生在构建阶段，
# 最终的运行镜像里不会留下 python / gcc。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Node 26 镜像已不再自带 corepack，用 npm 装与 packageManager 一致的 pnpm
RUN npm install -g pnpm@10.34.5

# 先只拷清单：依赖没变时这层能命中缓存，改代码不用重装依赖。
# pnpm-workspace.yaml 必须一起拷——它声明了 apps/* 是工作区成员，
# 少了它 pnpm 只会装根包，子包的 vite 等依赖全都不会出现。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/chat/package.json apps/chat/
RUN pnpm install --frozen-lockfile

# 再拷源码并构建
COPY . .
RUN pnpm --filter @pmforge/chat build

# ── 阶段二：运行 ──────────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime

WORKDIR /app

# git：代码库同步功能要调它；tini 负责把容器信号转给 node，
# 否则 docker stop 要等超时才退出，supervisor 也收不到停止信号。
RUN apt-get update \
    && apt-get install -y --no-install-recommends git tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.34.5

ENV NODE_ENV=production \
    PMFORGE_CHAT_DATA_DIR=/data \
    PMFORGE_CHAT_HOST=127.0.0.1 \
    PMFORGE_CHAT_PORT=4400 \
    PMFORGE_CHAT_WEB_PORT=3200 \
    PMFORGE_CHAT_WEB_HOST=0.0.0.0

# 生产依赖 + 已构建的前端产物
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/apps/chat/package.json apps/chat/
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/chat/node_modules apps/chat/node_modules
COPY --from=build /app/apps/chat/server apps/chat/server
COPY --from=build /app/apps/chat/dist apps/chat/dist
COPY --from=build /app/apps/chat/vite.config.ts apps/chat/vite.config.ts

# 运行期数据卷：数据库、上传的文件、浏览器内核都落在这里
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3200/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# 两个进程缺一不可：
#   server —— supervisor 拉起对话服务，监听容器内 127.0.0.1:4400；
#   web    —— vite preview 托管打包产物，把 /api 反代给上面的服务。
# 只跑 web 的话页面能打开，但接口全部 502 / 空响应。
#
# 可执行文件的位置别搞混：vite 在工作区子包里（apps/chat/node_modules/.bin），
# concurrents / tsx 在仓库根。concurrently 用 -k，任一进程挂掉就一起收掉，
# 交给 docker 的 restart 策略整体重启，不留半死不活的进程。
CMD ["sh", "-c", "cd apps/chat && exec ../../node_modules/.bin/concurrently -k -n server,web -c blue,green \"../../node_modules/.bin/tsx server/supervisor.ts\" \"./node_modules/.bin/vite preview\""]
