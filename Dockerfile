FROM node:22-slim

# Chrome dependencies for Puppeteer's bundled Chrome (Chrome for Testing).
# We let Puppeteer download its OWN version-matched Chrome (no PUPPETEER_SKIP_DOWNLOAD,
# no system chromium) — Debian's chromium drifts ahead of Puppeteer and breaks launch.
# `unzip` is required to extract the Chrome download; ca-certificates for the fetch.
RUN apt-get update && apt-get install -y \
  ca-certificates unzip fonts-liberation \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2 \
  libnspr4 libglib2.0-0 libcairo2 libpango-1.0-0 \
  libdbus-1-3 libexpat1 libx11-6 libxcb1 libxext6 \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# patches/ must be present BEFORE npm ci: npm ci runs the postinstall (patch-package),
# which applies patches/lighthouse+13.4.0.patch (raises Chrome's network buffer).
COPY patches ./patches
# npm ci also triggers Puppeteer's download of the pinned Chrome for Testing +
# chrome-headless-shell (matched to the Puppeteer version) — the launchable browser.
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

EXPOSE 3000

# Default: API server. Override CMD to run the worker:
#   docker run ... node dist/worker.js
CMD ["node", "dist/index.js"]
