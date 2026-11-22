import {
  detectPlatformLabel,
  detectYtDlpBinary,
  inspectWithYtDlp,
  isAudioPlatformUrl,
  isYtDlpPlatformUrl,
} from '../../services/ytdlp';
import type { ResolverContext, ResolverOutput, UrlResolver } from '../types';

export interface YtDlpResolverDeps {
  detectBinaryFn?: () => Promise<string | null>;
  inspectFn?: typeof inspectWithYtDlp;
}

export function createYtDlpResolver(deps: YtDlpResolverDeps = {}): UrlResolver {
  const detectBinary = deps.detectBinaryFn ?? (() => detectYtDlpBinary());
  const inspect = deps.inspectFn ?? inspectWithYtDlp;

  return {
    id: 'ytdlp',
    label: 'yt-dlp',

    canHandle(url: URL): boolean {
      return isYtDlpPlatformUrl(url);
    },

    async resolve(url: URL, ctx: ResolverContext): Promise<ResolverOutput> {
      const binaryPath = await detectBinary();
      if (!binaryPath) {
        throw new Error(
          'yt-dlp is not installed on this server (install yt-dlp and ffmpeg to download from video/audio platforms)',
        );
      }

      if (ctx.inspectOnly) {
        return inspect(url, {
          signal: ctx.signal,
          proxyUrl: ctx.proxyUrl,
          headers: ctx.headers,
          binaryPath,
        });
      }

      return {
        items: [
          {
            downloadUrl: url.toString(),
            sourceUrl: url.toString(),
            hoster: detectPlatformLabel(url),
            category: isAudioPlatformUrl(url) ? 'audio' : 'video',
            engine: 'yt-dlp',
          },
        ],
      };
    },
  };
}

export const ytDlpResolver = createYtDlpResolver();
