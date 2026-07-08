FROM node:22-slim

# Install Chromium — Puppeteer will use this instead of downloading its own Chrome bundle
RUN apt-get update && apt-get install -y \
  chromium \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Skip Puppeteer's bundled Chrome download — we use system Chromium installed above
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3000

# Default: API server. Override CMD to run the worker:
#   docker run ... node dist/worker.js
CMD ["node", "dist/index.js"]
