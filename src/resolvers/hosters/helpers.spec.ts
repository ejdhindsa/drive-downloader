import { describe, expect, it } from 'vitest';
import {
  decodeHtmlEntities,
  detectCaptchaOrAntiBot,
  hostMatches,
  mergeRequestHeaders,
  normalizeHosterFilename,
  parseHumanSize,
} from './helpers';

describe('hoster resolver helpers', () => {
  it('matches hostnames case-insensitively by exact domain or subdomain', () => {
    expect(hostMatches('Pixeldrain.COM', 'pixeldrain.com')).toBe(true);
    expect(hostMatches('cdn.gofile.io', 'gofile.io')).toBe(true);
    expect(hostMatches('notpixeldrain.com', 'pixeldrain.com')).toBe(false);
  });

  it('merges default headers without overwriting user-provided headers', () => {
    const merged = mergeRequestHeaders(
      [{ name: 'user-agent', value: 'CustomUA/2.0' }],
      { 'User-Agent': 'drive-downloader/1.0', Accept: 'application/json' },
    );
    expect(merged).toEqual([
      { name: 'user-agent', value: 'CustomUA/2.0' },
      { name: 'Accept', value: 'application/json' },
    ]);
  });

  it('decodes named and numeric HTML entities', () => {
    expect(decodeHtmlEntities('A &amp; B &lt;tag&gt; &quot;hi&quot; &#39;ok&#x27; &#65;&#x42;')).toBe(
      `A & B <tag> "hi" 'ok' AB`,
    );
  });

  it('parses human-readable byte sizes across SI and IEC units', () => {
    expect(parseHumanSize('1.5 GB')).toBe(1_500_000_000);
    expect(parseHumanSize('2 GiB')).toBe(2 * 1024 ** 3);
    expect(parseHumanSize('450.5 MB')).toBe(450_500_000);
    expect(parseHumanSize('12 KiB')).toBe(12 * 1024);
    expect(parseHumanSize('512 B')).toBe(512);
    expect(parseHumanSize('unknown')).toBeUndefined();
  });

  it('normalizes filenames safely for downstream sanitizeFilename', () => {
    expect(normalizeHosterFilename('  folder/Movie: Part 1.mkv  ')).toBe('Movie- Part 1.mkv');
    expect(normalizeHosterFilename('-leading-dash.zip')).toBe('_leading-dash.zip');
    expect(normalizeHosterFilename('..')).toBeUndefined();
  });

  it('detects Cloudflare Turnstile, reCAPTCHA, and hCaptcha gates', () => {
    expect(detectCaptchaOrAntiBot('<div class="cf-turnstile"></div>')).toMatch(/Turnstile/);
    expect(detectCaptchaOrAntiBot('<script src="https://www.google.com/recaptcha/api.js"></script>')).toMatch(
      /reCAPTCHA/,
    );
    expect(detectCaptchaOrAntiBot('<div class="h-captcha"></div>')).toMatch(/hCaptcha/);
    expect(detectCaptchaOrAntiBot('<html><body>Normal page</body></html>')).toBeNull();
  });
});
