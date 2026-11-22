export interface MediaSuggestion {
  folder: string;
  subfolder: string;
  label: string;
}

function extractFilename(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const segment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

function titleCase(raw: string): string {
  return raw
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function pickTopFolder(available: string[], preferred: string[], fallback: string): string {
  for (const candidate of preferred) {
    const found = available.find((f) => f.toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }
  return fallback;
}

export function suggestMediaDestination(
  urls: string[],
  availableTopFolders: string[],
): MediaSuggestion | null {
  if (urls.length === 0) return null;
  const filename = extractFilename(urls[0]);
  if (!filename) return null;

  const baseName = filename.replace(/\.[a-z0-9]{2,5}$/i, '');

  const tvMatch =
    baseName.match(/^(.+?)[.\s_-]+S(\d{1,2})(?:E\d{1,2}|\b)/i) ??
    baseName.match(/^(.+?)[.\s_-]+Season[.\s_-]*(\d{1,2})\b/i);
  if (tvMatch) {
    const show = titleCase(tvMatch[1]);
    const season = tvMatch[2].padStart(2, '0');
    if (show) {
      const folder = pickTopFolder(availableTopFolders, ['TVShows', 'TV', 'Shows', 'Series'], 'TVShows');
      const subfolder = `${show}/Season ${season}`;
      return { folder, subfolder, label: `${folder}/${subfolder}` };
    }
  }

  const movieMatch = baseName.match(/^(.+?)[.\s_-]+\(?((?:19|20)\d{2})\)?(?:[.\s_-]|$)/);
  if (movieMatch && /\.(mkv|mp4|avi|mov|m4v|zip|rar|7z)$/i.test(filename)) {
    const title = titleCase(movieMatch[1]);
    const year = movieMatch[2];
    if (title) {
      const folder = pickTopFolder(availableTopFolders, ['Movies', 'Films'], 'Movies');
      const subfolder = `${title} (${year})`;
      return { folder, subfolder, label: `${folder}/${subfolder}` };
    }
  }

  if (/\.(epub|m4b|azw3|mobi|cbz|cbr)$/i.test(filename)) {
    const folder = pickTopFolder(availableTopFolders, ['Books', 'Audiobooks'], 'Books');
    return { folder, subfolder: '', label: folder };
  }

  return null;
}
