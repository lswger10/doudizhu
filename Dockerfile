FROM node:24-alpine
RUN apk add --no-cache bash tini ca-certificates \
    && wget -q https://github.com/openai/tunnel-client/releases/download/v0.0.14/tunnel-client-v0.0.14-linux-amd64.zip -O /tmp/tunnel.zip \
    && echo '15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3  /tmp/tunnel.zip' | sha256sum -c - \
    && mkdir /opt/tunnel-client \
    && unzip -q /tmp/tunnel.zip -d /opt/tunnel-client \
    && rm /tmp/tunnel.zip
ENV PATH="/opt/tunnel-client:${PATH}"
RUN tunnel-client --version && cloudflared --version
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src/ ./src/
COPY scripts/doudizhu-bot-adapter.mjs ./scripts/
COPY scripts/start-container.sh scripts/test-container.sh ./scripts/
RUN bash -n scripts/start-container.sh && bash scripts/test-container.sh
COPY public/ ./public/
ENV HOST=0.0.0.0 PORT=8080 DOUDIZHU_DATA_DIR=/data/doudizhu
EXPOSE 8080
ENTRYPOINT ["/sbin/tini","-g","--"]
CMD ["bash","scripts/start-container.sh"]
