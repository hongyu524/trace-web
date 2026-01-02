# Root-level Dockerfile for Railway Pattern A
# Build context: Repository root (.)
# This Dockerfile copies from server/ directory into container
# Railway uses this Dockerfile with rootDirectory = "." (repo root)

FROM node:20-bullseye

# Make apt more reliable in CI/build environments
RUN set -eux; \
  echo 'Acquire::Retries "5"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' > /etc/apt/apt.conf.d/80-retries; \
  apt-get update; \
  apt-get install -y --no-install-recommends ffmpeg ca-certificates; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy server package files
COPY server/package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy entire server directory contents
COPY server/ ./

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]

