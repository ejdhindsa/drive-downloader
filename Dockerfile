FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache \
    rclone \
    aria2 \
    7zip \
    libarchive-tools \
    unzip \
    tar \
    gzip \
    xz \
    bzip2 \
    ca-certificates \
    tzdata

RUN command -v rclone && command -v aria2c && command -v unzip && command -v tar && command -v bsdtar && (command -v 7zz || command -v 7z)

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/src ./dist/src
COPY public ./public

RUN mkdir -p /app/data /tmp/staging /config/rclone && \
    chown -R 1000:1000 /app /tmp/staging /config/rclone

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV RCLONE_CONFIG=/config/rclone/rclone.conf
ENV STAGING_DIR=/tmp/staging
ENV DATA_DIR=/app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER 1000:1000

CMD ["node", "dist/src/server.js"]
