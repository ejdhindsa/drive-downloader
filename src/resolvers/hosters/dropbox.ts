import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';
import { probeDirectMetadata } from './helpers';

function matchesDropboxUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host !== 'dropbox.com' && host !== 'www.dropbox.com') return false;
  return /^\/(?:s|scl\/fi)\//.test(url.pathname);
}

export const dropboxResolver: UrlResolver = {
  id: 'dropbox',
  label: 'Dropbox',

  canHandle(url: URL): boolean {
    return matchesDropboxUrl(url);
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const directUrl = new URL(url.toString());
    directUrl.searchParams.delete('raw');
    directUrl.searchParams.set('dl', '1');

    const target = await probeDirectMetadata(directUrl, url, 'Dropbox', ctx);
    return { items: [target] };
  },
};
