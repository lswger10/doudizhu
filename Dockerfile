FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src/ ./src/
COPY scripts/doudizhu-bot-adapter.mjs ./scripts/
COPY public/ ./public/
ENV HOST=0.0.0.0 PORT=8080 DOUDIZHU_DATA_DIR=/data/doudizhu
EXPOSE 8080
CMD ["node","src/server.js"]
