FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ && npm ci --omit=dev && apk del .build-deps
COPY *.js ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
CMD ["node", "server.js"]
