# Drive Downloader

Self-hosted URL-to-Google-Drive web application built with TypeScript, Fastify, Svelte 5, `aria2c`, `yt-dlp`, `7zip`, and `rclone`.

## Features

- **Staged High-Speed Mode (default):** Downloads via `aria2c -x 16 -s 16` into `/tmp/staging/<jobId>`, optionally auto-extracts single or multi-part archives (`.zip`, `.7z`, `.tar.*`, `.rar` with optional volatile archive password), moves the result straight to `gdrive:Media/...` with `rclone move`, and cleans up local staging files.
- **Direct Stream Mode:** Streams directly into Google Drive via `rclone copyurl` in memory without touching local disk.
- **Built-in No-API-Key Hoster Resolvers:** Resolves Pixeldrain (files & lists), public Google Drive links (anonymous HTTP download without linking source IDs to your Google account), Gofile folders, MediaFire, Dropbox, GitHub Releases, Hugging Face, Archive.org, Buzzheavier, and best-effort 1fichier links.
- **Webpage Link Scanner, Inspect & Pick, & Bookmarklets:** Inspects open Apache/Nginx/Caddy directory indexes and link-list pages, lets you filter, rename per item, and selectively queue links, and provides draggable browser bookmarklets (`/?inspect=...` and `#links=...`).
- **`yt-dlp` Video & Audio Integration:** Inspects playlists/videos and downloads via `yt-dlp` + `ffmpeg` with `Best MP4`, `1080p`, `720p`, `Audio MP3`, and `Audio M4A` presets.
- **Queue & Conflict Controls:** Persistent queue history (`/app/data/jobs.json`), pause/resume, priority queueing, bulk retry/cancel, search/filter, DevTools "Copy as cURL" import, and conflict policies (`skip`, `rename`, `overwrite`).
- **Multi-Target Media Refresh:** Triggers `rclone rc vfs/refresh`, Jellyfin `/Library/Refresh`, Audiobookshelf library scans, and an SSRF-validated post-upload webhook (`POST_UPLOAD_WEBHOOK_URL`).
- **Inactivity-Gated Notifications & Live Tab Progress:** Live browser tab progress (`(2) 64% — Drive Downloader`), opt-in Browser Notifications, and optional Discord / ntfy / Telegram webhooks gated by `NOTIFY_INACTIVE_SECONDS` (default 300s) so alerts only fire while you are away.
- **PWA & Mobile Share Target:** Installable web app (`manifest.webmanifest`) with `share_target` support pointing to `/?inspect=...`.
- **Hardened:** SSRF protection (blocks private/loopback/link-local IPv4 & IPv6 + DNS rebinding checks), path/filename/header sanitization, SHA-256 CSP, CSRF Origin/Referer checks, volatile in-memory secrets, and non-root execution (`PUID`/`PGID`).

## Local Development

```bash
npm install
npm --prefix web install
npm test
npm run build:all
```

## VPS Deployment Overview

1. Clone this repository to `~/drive-downloader` on your server.
2. Copy `.env.example` to `.env`, set `PUID`/`PGID`, and configure optional media refresh or notification variables (`DISCORD_WEBHOOK_URL`, `NTFY_URL`, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `AUDIOBOOKSHELF_*`, `POST_UPLOAD_WEBHOOK_URL`, `NOTIFY_INACTIVE_SECONDS`).
3. Create `data/` and `staging/` directories and run `docker compose up -d --build`.
4. Point your reverse proxy (e.g., Caddy using `Caddyfile.snippet` + `caddy hash-password`) and/or tunnel to `drive-downloader:3000`, and protect the endpoint with authentication (such as reverse-proxy basic auth and/or an identity-aware access policy).
