import dns from 'node:dns/promises';
import net from 'node:net';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { MIB, REDACTED_VALUE } from '../consts';
import type { CustomHeader, Job } from '../types';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

const SENSITIVE_HEADER_PATTERN = /(authorization|cookie|token|secret|api[-_]?key|password|session)/i;

const proxyAgents = new Map<string, ProxyAgent>();

function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, agent);
  }
  return agent;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    value = ((value << 8) | n) >>> 0;
  }
  return value;
}

function inCidr4(ipInt: number, base: string, prefixLen: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isPrivateIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return true;
  return (
    inCidr4(ipInt, '0.0.0.0', 8) ||
    inCidr4(ipInt, '10.0.0.0', 8) ||
    inCidr4(ipInt, '100.64.0.0', 10) ||
    inCidr4(ipInt, '127.0.0.0', 8) ||
    inCidr4(ipInt, '169.254.0.0', 16) ||
    inCidr4(ipInt, '172.16.0.0', 12) ||
    inCidr4(ipInt, '192.0.0.0', 24) ||
    inCidr4(ipInt, '192.0.2.0', 24) ||
    inCidr4(ipInt, '192.168.0.0', 16) ||
    inCidr4(ipInt, '198.18.0.0', 15) ||
    inCidr4(ipInt, '198.51.100.0', 24) ||
    inCidr4(ipInt, '203.0.113.0', 24) ||
    inCidr4(ipInt, '224.0.0.0', 4) ||
    inCidr4(ipInt, '240.0.0.0', 4)
  );
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().split('%')[0];
  const version = net.isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version !== 6) {
    return true;
  }

  // Handle both dotted-quad (::ffff:127.0.0.1) and hex (::ffff:7f00:1) IPv4-mapped forms.
  if (ip.startsWith('::ffff:')) {
    const rest = ip.slice('::ffff:'.length);
    if (net.isIPv4(rest)) {
      return isPrivateIpv4(rest);
    }
    const hexParts = rest.split(':');
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0], 16);
      const lo = Number.parseInt(hexParts[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIpv4(mapped);
      }
    }
  }

  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  if (ip.startsWith('ff')) return true;
  if (ip.startsWith('2001:db8:')) return true;

  return false;
}

export type DnsLookupFn = (host: string) => Promise<Array<{ address: string }>>;

export async function validatePublicUrl(
  rawUrl: string,
  lookupFn: DnsLookupFn = (host) => dns.lookup(host, { all: true, verbatim: true }),
): Promise<URL> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL cannot be empty');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${parsed.protocol}". Only http:// and https:// are allowed.`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) {
    throw new Error('URL must contain a valid hostname');
  }

  if (
    BLOCKED_HOSTNAMES.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new Error(`Blocked internal hostname: ${host}`);
  }

  if (net.isIP(host) !== 0) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error(`Blocked private or reserved IP address: ${host}`);
    }
    return parsed;
  }

  let records: Array<{ address: string }>;
  try {
    records = await lookupFn(host);
  } catch {
    throw new Error(`Could not resolve hostname: ${host}`);
  }

  if (!records.length) {
    throw new Error(`Hostname resolved to no addresses: ${host}`);
  }

  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error(`Hostname "${host}" resolved to blocked IP ${record.address}`);
    }
  }

  return parsed;
}

export function validateProxyUrl(rawProxy: string | undefined): string {
  const trimmed = rawProxy?.trim() ?? '';
  if (!trimmed) return '';
  if (/[\s\r\n\0]/.test(trimmed)) {
    throw new Error('DOWNLOAD_PROXY contains invalid whitespace or control characters');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid DOWNLOAD_PROXY URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported DOWNLOAD_PROXY protocol "${parsed.protocol}". Use an http:// or https:// proxy (aria2c and undici do not support native socks5).`,
    );
  }
  if (!parsed.hostname) {
    throw new Error('DOWNLOAD_PROXY must include a hostname');
  }

  return parsed.toString().replace(/\/$/, '');
}

export function redactProxyUrl(proxyUrl: string): string {
  if (!proxyUrl) return '';
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '[invalid-proxy]';
  }
}

function validatePathSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) {
    throw new Error('Path segment cannot be empty');
  }
  if (
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    /[\x00-\x1f\x7f]/.test(trimmed) ||
    trimmed.startsWith('-') ||
    trimmed.includes(':')
  ) {
    throw new Error(`Invalid path segment: "${trimmed}"`);
  }
  return trimmed;
}

export function sanitizeFolderName(folder: string): string {
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed || trimmed.includes('/')) {
    throw new Error('Top-level folder must be a single valid folder name');
  }
  return validatePathSegment(trimmed);
}

export function sanitizeRelativePath(rawPath: string | undefined): string {
  if (!rawPath) return '';
  const rawSegments = rawPath.split('/').map((s) => s.trim()).filter(Boolean);
  if (rawSegments.length === 0) return '';
  return rawSegments.map(validatePathSegment).join('/');
}

export function sanitizeFilename(rawName: string | undefined): string | undefined {
  if (!rawName) return undefined;
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes('/')) {
    throw new Error('Custom filename cannot contain "/"');
  }
  return validatePathSegment(trimmed);
}

export function sanitizeHeaders(headers: CustomHeader[] | undefined): CustomHeader[] {
  if (!headers || headers.length === 0) return [];
  const cleaned: CustomHeader[] = [];
  for (const h of headers) {
    const name = (h.name ?? '').trim();
    const value = (h.value ?? '').trim();
    if (!name && !value) continue;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) {
      throw new Error(`Invalid HTTP header name: "${name}"`);
    }
    if (/[\r\n\0]/.test(value) || value.length > 4096) {
      throw new Error(`Invalid HTTP header value for "${name}"`);
    }
    cleaned.push({ name, value });
  }
  return cleaned;
}

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(name.trim());
}

export function redactHeaders(headers: CustomHeader[] | undefined): CustomHeader[] {
  if (!headers || headers.length === 0) return [];
  return headers.map((h) => ({
    name: h.name,
    value: isSensitiveHeaderName(h.name) ? REDACTED_VALUE : h.value,
  }));
}

export function redactJobForOutput(job: Job): Job {
  return {
    ...job,
    headers: redactHeaders(job.headers),
  };
}

export interface SafeFetchOptions {
  method?: string;
  headers?: CustomHeader[] | Record<string, string>;
  body?: string;
  followRedirects?: boolean;
  signal?: AbortSignal;
  maxRedirects?: number;
  timeoutMs?: number;
  proxyUrl?: string;
  lookupFn?: DnsLookupFn;
  fetchFn?: typeof fetch;
}

export interface SafeFetchResult {
  response: Response;
  finalUrl: string;
  redirectCount: number;
}

function buildRequestHeaders(input?: CustomHeader[] | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (Array.isArray(input)) {
    for (const h of input) {
      out[h.name] = h.value;
    }
    return out;
  }
  return { ...input };
}

function stripCrossOriginSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!isSensitiveHeaderName(k)) {
      next[k] = v;
    }
  }
  return next;
}

function stripBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower !== 'content-length' && lower !== 'content-type') {
      next[k] = v;
    }
  }
  return next;
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 10;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const followRedirects = opts.followRedirects ?? true;
  let currentMethod = opts.method ?? 'GET';
  let currentBody = opts.body;
  let currentUrl = (await validatePublicUrl(rawUrl, opts.lookupFn)).toString();
  let currentHeaders = buildRequestHeaders(opts.headers);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    let response: Response;
    const init: RequestInit = {
      method: currentMethod,
      headers: currentHeaders,
      redirect: 'manual',
      signal: combinedSignal,
    };
    if (currentBody !== undefined) {
      init.body = currentBody;
    }

    if (opts.fetchFn) {
      response = await opts.fetchFn(currentUrl, init);
    } else if (opts.proxyUrl) {
      response = (await undiciFetch(currentUrl, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher: getProxyAgent(opts.proxyUrl),
      })) as unknown as Response;
    } else {
      response = await fetch(currentUrl, init);
    }

    const location = response.headers.get('location');
    if (REDIRECT_STATUS_CODES.has(response.status) && location) {
      if (!followRedirects) {
        return {
          response,
          finalUrl: currentUrl,
          redirectCount: redirects,
        };
      }

      await response.body?.cancel().catch(() => {});

      if (redirects === maxRedirects) {
        throw new Error(`Too many redirects (exceeded ${maxRedirects})`);
      }

      const prevOrigin = new URL(currentUrl).origin;
      const nextUrl = new URL(location, currentUrl).toString();
      const validated = await validatePublicUrl(nextUrl, opts.lookupFn);

      if (validated.origin !== prevOrigin) {
        currentHeaders = stripCrossOriginSensitiveHeaders(currentHeaders);
      }

      const upperMethod = currentMethod.toUpperCase();
      if (
        (response.status === 301 || response.status === 302 || response.status === 303) &&
        upperMethod !== 'GET' &&
        upperMethod !== 'HEAD'
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
        currentHeaders = stripBodyHeaders(currentHeaders);
      }

      currentUrl = validated.toString();
      continue;
    }

    return {
      response,
      finalUrl: currentUrl,
      redirectCount: redirects,
    };
  }

  throw new Error(`Too many redirects (exceeded ${maxRedirects})`);
}

export async function resolveSafeUrl(
  rawUrl: string,
  opts: Omit<SafeFetchOptions, 'method'> = {},
): Promise<string> {
  const head = await safeFetch(rawUrl, { ...opts, method: 'HEAD' });
  await head.response.body?.cancel().catch(() => {});

  // Some presigned hosts reject HEAD with 403/405/501; fall back to a 1-byte GET probe
  // so redirects on GET-only endpoints still pass SSRF validation.
  if (head.response.status === 403 || head.response.status === 405 || head.response.status === 501) {
    const extraHeaders = { ...buildRequestHeaders(opts.headers), Range: 'bytes=0-0' };
    const probe = await safeFetch(head.finalUrl, { ...opts, method: 'GET', headers: extraHeaders });
    await probe.response.body?.cancel().catch(() => {});
    return probe.finalUrl;
  }

  return head.finalUrl;
}

export async function readBoundedText(
  response: Response,
  maxBytes = 5 * MIB,
): Promise<string> {
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Response body exceeds maximum allowed size (${maxBytes} bytes)`);
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response body exceeds maximum allowed size (${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}
