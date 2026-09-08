FROM node:20-alpine
WORKDIR /app
COPY config.js manager.js server.js installer.js ./
COPY installer ./installer
COPY public ./public
RUN mkdir /app/data && chown -R node:node /app
USER node
ENV FRP_DIR=/app/data
ENV FRP_PANEL_PORT=7400
ENV FRP_PANEL_HOST=127.0.0.1
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://${FRP_PANEL_HEALTH_HOST:-127.0.0.1}:${FRP_PANEL_PORT:-7400}/health || exit 1
CMD ["node", "server.js"]
