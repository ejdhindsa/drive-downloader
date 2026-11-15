# Drive Downloader

Self-hosted URL-to-Google-Drive web application built with TypeScript, Fastify, `aria2c`, and `rclone`.

## Features

- **Staged High-Speed Mode (default):** Downloads via `aria2c -x 16 -s 16` into `/tmp/staging/<jobId>`, optionally auto-extracts archives (`.zip`, `.7z`, `.tar.*`, `.rar`), moves the result straight to `gdrive:Media/...` with `rclone move`, and deletes local staging files.
- **Direct Stream Mode:** Streams directly into Google Drive via `rclone copyurl` in memory without touching the VPS disk.
- **Multi-URL Batch Queue:** Paste multiple URLs (one per line) with persistent queue history (`/app/data/jobs.json`), Cancel, Retry, and live Server-Sent Events (`/api/events`).
- **Dynamic Drive Folders:** Lists top-level and nested folders from `gdrive:Media` via `rclone lsf --dirs-only`.
- **Optional Jellyfin / VFS Refresh:** Triggers `rclone rc vfs/refresh` and/or Jellyfin `/Library/Refresh` after uploads complete.
- **Hardened:** SSRF protection (blocks private/loopback/link-local IPv4 & IPv6 + DNS rebinding checks), path/filename/header sanitization, and non-root execution (`PUID`/`PGID`).

## Local Development

```bash
npm install
npm test
npm run build
```

## VPS Deployment Overview

1. Clone this repository to `~/drive-downloader` on your server.
2. Copy `.env.example` to `.env` and verify `PUID`/`PGID` with `id`.
3. Create `data/` and `staging/` directories and run `docker compose up -d --build`.
4. Point your reverse proxy (e.g., Caddy using `Caddyfile.snippet` + `caddy hash-password`) and/or tunnel to `drive-downloader:3000`, and protect the endpoint with authentication (such as reverse-proxy basic auth and/or an identity-aware access policy).
