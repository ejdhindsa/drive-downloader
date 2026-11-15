import assert from 'node:assert/strict';
import test from 'node:test';
import { detectArchiveFormat } from '../src/extractor';
import { parseAria2ProgressLine } from '../src/queue';
import {
  isPrivateOrReservedIp,
  sanitizeFilename,
  sanitizeFolderName,
  sanitizeHeaders,
  sanitizeRelativePath,
  validatePublicUrl,
} from '../src/security';

test('isPrivateOrReservedIp blocks loopback, RFC1918, CGNAT, link-local, and IPv6 private ranges', () => {
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
    assert.equal(isPrivateOrReservedIp(ip), true, `Expected ${ip} to be blocked`);
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111'];
  for (const ip of allowed) {
    assert.equal(isPrivateOrReservedIp(ip), false, `Expected ${ip} to be allowed`);
  }
});

test('validatePublicUrl blocks unsafe schemes, internal hostnames, and private DNS resolutions', async () => {
  const publicDns = async () => [{ address: '93.184.216.34' }];
  const privateDns = async () => [{ address: '192.168.1.10' }];

  const valid = await validatePublicUrl('https://cdn.example.com/file.mkv', publicDns);
  assert.equal(valid.hostname, 'cdn.example.com');

  await assert.rejects(() => validatePublicUrl('file:///etc/passwd', publicDns), /Unsupported protocol/);
  await assert.rejects(() => validatePublicUrl('ftp://example.com/a.zip', publicDns), /Unsupported protocol/);
  await assert.rejects(() => validatePublicUrl('http://localhost:8080/x', publicDns), /Blocked internal hostname/);
  await assert.rejects(() => validatePublicUrl('http://jellyfin.internal/x', publicDns), /Blocked internal hostname/);
  await assert.rejects(() => validatePublicUrl('http://127.0.0.1/test', publicDns), /Blocked private/);
  await assert.rejects(() => validatePublicUrl('https://rebind.example.com/x', privateDns), /resolved to blocked IP/);
});

test('path, filename, and header sanitizers reject traversal and injection payloads', () => {
  assert.equal(sanitizeFolderName('Movies'), 'Movies');
  assert.equal(sanitizeFolderName('TVShows'), 'TVShows');
  assert.throws(() => sanitizeFolderName('Movies/Sub'), /single valid folder/);
  assert.throws(() => sanitizeFolderName('..'), /Invalid path segment/);

  assert.equal(sanitizeRelativePath('Chernobyl (2019)/Season 01/'), 'Chernobyl (2019)/Season 01');
  assert.throws(() => sanitizeRelativePath('Show/../Secret'), /Invalid path segment/);
  assert.throws(() => sanitizeRelativePath('-rf'), /Invalid path segment/);

  assert.equal(sanitizeFilename('Movie.2025.mkv'), 'Movie.2025.mkv');
  assert.throws(() => sanitizeFilename('sub/Movie.mkv'), /cannot contain "\/"/);
  assert.throws(() => sanitizeFilename('..'), /Invalid path segment/);

  assert.deepEqual(sanitizeHeaders([{ name: 'Referer', value: 'https://site.test/' }]), [
    { name: 'Referer', value: 'https://site.test/' },
  ]);
  assert.throws(() => sanitizeHeaders([{ name: 'Bad Header', value: 'x' }]), /Invalid HTTP header name/);
  assert.throws(() => sanitizeHeaders([{ name: 'Cookie', value: 'a=1\r\nX-Injected: 2' }]), /Invalid HTTP header value/);
});

test('detectArchiveFormat identifies supported archive extensions', () => {
  assert.equal(detectArchiveFormat('Season.01.zip'), 'zip');
  assert.equal(detectArchiveFormat('pack.7z'), '7z');
  assert.equal(detectArchiveFormat('pack.rar'), 'rar');
  assert.equal(detectArchiveFormat('pack.tar.gz'), 'tar');
  assert.equal(detectArchiveFormat('pack.TGZ'), 'tar');
  assert.equal(detectArchiveFormat('Movie.mkv'), null);
});

test('parseAria2ProgressLine parses size, percent, speed, and ETA', () => {
  const line = '[#1a2b3c 45MiB/100MiB(45%) CN:16 DL:12.5MiB ETA:1m4s]';
  const parsed = parseAria2ProgressLine(line);
  assert.ok(parsed);
  assert.equal(parsed.percent, 45);
  assert.equal(parsed.bytesDone, 45 * 1024 * 1024);
  assert.equal(parsed.bytesTotal, 100 * 1024 * 1024);
  assert.equal(parsed.speedBytesPerSec, Math.round(12.5 * 1024 * 1024));
  assert.equal(parsed.etaSeconds, 64);
});
