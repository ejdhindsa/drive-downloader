import type { CustomHeader, ResolvedTarget } from '../types';
import type { DnsLookupFn } from '../utils/security';

export interface ResolverContext {
  headers: CustomHeader[];
  signal: AbortSignal;
  proxyUrl?: string;
  inspectOnly?: boolean;
  fetchFn?: typeof fetch;
  lookupFn?: DnsLookupFn;
  onLog?: (line: string) => void;
}

export interface ResolverOutput {
  items: ResolvedTarget[];
  warnings?: string[];
}

export interface UrlResolver {
  readonly id: string;
  readonly label: string;
  canHandle(url: URL): boolean;
  resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput>;
}
