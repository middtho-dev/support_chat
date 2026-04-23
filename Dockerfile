FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy source
COPY src/ ./src/
COPY public/ ./public/

# Create data and uploads directories
RUN mkdir -p /app/data /app/public/uploads

# Run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app

USER appuser

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/support.db
ENV UPLOADS_DIR=/app/public/uploads

EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD sh -c "wget -qO- http://localhost:${PORT:-3000}/health || exit 1"

CMD ["node", "src/server.js"]
