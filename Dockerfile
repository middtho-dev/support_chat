FROM node:20-alpine

WORKDIR /app

# Install dependencies from the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/
COPY public/ ./public/

# Create data, uploads and backup directories
RUN mkdir -p /app/data /app/public/uploads /app/backups

# Run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app

USER appuser

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/support.db
ENV UPLOADS_DIR=/app/public/uploads
ENV BACKUP_DIR=/app/backups

EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD sh -c "wget -qO- http://localhost:${PORT:-3000}/health || exit 1"

CMD ["node", "src/server.js"]
