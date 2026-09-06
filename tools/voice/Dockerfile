FROM alpine:3.23 AS xray
ARG TARGETARCH
RUN apk add --no-cache curl unzip \
    && case "$TARGETARCH" in \
      amd64) asset=64; digest=23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae ;; \
      arm64) asset=arm64-v8a; digest=4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c ;; \
      *) exit 1 ;; esac \
    && curl -fL --retry 3 "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-${asset}.zip" -o /tmp/xray.zip \
    && echo "$digest  /tmp/xray.zip" | sha256sum -c - \
    && unzip /tmp/xray.zip xray LICENSE -d /opt/xray && chmod 755 /opt/xray/xray
FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=xray /opt/xray/xray /usr/local/bin/xray
COPY --from=xray /opt/xray/LICENSE /usr/local/share/xray/LICENSE
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config.js store.js worker.js server.js vless.js vpn.js ./
RUN mkdir /app/data && chown -R node:node /app
USER node
ENV VOICE_DATA_DIR=/app/data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${VOICE_PORT:-7500}/health || exit 1
CMD ["node","server.js"]
