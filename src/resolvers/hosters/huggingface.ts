import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';
import { probeDirectMetadata } from './helpers';

const HF_BLOB_PATH =
  /^\/((?:datasets|spaces)\/[^/]+(?:\/[^/]+)?|(?!datasets\/|spaces\/)[^/]+(?:\/[^/]+)?)\/blob\/([^/]+\/.+)$/;

function parseHuggingFaceBlobPath(url: URL): RegExpExecArray | null {
  const host = url.hostname.toLowerCase();
  if (host !== 'huggingface.co' && host !== 'www.huggingface.co') return null;
  return HF_BLOB_PATH.exec(url.pathname);
}

export const huggingfaceResolver: UrlResolver = {
  id: 'huggingface',
  label: 'Hugging Face',

  canHandle(url: URL): boolean {
    return parseHuggingFaceBlobPath(url) !== null;
  },

  async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
    const match = parseHuggingFaceBlobPath(url);
    if (!match) {
      throw new Error(`Unsupported Hugging Face URL: ${url.toString()}`);
    }

    const resolvedUrl = new URL(url.toString());
    resolvedUrl.pathname = `/${match[1]}/resolve/${match[2]}`;
    resolvedUrl.hash = '';

    const target = await probeDirectMetadata(resolvedUrl, url, 'Hugging Face', ctx);
    return { items: [target] };
  },
};
