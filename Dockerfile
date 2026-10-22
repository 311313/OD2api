FROM node:24-alpine

# node:sqlite 是内置模块，无需编译原生依赖
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# 构建期注入版本信息（由 auto-update.sh / deploy.py 传入）
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}

COPY src ./src
COPY public ./public

# 数据目录（SQLite 落在这里，由 compose 挂载）
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=7890
EXPOSE 7890

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7890)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
