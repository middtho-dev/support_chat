FROM node:22-alpine
RUN apk add --no-cache python3 py3-pip ffmpeg && python3 -m venv /opt/yt && /opt/yt/bin/pip install --no-cache-dir 'yt-dlp[default]==2026.8.19'
ENV YTDLP_PATH=/opt/yt/bin/yt-dlp NODE_ENV=production
WORKDIR /app
COPY tools/video/progress.js tools/video/config.js tools/video/download.js tools/video/server.js tools/video/store.js tools/video/worker.js tools/video/
COPY tools/voice/webhook.js tools/voice/webhook.js
RUN mkdir /app/data && chown node:node /app/data
USER node
CMD ["node", "tools/video/server.js"]
