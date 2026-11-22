import { describe, expect, it } from 'vitest';
import {
  isPrivateOrReservedIp,
  isSensitiveHeaderName,
  readBoundedText,
  redactHeaders,
  redactJobForOutput,
  redactProxyUrl,
  resolveSafeUrl,
  safeFetch,
  sanitizeFilename,
  sanitizeFolderName,
  sanitizeHeaders,
  sanitizeRelativePath,
  validateProxyUrl,
  validatePublicUrl,
} from './security';
import type { Job } from '../types';

describe('IP & URL SSRF validation', () => {
  it('blocks loopback, RFC1918, CGNAT, link-local, and IPv6 private ranges', () => {
    const blocked = [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
    ];
    for (const ip of blocked) {
      expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be blocked`).toBe(true);
    }

    const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111'];
    for (const ip of allowed) {
      expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be allowed`).toBe(false);
    }
  });

  it('blocks unsafe schemes, internal hostnames, and private DNS resolutions', async () => {
    const publicDns = async () => [{ address: '93.184.216.34' }];
    const privateDns = async () => [{ address: '192.168.1.10' }];

    const valid = await validatePublicUrl('https://cdn.example.com/file.mkv', publicDns);
    expect(valid.hostname).toBe('cdn.example.com');

    await expect(validatePublicUrl('file:///etc/passwd', publicDns)).rejects.toThrow(/Unsupported protocol/);
    await expect(validatePublicUrl('ftp://example.com/a.zip', publicDns)).rejects.toThrow(/Unsupported protocol/);
    await expect(validatePublicUrl('http://localhost:8080/x', publicDns)).rejects.toThrow(/Blocked internal hostname/);
    await expect(validatePublicUrl('http://jellyfin.internal/x', publicDns)).rejects.toThrow(/Blocked internal hostname/);
    await expect(validatePublicUrl('http://127.0.0.1/test', publicDns)).rejects.toThrow(/Blocked private/);
    await expect(validatePublicUrl('https://rebind.example.com/x', privateDns)).rejects.toThrow(/resolved to blocked IP/);
  });
});

describe('path, filename, header, and proxy sanitizers', () => {
  it('rejects traversal and flag injection in folders, paths, filenames, and headers', () => {
    expect(sanitizeFolderName('Movies')).toBe('Movies');
    expect(sanitizeFolderName('TVShows')).toBe('TVShows');
    expect(() => sanitizeFolderName('Movies/Sub')).toThrow(/single valid folder/);
    expect(() => sanitizeFolderName('..')).toThrow(/Invalid path segment/);

    expect(sanitizeRelativePath('Chernobyl (2019)/Season 01/')).toBe('Chernobyl (2019)/Season 01');
    expect(() => sanitizeRelativePath('Show/../Secret')).toThrow(/Invalid path segment/);
    expect(() => sanitizeRelativePath('-rf')).toThrow(/Invalid path segment/);

    expect(sanitizeFilename('Movie.2025.mkv')).toBe('Movie.2025.mkv');
    expect(() => sanitizeFilename('sub/Movie.mkv')).toThrow(/cannot contain "\/"/);
    expect(() => sanitizeFilename('..')).toThrow(/Invalid path segment/);

    expect(sanitizeHeaders([{ name: 'Referer', value: 'https://site.test/' }])).toEqual([
      { name: 'Referer', value: 'https://site.test/' },
    ]);
    expect(() => sanitizeHeaders([{ name: 'Bad Header', value: 'x' }])).toThrow(/Invalid HTTP header name/);
    expect(() => sanitizeHeaders([{ name: 'Cookie', value: 'a=1\r\nX-Injected: 2' }])).toThrow(
      /Invalid HTTP header value/,
    );
  });

  it('validates and redacts DOWNLOAD_PROXY URLs', () => {
    expect(validateProxyUrl('')).toBe('');
    expect(validateProxyUrl(undefined)).toBe('');
    expect(validateProxyUrl('http://gluetun:8888/')).toBe('http://gluetun:8888');
    expect(validateProxyUrl('https://user:pass@proxy.local:8443')).toBe('https://user:pass@proxy.local:8443');
    expect(() => validateProxyUrl('socks5://gluetun:1080')).toThrow(/Unsupported DOWNLOAD_PROXY protocol/);
    expect(() => validateProxyUrl('http://bad proxy:8888')).toThrow(/invalid whitespace/);

    expect(redactProxyUrl('http://user:s3cr3t@gluetun:8888')).toBe('http://***:***@gluetun:8888');
    expect(redactProxyUrl('http://gluetun:8888')).toBe('http://gluetun:8888');
  });

  it('redacts sensitive HTTP headers without touching benign headers', () => {
    expect(isSensitiveHeaderName('Cookie')).toBe(true);
    expect(isSensitiveHeaderName('Authorization')).toBe(true);
    expect(isSensitiveHeaderName('X-Api-Key')).toBe(true);
    expect(isSensitiveHeaderName('Referer')).toBe(false);
    expect(isSensitiveHeaderName('User-Agent')).toBe(false);

    const headers = [
      { name: 'Referer', value: 'https://example.com/' },
      { name: 'Cookie', value: 'session=topsecret' },
      { name: 'Authorization', value: 'Bearer abc123' },
    ];
    expect(redactHeaders(headers)).toEqual([
      { name: 'Referer', value: 'https://example.com/' },
      { name: 'Cookie', value: '[REDACTED]' },
      { name: 'Authorization', value: '[REDACTED]' },
    ]);

    const job: Job = {
      id: 'j1',
      url: 'https://example.com/a.mkv',
      folder: 'Movies',
      subfolder: '',
      destinationRemote: 'gdrive:Media/Movies',
      mode: 'staged',
      autoExtract: false,
      autoRefreshJellyfin: false,
      headers,
      status: 'queued',
      phaseLabel: 'Queued',
      progress: { percent: 0, bytesDone: 0, bytesTotal: 0, speedBytesPerSec: 0, etaSeconds: null },
      logs: [],
      createdAt: new Date().toISOString(),
    };
    const safeJob = redactJobForOutput(job);
    expect(safeJob.headers[1].value).toBe('[REDACTED]');
    // Original object stays untouched.
    expect(job.headers[1].value).toBe('session=topsecret');
  });
});

describe('safeFetch, resolveSafeUrl, and readBoundedText', () => {
  const publicDns = async (host: string) => {
    if (host === 'internal.evil' || host === 'jellyfin') {
      return [{ address: '172.18.0.5' }];
    }
    return [{ address: '93.184.216.34' }];
  };

  it('follows valid public redirects and strips sensitive headers on cross-origin hops', async () => {
    const seenCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seenCalls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      if (url === 'https://start.example.com/dl') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.other.example/file.mkv' },
        });
      }
      return new Response('ok', { status: 200 });
    };

    const result = await safeFetch('https://start.example.com/dl', {
      headers: [
        { name: 'Cookie', value: 'sid=secret' },
        { name: 'Referer', value: 'https://start.example.com/' },
      ],
      lookupFn: publicDns,
      fetchFn: mockFetch,
    });

    expect(result.finalUrl).toBe('https://cdn.other.example/file.mkv');
    expect(result.redirectCount).toBe(1);
    expect(seenCalls[0].headers.Cookie).toBe('sid=secret');
    expect(seenCalls[1].headers.Cookie).toBeUndefined();
    expect(seenCalls[1].headers.Referer).toBe('https://start.example.com/');
  });

  it('blocks SSRF redirects to loopback or Docker-internal hosts', async () => {
    const redirectToLoopback: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } });

    await expect(
      safeFetch('https://public.example.com/trick', {
        lookupFn: publicDns,
        fetchFn: redirectToLoopback,
      }),
    ).rejects.toThrow(/Blocked private or reserved IP/);

    const redirectToInternal: typeof fetch = async () =>
      new Response(null, { status: 301, headers: { location: 'http://jellyfin:8096/System/Info' } });

    await expect(
      safeFetch('https://public.example.com/trick2', {
        lookupFn: publicDns,
        fetchFn: redirectToInternal,
      }),
    ).rejects.toThrow(/resolved to blocked IP/);
  });

  it('enforces maxRedirects limit', async () => {
    const infiniteRedirect: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'https://loop.example.com/next' } });

    await expect(
      safeFetch('https://loop.example.com/start', {
        maxRedirects: 2,
        lookupFn: publicDns,
        fetchFn: infiniteRedirect,
      }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('resolveSafeUrl falls back to a 1-byte GET probe when HEAD returns 405', async () => {
    const methods: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 405 });
      }
      if (url === 'https://signed.example.com/item') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://storage.example.com/real.mkv' },
        });
      }
      return new Response('x', { status: 206 });
    };

    const resolved = await resolveSafeUrl('https://signed.example.com/item', {
      lookupFn: publicDns,
      fetchFn: mockFetch,
    });

    expect(resolved).toBe('https://storage.example.com/real.mkv');
    expect(methods).toEqual(['HEAD', 'GET', 'GET']);
  });

  it('readBoundedText reads small bodies and rejects oversized responses', async () => {
    const small = new Response('hello world', { headers: { 'content-length': '11' } });
    expect(await readBoundedText(small, 64)).toBe('hello world');

    const bigHeader = new Response('x'.repeat(200), { headers: { 'content-length': '200' } });
    await expect(readBoundedText(bigHeader, 64)).rejects.toThrow(/exceeds maximum allowed size/);

    // No Content-Length header: streaming chunk check still enforces cap.
    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(40));
          controller.enqueue(new Uint8Array(40));
          controller.close();
        },
      }),
    );
    await expect(readBoundedText(streamed, 64)).rejects.toThrow(/exceeds maximum allowed size/);
  });
});
