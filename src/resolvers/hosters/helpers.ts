import path from 'node:path';
import type { CustomHeader, ResolvedTarget } from '../../types';
import { directResolver } from '../direct';
import type { ResolverContext } from '../types';

export const DEFAULT_USER_AGENT = 'drive-downloader/1.0';

export function hostMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const target = domain.toLowerCase();
  return host === target || host.endsWith(`.${target}`);
}

export function mergeRequestHeaders(
  base: CustomHeader[],
  defaults: Record<string, string>,
): CustomHeader[] {
  const seen = new Set(base.map((h) => h.name.toLowerCase()));
  const merged = [...base];
  for (const [name, value] of Object.entries(defaults)) {
    if (!seen.has(name.toLowerCase())) {
      merged.push({ name, value });
      seen.add(name.toLowerCase());
    }
  }
  return merged;
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

const UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
};

export function parseHumanSize(raw: string): number | undefined {
  const match = /([\d.,]+)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)\b/i.exec(raw);
  if (!match) return undefined;
  const num = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const multiplier = UNIT_MULTIPLIERS[match[2].toLowerCase()];
  if (!multiplier) return undefined;
  return Math.round(num * multiplier);
}

export function normalizeHosterFilename(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return undefined;
  const base = path.posix.basename(trimmed.replace(/\\/g, '/'));
  let safe = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/:/g, '-').trim();
  if (!safe || safe === '.' || safe === '..') return undefined;
  if (safe.startsWith('-')) {
    safe = `_${safe.slice(1)}`;
  }
  return safe;
}

export function detectCaptchaOrAntiBot(html: string): string | null {
  const lower = html.toLowerCase();
  if (
    lower.includes('challenges.cloudflare.com/turnstile') ||
    lower.includes('cf-turnstile') ||
    (lower.includes('just a moment...') && lower.includes('cf-chl'))
  ) {
    return 'Cloudflare Turnstile / anti-bot challenge is active';
  }
  if (lower.includes('google.com/recaptcha') || lower.includes('g-recaptcha')) {
    return 'reCAPTCHA verification is required';
  }
  if (lower.includes('hcaptcha.com') || lower.includes('h-captcha')) {
    return 'hCaptcha verification is required';
  }
  return null;
}

export async function probeDirectMetadata(
  downloadUrl: URL,
  sourceUrl: URL,
  hoster: string,
  ctx: ResolverContext,
  extraHeaders?: CustomHeader[],
): Promise<ResolvedTarget> {
  const probeHeaders = extraHeaders
    ? mergeRequestHeaders(
        ctx.headers,
        Object.fromEntries(extraHeaders.map((h) => [h.name, h.value])),
      )
    : ctx.headers;

  const result = await directResolver.resolve(downloadUrl, {
    ...ctx,
    headers: probeHeaders,
  });
  const base = result.items[0];
  return {
    ...base,
    sourceUrl: sourceUrl.toString(),
    hoster,
    headers: extraHeaders && extraHeaders.length > 0 ? extraHeaders : undefined,
  };
}
