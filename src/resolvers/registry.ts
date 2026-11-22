import type { ResolvedTarget } from '../types';
import { sanitizeFilename, sanitizeHeaders, validatePublicUrl } from '../utils/security';
import { directResolver } from './direct';
import { BUILTIN_HOSTER_RESOLVERS } from './hosters';
import { categorizeFilename, scanWebpage } from './page-scanner';
import type { ResolverContext, UrlResolver } from './types';

export interface ResolveUrlResult {
  resolverId: string;
  resolverLabel: string;
  items: ResolvedTarget[];
  warnings: string[];
}

export interface InspectBatchResult {
  items: ResolvedTarget[];
  warnings: string[];
}

const INSPECT_CONCURRENCY = 4;

export class ResolverRegistry {
  private readonly resolvers: UrlResolver[];

  constructor(resolvers: UrlResolver[] = []) {
    this.resolvers = resolvers;
  }

  listResolvers(): Array<{ id: string; label: string }> {
    return [...this.resolvers, directResolver].map((r) => ({ id: r.id, label: r.label }));
  }

  private pickResolver(url: URL): UrlResolver {
    for (const resolver of this.resolvers) {
      if (resolver.canHandle(url)) {
        return resolver;
      }
    }
    return directResolver;
  }

  async resolveUrl(rawUrl: string, ctx: ResolverContext): Promise<ResolveUrlResult> {
    const parsed = await validatePublicUrl(rawUrl, ctx.lookupFn);
    const resolver = this.pickResolver(parsed);
    ctx.onLog?.(`Resolving via ${resolver.label}...`);

    const output = await resolver.resolve(parsed, ctx);
    const warnings = [...(output.warnings ?? [])];
    const safeItems: ResolvedTarget[] = [];

    for (const item of output.items) {
      // Re-validate every resolved target URL to block SSRF from hoster redirects/APIs.
      const validatedTarget = await validatePublicUrl(item.downloadUrl, ctx.lookupFn);
      const safeHeaders = item.headers ? sanitizeHeaders(item.headers) : undefined;
      let safeFilename: string | undefined;
      if (item.filename) {
        try {
          safeFilename = sanitizeFilename(item.filename);
        } catch {
          safeFilename = undefined;
        }
      }

      safeItems.push({
        ...item,
        downloadUrl: validatedTarget.toString(),
        filename: safeFilename,
        headers: safeHeaders && safeHeaders.length > 0 ? safeHeaders : undefined,
        sourceUrl: item.sourceUrl ?? parsed.toString(),
        hoster: item.hoster || resolver.label,
        category:
          item.category ??
          categorizeFilename(safeFilename || validatedTarget.pathname, item.mimeType),
      });
    }

    if (
      ctx.inspectOnly &&
      resolver.id === 'direct' &&
      safeItems.length === 1 &&
      (safeItems[0].mimeType === 'text/html' || safeItems[0].mimeType === 'application/xhtml+xml')
    ) {
      ctx.onLog?.('Scanning HTML page for downloadable links...');
      const scanned = await scanWebpage(parsed, ctx, this.resolvers);
      const scannedWarnings = [...warnings, ...scanned.warnings];

      if (scanned.items.length > 0) {
        const hostCache = new Map<string, Promise<boolean>>();
        const checkHost = (targetUrl: string): Promise<boolean> => {
          let hostKey: string;
          try {
            hostKey = new URL(targetUrl).hostname.toLowerCase();
          } catch {
            return Promise.resolve(false);
          }
          let pending = hostCache.get(hostKey);
          if (!pending) {
            pending = validatePublicUrl(targetUrl, ctx.lookupFn)
              .then(() => true)
              .catch(() => false);
            hostCache.set(hostKey, pending);
          }
          return pending;
        };

        const validatedItems: ResolvedTarget[] = [];
        for (const item of scanned.items) {
          const allowed = await checkHost(item.downloadUrl);
          if (!allowed) {
            scannedWarnings.push(`Blocked unsafe scanned link: ${item.downloadUrl}`);
            continue;
          }

          let cleanName: string | undefined;
          if (item.filename) {
            try {
              cleanName = sanitizeFilename(item.filename);
            } catch {
              cleanName = undefined;
            }
          }

          validatedItems.push({
            ...item,
            filename: cleanName,
            sourceUrl: item.sourceUrl ?? parsed.toString(),
            category: item.category ?? categorizeFilename(cleanName || item.downloadUrl),
          });
        }

        if (validatedItems.length > 0) {
          return {
            resolverId: 'page-scanner',
            resolverLabel: 'Webpage Scan',
            items: validatedItems,
            warnings: scannedWarnings,
          };
        }

        return {
          resolverId: resolver.id,
          resolverLabel: resolver.label,
          items: safeItems,
          warnings: [
            ...scannedWarnings,
            'No safe downloadable file or hoster links found on HTML page',
          ],
        };
      }

      warnings.push(...scanned.warnings, 'No downloadable file or hoster links found on HTML page');
    }

    if (safeItems.length === 0) {
      throw new Error(`${resolver.label} resolver returned no downloadable targets`);
    }

    return {
      resolverId: resolver.id,
      resolverLabel: resolver.label,
      items: safeItems,
      warnings,
    };
  }

  async inspectUrls(rawUrls: string[], ctx: ResolverContext): Promise<InspectBatchResult> {
    const cleaned = rawUrls.map((u) => u.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      throw new Error('At least one URL is required');
    }
    if (cleaned.length > 50) {
      throw new Error('Cannot inspect more than 50 URLs at once');
    }

    const slots: Array<{ items: ResolvedTarget[]; warnings: string[] }> = new Array(cleaned.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= cleaned.length) return;
        const targetUrl = cleaned[idx];
        try {
          const res = await this.resolveUrl(targetUrl, { ...ctx, inspectOnly: true });
          slots[idx] = { items: res.items, warnings: res.warnings };
        } catch (err) {
          slots[idx] = {
            items: [],
            warnings: [`${targetUrl}: ${(err as Error).message}`],
          };
        }
      }
    };

    const workerCount = Math.min(INSPECT_CONCURRENCY, cleaned.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const items: ResolvedTarget[] = [];
    const warnings: string[] = [];
    for (const slot of slots) {
      if (!slot) continue;
      items.push(...slot.items);
      warnings.push(...slot.warnings);
    }

    return { items, warnings };
  }
}

export function createResolverRegistry(
  customResolvers: UrlResolver[] = [],
  includeBuiltins = true,
): ResolverRegistry {
  const combined = includeBuiltins
    ? [...customResolvers, ...BUILTIN_HOSTER_RESOLVERS]
    : [...customResolvers];
  return new ResolverRegistry(combined);
}
