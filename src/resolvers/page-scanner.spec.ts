import { describe, expect, it } from 'vitest';
import { BUILTIN_HOSTER_RESOLVERS } from './hosters';
import { categorizeFilename, isDownloadableFileUrl, scanHtmlForLinks, scanWebpage } from './page-scanner';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('page-scanner helpers', () => {
  it('categorizes filenames and MIME types into video, archive, audio, book, and other', () => {
    expect(categorizeFilename('Movie.2024.2160p.mkv')).toBe('video');
    expect(categorizeFilename('Show.part01.rar')).toBe('archive');
    expect(categorizeFilename('Backup.7z.001')).toBe('archive');
    expect(categorizeFilename('Album.flac')).toBe('audio');
    expect(categorizeFilename('Manual.epub')).toBe('book');
    expect(categorizeFilename('model-q4.gguf')).toBe('other');
    expect(categorizeFilename('download', 'video/mp4')).toBe('video');
    expect(categorizeFilename('download', 'application/pdf')).toBe('book');
  });

  it('recognizes downloadable file URLs and ignores directory or HTML paths', () => {
    expect(isDownloadableFileUrl(new URL('https://cdn.example.com/files/Clip.mp4'))).toBe(true);
    expect(isDownloadableFileUrl(new URL('https://cdn.example.com/files/Set.7z.002'))).toBe(true);
    expect(isDownloadableFileUrl(new URL('https://cdn.example.com/files/'))).toBe(false);
    expect(isDownloadableFileUrl(new URL('https://cdn.example.com/about.html'))).toBe(false);
  });
});

describe('scanHtmlForLinks & scanWebpage', () => {
  it('parses Apache/Nginx <pre> directory indexes with relative URLs, sizes, and sort/parent filtering', () => {
    const html = `
      <html><body>
      <h1>Index of /releases/</h1>
      <pre>
        <a href="?C=N;O=D">Name</a>  <a href="?C=S;O=A">Size</a>
        <a href="../">Parent Directory</a>
        <a href="./subdir/">subdir/</a>
        <a href="Episode%2001.mkv">Episode 01.mkv</a>    12-Jan-2026 10:00   1.4 GiB
        <a href="Episode%2001.mkv">Episode 01.mkv</a>    12-Jan-2026 10:00   1.4 GiB
        <a href="Bonus.zip">Bonus.zip</a>                      12-Jan-2026 10:01   250 MB
        <a href="notes.html">notes.html</a>
      </pre>
      </body></html>
    `;

    const res = scanHtmlForLinks(
      html,
      new URL('https://files.example.com/releases/'),
      BUILTIN_HOSTER_RESOLVERS,
    );

    expect(res.warnings).toEqual([]);
    expect(res.items).toEqual([
      {
        downloadUrl: 'https://files.example.com/releases/Episode%2001.mkv',
        filename: 'Episode 01.mkv',
        sizeBytes: Math.round(1.4 * 1024 ** 3),
        sourceUrl: 'https://files.example.com/releases/',
        hoster: 'Direct',
        category: 'video',
      },
      {
        downloadUrl: 'https://files.example.com/releases/Bonus.zip',
        filename: 'Bonus.zip',
        sizeBytes: 250_000_000,
        sourceUrl: 'https://files.example.com/releases/',
        hoster: 'Direct',
        category: 'archive',
      },
    ]);
  });

  it('parses table-based directory listings and hoster link-list pages while filtering local/nav links', () => {
    const html = `
      <html><body>
        <nav>
          <a href="/">Home</a>
          <a href="#top">Top</a>
          <a href="javascript:void(0)">Menu</a>
          <a href="http://127.0.0.1/secret.mkv">Local Leak</a>
          <a href="http://jellyfin.local/internal.mp4">Internal</a>
        </nav>
        <table>
          <tr>
            <td><a href="/media/Book.epub">Book.epub</a></td>
            <td>14.5 MiB</td>
          </tr>
          <tr>
            <td><a href="https://pixeldrain.com/u/PdAbc123">Soundtrack.flac</a></td>
            <td>-</td>
          </tr>
          <tr>
            <td><a href="https://gofile.io/d/GfXyz9">Season Pack</a></td>
            <td>-</td>
          </tr>
          <tr>
            <td><a href="https://github.com/org/tool/releases/latest">Latest Release</a></td>
            <td>-</td>
          </tr>
          <tr>
            <td><a href="https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view">Download</a></td>
            <td>-</td>
          </tr>
        </table>
      </body></html>
    `;

    const res = scanHtmlForLinks(
      html,
      new URL('https://index.example.com/list.html'),
      BUILTIN_HOSTER_RESOLVERS,
    );

    expect(res.items).toEqual([
      {
        downloadUrl: 'https://index.example.com/media/Book.epub',
        filename: 'Book.epub',
        sizeBytes: Math.round(14.5 * 1024 ** 2),
        sourceUrl: 'https://index.example.com/list.html',
        hoster: 'Direct',
        category: 'book',
      },
      {
        downloadUrl: 'https://pixeldrain.com/u/PdAbc123',
        filename: 'Soundtrack.flac',
        sizeBytes: undefined,
        sourceUrl: 'https://index.example.com/list.html',
        hoster: 'Pixeldrain',
        category: 'audio',
      },
      {
        downloadUrl: 'https://gofile.io/d/GfXyz9',
        filename: 'Season Pack',
        sizeBytes: undefined,
        sourceUrl: 'https://index.example.com/list.html',
        hoster: 'Gofile',
        category: 'other',
      },
      {
        downloadUrl: 'https://github.com/org/tool/releases/latest',
        filename: 'Latest Release',
        sizeBytes: undefined,
        sourceUrl: 'https://index.example.com/list.html',
        hoster: 'GitHub',
        category: 'other',
      },
      {
        downloadUrl: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view',
        filename: 'view',
        sizeBytes: undefined,
        sourceUrl: 'https://index.example.com/list.html',
        hoster: 'Google Drive',
        category: 'other',
      },
    ]);
  });

  it('enforces the 5 MiB read bound during scanWebpage', async () => {
    const oversizedFetch: typeof fetch = async () =>
      new Response('x', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-length': String(6 * 1024 * 1024),
        },
      });

    await expect(
      scanWebpage(
        new URL('https://huge.example.com/index.html'),
        {
          headers: [],
          signal: new AbortController().signal,
          fetchFn: oversizedFetch,
          lookupFn: PUBLIC_LOOKUP,
        },
        BUILTIN_HOSTER_RESOLVERS,
      ),
    ).rejects.toThrow(/exceeds maximum allowed size/);
  });
});
