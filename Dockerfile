FROM node:22-slim

# Install Google Chrome stable (NOT Debian's chromium). The Debian build evicts
# large response bodies from its network inspector cache too aggressively, which
# makes Lighthouse's MainDocumentContent gatherer error on heavy pages (e.g.
# redis.io) → the `charset` audit errors → best-practices score comes back null.
# Google Chrome stable matches local dev behaviour and doesn't hit this.
# (amd64-only package — the image is built with --platform linux/amd64 for EC2.)
RUN apt-get update && apt-get install -y wget gnupg --no-install-recommends \
  && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Skip Puppeteer's bundled Chrome download — we use the Google Chrome installed above
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

EXPOSE 3000

# Default: API server. Override CMD to run the worker:
#   docker run ... node dist/worker.js
CMD ["node", "dist/index.js"]
