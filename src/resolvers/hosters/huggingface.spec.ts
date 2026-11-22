import { describe, expect, it } from 'vitest';
import { huggingfaceResolver } from './huggingface';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('huggingfaceResolver', () => {
  it('matches model, dataset, space, and single-segment /blob/ URLs and skips /resolve/ or /tree/', () => {
    expect(
      huggingfaceResolver.canHandle(
        new URL('https://huggingface.co/meta-llama/Llama-3/blob/main/model.safetensors'),
      ),
    ).toBe(true);
    expect(
      huggingfaceResolver.canHandle(
        new URL('https://huggingface.co/datasets/org/ds/blob/main/data/train.parquet'),
      ),
    ).toBe(true);
    expect(
      huggingfaceResolver.canHandle(
        new URL('https://huggingface.co/spaces/org/app/blob/main/weights.bin'),
      ),
    ).toBe(true);
    expect(
      huggingfaceResolver.canHandle(new URL('https://huggingface.co/bert-base-uncased/blob/main/config.json')),
    ).toBe(true);
    expect(
      huggingfaceResolver.canHandle(
        new URL('https://huggingface.co/meta-llama/Llama-3/resolve/main/model.safetensors'),
      ),
    ).toBe(false);
    expect(
      huggingfaceResolver.canHandle(new URL('https://huggingface.co/meta-llama/Llama-3/tree/main')),
    ).toBe(false);
  });

  it('rewrites structural /blob/ to /resolve/ without altering nested /blob/ path segments', async () => {
    let probedUrl = '';
    const mockFetch: typeof fetch = async (input) => {
      probedUrl = String(input);
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': '536870912',
          'content-type': 'application/octet-stream',
        },
      });
    };

    const res = await huggingfaceResolver.resolve(
      new URL('https://huggingface.co/datasets/org/ds/blob/main/blob/file.bin?download=true#L1'),
      {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: mockFetch,
        lookupFn: PUBLIC_LOOKUP,
      },
    );

    expect(probedUrl).toBe(
      'https://huggingface.co/datasets/org/ds/resolve/main/blob/file.bin?download=true',
    );
    expect(res.items[0].hoster).toBe('Hugging Face');
    expect(res.items[0].filename).toBe('file.bin');
    expect(res.items[0].sizeBytes).toBe(536870912);
  });
});
