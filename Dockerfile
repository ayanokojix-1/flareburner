# flareburner — containerized Cloudflare-bypass scraping API.
#
# Build:  docker build -t flareburner .
# Run:    docker run --rm -p 4001:4001 --shm-size=1g flareburner
#
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# System deps: Google Chrome (stable) + Xvfb (for the non-headless browser) +
# fonts. Chrome's own shared libraries are resolved by apt automatically.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      xvfb fonts-liberation fonts-noto-color-emoji \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first for better layer caching. --ignore-scripts
# skips native build steps (e.g. the optional `sleep` addon) so no compiler
# toolchain is needed in the image.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

# App source.
COPY index.js server.js .env.example ./

# Defaults (override with -e / docker-compose). Cloudflare needs the visible
# browser, so HEADLESS stays false; Xvfb is started automatically.
ENV NODE_ENV=production \
    PORT=4001 \
    HEADLESS=false \
    POOL_SIZE=1

EXPOSE 4001

# Liveness against the open /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
