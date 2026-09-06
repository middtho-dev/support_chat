FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY config.js store.js worker.js server.js ./
RUN mkdir /app/data && chown -R node:node /app
USER node
ENV VOICE_DATA_DIR=/app/data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${VOICE_PORT:-7500}/health || exit 1
CMD ["node","server.js"]
