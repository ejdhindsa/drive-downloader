import dns from 'node:dns/promises';
import net from 'node:net';
import type { CustomHeader } from './types';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

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

  // IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
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
  // Unique local addresses (fc00::/7) -> fc.. or fd..
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  // Link-local (fe80::/10) -> fe80..febf
  if (/^fe[89ab]/.test(ip)) return true;
  // Multicast (ff00::/8)
  if (ip.startsWith('ff')) return true;
  // Documentation (2001:db8::/32)
  if (ip.startsWith('2001:db8:')) return true;

  return false;
}

export async function validatePublicUrl(
  rawUrl: string,
  lookupFn: (host: string) => Promise<Array<{ address: string }>> = (host) =>
    dns.lookup(host, { all: true, verbatim: true }),
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
