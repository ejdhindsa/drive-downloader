import { spawn } from 'node:child_process';
import path from 'node:path';
import { GIB, MIB } from '../consts';
import { normalizeHosterFilename } from '../resolvers/hosters/helpers';
import type { CustomHeader, JobProgress, ResolvedTarget, YtDlpFormat } from '../types';
import { attachAbortKill } from '../utils/process';
import { resolveBinary } from './extractor';

export const VALID_YTDLP_FORMATS: readonly YtDlpFormat[] = [
  'best-mp4',
  '1080p',
  '720p',
  'audio-mp3',
  'audio-m4a',
];

const MAX_PLAYLIST_ITEMS = 100;
const MAX_INSPECT_STDOUT_BYTES = 10 * MIB;

const SOUNDCLOUD_RESERVED = new Set([
  'discover',
  'stream',
  'search',
  'you',
  'upload',
  'pages',
  'terms-of-use',
  'charts',
]);

export function sanitizeYtDlpFormat(raw: string | undefined): YtDlpFormat | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if ((VALID_YTDLP_FORMATS as readonly string[]).includes(trimmed)) {
    return trimmed as YtDlpFormat;
  }
  throw new Error(`Invalid yt-dlp format preset: "${trimmed}"`);
}

export async function detectYtDlpBinary(
  pathEnv = process.env.PATH || '',
): Promise<string | null> {
  try {
    return await resolveBinary(['yt-dlp'], pathEnv);
  } catch {
    return null;
  }
}

export async function isYtDlpAvailable(
  pathEnv = process.env.PATH || '',
): Promise<boolean> {
  return (await detectYtDlpBinary(pathEnv)) !== null;
}

function stripWww(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

export function isYtDlpPlatformUrl(url: URL): boolean {
  const host = stripWww(url.hostname);
  const p = url.pathname;

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    return (
      p === '/watch' ||
      p === '/playlist' ||
      p.startsWith('/shorts/') ||
      p.startsWith('/live/') ||
      p.startsWith('/embed/')
    );
  }
  if (host === 'music.youtube.com') {
    return p === '/watch' || p === '/playlist' || p.startsWith('/browse/');
  }
  if (host === 'youtu.be') {
    return p.split('/').filter(Boolean).length >= 1;
  }
  if (host === 'vimeo.com') {
    return /^\/\d+/.test(p) || /^\/(?:video|channels|album|showcase)\//.test(p);
  }
  if (host === 'player.vimeo.com') {
    return /^\/video\/\d+/.test(p);
  }
  if (host === 'twitch.tv') {
    return /^\/videos\/\d+/.test(p) || /^\/(?:clip|[^/]+\/clip)\//.test(p);
  }
  if (host === 'clips.twitch.tv') {
    return p.split('/').filter(Boolean).length >= 1;
  }
  if (host === 'soundcloud.com') {
    const segs = p.split('/').filter(Boolean);
    return segs.length >= 2 && !SOUNDCLOUD_RESERVED.has(segs[0].toLowerCase());
  }
  if (host === 'on.soundcloud.com') {
    return p.split('/').filter(Boolean).length >= 1;
  }
  if (host.endsWith('.bandcamp.com')) {
    return /^\/(?:track|album)\//.test(p);
  }
  if (host === 'dailymotion.com') {
    return p.startsWith('/video/');
  }
  if (host === 'dai.ly') {
    return p.split('/').filter(Boolean).length >= 1;
  }
  if (host === 'bilibili.com') {
    return p.startsWith('/video/');
  }
  if (host === 'tiktok.com') {
    return /^\/@[^/]+\/video\//.test(p);
  }
  if (host === 'rumble.com') {
    return /^\/v[a-z0-9]+/i.test(p);
  }

  return false;
}

export function detectPlatformLabel(url: URL): string {
  const host = stripWww(url.hostname);
  if (host === 'music.youtube.com') return 'YouTube Music';
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') return 'YouTube';
  if (host === 'vimeo.com' || host === 'player.vimeo.com') return 'Vimeo';
  if (host === 'twitch.tv' || host === 'clips.twitch.tv') return 'Twitch';
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') return 'SoundCloud';
  if (host.endsWith('.bandcamp.com')) return 'Bandcamp';
  if (host === 'dailymotion.com' || host === 'dai.ly') return 'Dailymotion';
  if (host === 'bilibili.com') return 'Bilibili';
  if (host === 'tiktok.com') return 'TikTok';
  if (host === 'rumble.com') return 'Rumble';
  return 'yt-dlp';
}

export function isAudioPlatformUrl(url: URL): boolean {
  const host = stripWww(url.hostname);
  return (
    host === 'music.youtube.com' ||
    host === 'soundcloud.com' ||
    host === 'on.soundcloud.com' ||
    host.endsWith('.bandcamp.com')
  );
}

export function buildYtDlpInspectArgs(
  url: string,
  opts: { proxyUrl?: string; headers?: CustomHeader[] } = {},
): string[] {
  const args = ['--flat-playlist', '-J', '--no-warnings', '--no-config', '--socket-timeout', '15'];
  if (opts.proxyUrl) {
    args.push('--proxy', opts.proxyUrl);
  }
  for (const h of opts.headers ?? []) {
    args.push('--add-header', `${h.name}: ${h.value}`);
  }
  args.push('--', url);
  return args;
}

function stripMediaExtension(filename: string): string {
  return filename.replace(/\.(?:mp4|mkv|webm|mp3|m4a|opus|flac|wav|mov|avi)$/i, '');
}

export function buildYtDlpDownloadArgs(opts: {
  url: string;
  outputDir: string;
  format?: YtDlpFormat;
  customFilename?: string;
  proxyUrl?: string;
  headers?: CustomHeader[];
}): string[] {
  const format = opts.format ?? 'best-mp4';
  const args = [
    '--newline',
    '--no-warnings',
    '--no-config',
    '--no-playlist',
    '--windows-filenames',
    '-P',
    opts.outputDir,
  ];

  const stem = opts.customFilename ? stripMediaExtension(opts.customFilename.trim()) : '';
  args.push('-o', stem ? `${stem}.%(ext)s` : '%(title).180B.%(ext)s');

  switch (format) {
    case '1080p':
      args.push(
        '-f',
        'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b',
        '--merge-output-format',
        'mp4',
      );
      break;
    case '720p':
      args.push(
        '-f',
        'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b',
        '--merge-output-format',
        'mp4',
      );
      break;
    case 'audio-mp3':
      args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
      break;
    case 'audio-m4a':
      args.push(
        '-f',
        'bestaudio[ext=m4a]/bestaudio/best',
        '-x',
        '--audio-format',
        'm4a',
        '--audio-quality',
        '0',
      );
      break;
    case 'best-mp4':
    default:
      args.push(
        '-f',
        'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
        '--merge-output-format',
        'mp4',
      );
      break;
  }

  if (opts.proxyUrl) {
    args.push('--proxy', opts.proxyUrl);
  }
  for (const h of opts.headers ?? []) {
    args.push('--add-header', `${h.name}: ${h.value}`);
  }
  args.push('--', opts.url);
  return args;
}

function unitToBytes(rawValue: string, unit: string): number {
  const num = Number.parseFloat(rawValue);
  if (!Number.isFinite(num)) return 0;
  switch (unit) {
    case 'B':
      return Math.round(num);
    case 'KiB':
      return Math.round(num * 1024);
    case 'MiB':
      return Math.round(num * MIB);
    case 'GiB':
      return Math.round(num * GIB);
    case 'TiB':
      return Math.round(num * 1024 ** 4);
    case 'KB':
      return Math.round(num * 1000);
    case 'MB':
      return Math.round(num * 1000 ** 2);
    case 'GB':
      return Math.round(num * 1000 ** 3);
    case 'TB':
      return Math.round(num * 1000 ** 4);
    default:
      return Math.round(num);
  }
}

function parseClockEta(raw: string | undefined): number | null {
  if (!raw || raw.toLowerCase() === 'unknown') return null;
  const parts = raw.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function parseYtDlpProgressLine(line: string): JobProgress | null {
  if (!line.includes('[download]')) return null;
  const match = line.match(
    /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+)(TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)(?:.*?\bat\s+(?:([\d.]+)(TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)\/s|Unknown(?:\s+B\/s)?))?(?:.*?\bETA\s+((?:\d+:)?\d+:\d+|Unknown))?/,
  );
  if (!match) return null;

  const percent = Math.min(100, Number.parseFloat(match[1]));
  const bytesTotal = unitToBytes(match[2], match[3]);
  const bytesDone = Math.round((percent / 100) * bytesTotal);
  const speedBytesPerSec = match[4] && match[5] ? unitToBytes(match[4], match[5]) : 0;
  const etaSeconds = match[6] ? parseClockEta(match[6]) : percent >= 100 ? 0 : null;

  return {
    percent: Number.isFinite(percent) ? percent : 0,
    bytesDone,
    bytesTotal,
    speedBytesPerSec,
    etaSeconds,
  };
}

interface YtDlpJsonEntry {
  _type?: string;
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  ext?: string;
  filesize?: number;
  filesize_approx?: number;
  duration?: number;
  ie_key?: string;
  extractor?: string;
  availability?: string;
  entries?: Array<YtDlpJsonEntry | null>;
}

function formatDurationNote(seconds: number | undefined): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function resolveEntryUrl(entry: YtDlpJsonEntry, sourceUrl: URL): string | null {
  if (entry.webpage_url && /^https?:\/\//i.test(entry.webpage_url)) {
    return entry.webpage_url;
  }
  if (entry.url && /^https?:\/\//i.test(entry.url)) {
    return entry.url;
  }
  if (entry.id && (entry.ie_key === 'Youtube' || detectPlatformLabel(sourceUrl).startsWith('YouTube'))) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(entry.id)}`;
  }
  return null;
}

function entryToResolvedTarget(
  entry: YtDlpJsonEntry,
  sourceUrl: URL,
  downloadUrl: string,
): ResolvedTarget {
  const targetUrlObj = (() => {
    try {
      return new URL(downloadUrl);
    } catch {
      return sourceUrl;
    }
  })();

  const audio = isAudioPlatformUrl(targetUrlObj);
  const ext = entry.ext?.trim() || (audio ? 'm4a' : 'mp4');
  const safeBase = normalizeHosterFilename(entry.title || entry.id);
  const filename = safeBase
    ? safeBase.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
      ? safeBase
      : `${safeBase}.${ext}`
    : undefined;

  const sizeRaw =
    typeof entry.filesize === 'number' && entry.filesize > 0
      ? entry.filesize
      : typeof entry.filesize_approx === 'number' && entry.filesize_approx > 0
        ? entry.filesize_approx
        : undefined;

  const durationStr = formatDurationNote(entry.duration);

  return {
    downloadUrl,
    filename,
    sizeBytes: sizeRaw ? Math.round(sizeRaw) : undefined,
    sourceUrl: sourceUrl.toString(),
    hoster: detectPlatformLabel(targetUrlObj),
    category: audio ? 'audio' : 'video',
    engine: 'yt-dlp',
    note: durationStr ? `Duration ${durationStr} · yt-dlp` : 'yt-dlp media stream',
  };
}

export function parseYtDlpInspectJson(
  rawJson: string,
  sourceUrl: URL,
): { items: ResolvedTarget[]; warnings: string[] } {
  let data: YtDlpJsonEntry;
  try {
    data = JSON.parse(rawJson) as YtDlpJsonEntry;
  } catch {
    throw new Error('yt-dlp returned invalid metadata JSON');
  }

  const warnings: string[] = [];

  if (data._type === 'playlist' || Array.isArray(data.entries)) {
    const entries = data.entries ?? [];
    const items: ResolvedTarget[] = [];

    for (const entry of entries) {
      if (!entry) {
        warnings.push('Skipped unavailable playlist item');
        continue;
      }
      if (entry.availability === 'private' || entry.availability === 'needs_auth') {
        warnings.push(`Skipped restricted item: ${entry.title || entry.id || 'unknown'}`);
        continue;
      }
      if (items.length >= MAX_PLAYLIST_ITEMS) {
        warnings.push(`Playlist capped at ${MAX_PLAYLIST_ITEMS} items`);
        break;
      }
      const entryUrl = resolveEntryUrl(entry, sourceUrl);
      if (!entryUrl) {
        warnings.push(`Skipped entry without playable URL: ${entry.title || entry.id || 'unknown'}`);
        continue;
      }
      items.push(entryToResolvedTarget(entry, sourceUrl, entryUrl));
    }

    if (items.length === 0) {
      throw new Error('Playlist contains no downloadable media items');
    }

    return { items, warnings };
  }

  const singleUrl = resolveEntryUrl(data, sourceUrl) ?? sourceUrl.toString();
  return {
    items: [entryToResolvedTarget(data, sourceUrl, singleUrl)],
    warnings,
  };
}

export async function inspectWithYtDlp(
  url: URL,
  opts: {
    signal: AbortSignal;
    proxyUrl?: string;
    headers?: CustomHeader[];
    binaryPath?: string;
  },
): Promise<{ items: ResolvedTarget[]; warnings: string[] }> {
  const binary = opts.binaryPath ?? (await detectYtDlpBinary());
  if (!binary) {
    throw new Error(
      'yt-dlp is not installed on this server (install yt-dlp and ffmpeg to download from video/audio platforms)',
    );
  }

  const args = buildYtDlpInspectArgs(url.toString(), {
    proxyUrl: opts.proxyUrl,
    headers: opts.headers,
  });

  const stdout = await new Promise<string>((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }

    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const abortHandle = attachAbortKill(child, opts.signal);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderrTail = '';

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_INSPECT_STDOUT_BYTES) {
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    child.on('error', (err) => {
      abortHandle.cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      abortHandle.cleanup();
      if (abortHandle.wasAborted() || opts.signal.aborted) {
        reject(new Error('Cancelled'));
        return;
      }
      if (totalBytes > MAX_INSPECT_STDOUT_BYTES) {
        reject(new Error('yt-dlp metadata output exceeded maximum allowed size'));
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        const lastErr = stderrTail.trim().split(/\r?\n/).pop();
        reject(new Error(lastErr || `yt-dlp inspect exited with code ${code ?? 'unknown'}`));
      }
    });
  });

  return parseYtDlpInspectJson(stdout, url);
}

export async function runYtDlpDownload(
  opts: {
    url: string;
    outputDir: string;
    format?: YtDlpFormat;
    customFilename?: string;
    proxyUrl?: string;
    headers?: CustomHeader[];
    binaryPath?: string;
  },
  callbacks: {
    signal: AbortSignal;
    onProgress: (progress: JobProgress) => void;
    onLog: (line: string) => void;
    onFilename?: (filename: string) => void;
  },
): Promise<void> {
  const binary = opts.binaryPath ?? (await detectYtDlpBinary());
  if (!binary) {
    throw new Error(
      'yt-dlp is not installed on this server (install yt-dlp and ffmpeg to download from video/audio platforms)',
    );
  }

  const args = buildYtDlpDownloadArgs(opts);

  await new Promise<void>((resolve, reject) => {
    if (callbacks.signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }

    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const abortHandle = attachAbortKill(child, callbacks.signal);
    let lastError = '';
    let buffer = '';

    const handleChunk = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/[\r\n]+/);
      buffer = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        const progress = parseYtDlpProgressLine(line);
        if (progress) {
          callbacks.onProgress(progress);
          continue;
        }

        const destMatch = /^\[download\]\s+Destination:\s+(.+)$/.exec(line);
        if (destMatch) {
          const name = path.basename(destMatch[1].trim());
          callbacks.onFilename?.(name);
          callbacks.onLog(`[yt-dlp] Downloading ${name}`);
          continue;
        }

        const mergeMatch =
          /^\[(?:Merger|ExtractAudio)\]\s+(?:Merging formats into|Destination:)\s+"?(.+?)"?$/.exec(
            line,
          );
        if (mergeMatch) {
          const name = path.basename(mergeMatch[1].trim());
          callbacks.onFilename?.(name);
          callbacks.onLog(`[yt-dlp] Output ${name}`);
          continue;
        }

        if (line.startsWith('ERROR:')) {
          lastError = line.slice('ERROR:'.length).trim();
          callbacks.onLog(`[yt-dlp] ${line}`);
        }
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('error', (err) => {
      abortHandle.cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      abortHandle.cleanup();
      if (abortHandle.wasAborted() || callbacks.signal.aborted) {
        reject(new Error('Cancelled'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(lastError || `yt-dlp exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}
