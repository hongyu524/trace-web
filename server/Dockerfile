# ⚠️ NOT USED BY RAILWAY - DO NOT CONFIGURE RAILWAY TO USE THIS FILE ⚠️
# This file is kept for reference only. Railway uses the root-level Dockerfile.
# Pattern A: Railway rootDirectory = "." (repo root), dockerfilePath = "Dockerfile" (root)
# If you see this comment, Railway is misconfigured. Use root Dockerfile instead.

FROM node:20-bullseye

# Make apt more reliable in CI/build environments
RUN set -eux; \
  echo 'Acquire::Retries "5"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' > /etc/apt/apt.conf.d/80-retries; \
  apt-get update; \
  apt-get install -y --no-install-recommends ffmpeg ca-certificates; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
