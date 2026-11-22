import type { CustomHeader } from '../api/types';

export interface ParsedCurl {
  url: string;
  headers: CustomHeader[];
}

const USEFUL_HEADERS = new Set([
  'authorization',
  'cookie',
  'referer',
  'origin',
  'user-agent',
  'x-api-key',
]);

function tokenizeShell(input: string): string[] {
  const normalized = input.replace(/\\\r?\n/g, ' ').trim();
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export function looksLikeCurlCommand(raw: string): boolean {
  return /^\s*curl(?:\.exe)?\s+/i.test(raw);
}

export function parseCurlCommand(raw: string): ParsedCurl | null {
  if (!looksLikeCurlCommand(raw)) return null;
  const tokens = tokenizeShell(raw);
  if (tokens.length < 2) return null;

  let url = '';
  const headers: CustomHeader[] = [];

  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];

    if (tok === '-H' || tok === '--header') {
      const val = tokens[++i];
      if (!val) continue;
      const sep = val.indexOf(':');
      if (sep <= 0) continue;
      const name = val.slice(0, sep).trim();
      const value = val.slice(sep + 1).trim();
      if (USEFUL_HEADERS.has(name.toLowerCase()) && value) {
        headers.push({ name, value });
      }
      continue;
    }

    if (tok === '-b' || tok === '--cookie') {
      const val = tokens[++i];
      if (val) headers.push({ name: 'Cookie', value: val });
      continue;
    }

    if (tok === '-e' || tok === '--referer') {
      const val = tokens[++i];
      if (val) headers.push({ name: 'Referer', value: val });
      continue;
    }

    if (tok === '-A' || tok === '--user-agent') {
      const val = tokens[++i];
      if (val) headers.push({ name: 'User-Agent', value: val });
      continue;
    }

    if (tok === '--url') {
      const val = tokens[++i];
      if (val && /^https?:\/\//i.test(val)) url = val;
      continue;
    }

    if (tok.startsWith('-')) {
      // Skip value argument for common flags that take a parameter.
      if (['-X', '--request', '-d', '--data', '--data-raw', '-o', '--output', '-u', '--user'].includes(tok)) {
        i += 1;
      }
      continue;
    }

    if (!url && /^https?:\/\//i.test(tok)) {
      url = tok;
    }
  }

  return url ? { url, headers } : null;
}
