import { describe, expect, it } from 'vitest';
import { onefichierResolver } from './onefichier';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

describe('onefichierResolver', () => {
  it('matches 1fichier.com/?{id} URLs only', () => {
    expect(onefichierResolver.canHandle(new URL('https://1fichier.com/?abcd1234ef'))).toBe(true);
    expect(onefichierResolver.canHandle(new URL('https://www.1fichier.com/?abcd1234ef'))).toBe(
      true,
    );
    expect(onefichierResolver.canHandle(new URL('https://1fichier.com/tarifs.html'))).toBe(false);
    expect(onefichierResolver.canHandle(new URL('https://1fichier.com/?ab'))).toBe(false);
  });

  it('submits adz form POST and extracts direct download link and metadata', async () => {
    const mockFetch: typeof fetch = async (_input, init) => {
      if (init?.method === 'GET') {
        return new Response(
          `<html><body>
            <table>
              <tr><td>Filename</td><td>Release.2025.zip</td></tr>
              <tr><td>Size</td><td>850.5 MB</td></tr>
            </table>
            <form method="post">
              <input value="tok-xyz-123" type="hidden" name="adz">
            </form>
          </body></html>`,
          { status: 200 },
        );
      }
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('adz=tok-xyz-123&dl_no_ssl=off&dlinline=off');
      return new Response(
        `<html><body>
          <a href="https://a-12.1fichier.com/c123456789" class="ok btn-general btn-orange">Click here to download the file</a>
        </body></html>`,
        { status: 200 },
      );
    };

    const res = await onefichierResolver.resolve(new URL('https://1fichier.com/?abcd1234ef'), {
      headers: [],
      signal: new AbortController().signal,
      fetchFn: mockFetch,
      lookupFn: PUBLIC_LOOKUP,
    });

    expect(res.items[0]).toEqual({
      downloadUrl: 'https://a-12.1fichier.com/c123456789',
      filename: 'Release.2025.zip',
      sizeBytes: 850_500_000,
      sourceUrl: 'https://1fichier.com/?abcd1234ef',
      hoster: '1fichier',
    });
  });

  it('detects cooldowns on GET or POST, CAPTCHAs, deleted files, and password prompts', async () => {
    const cooldownGet: typeof fetch = async () =>
      new Response(
        '<html><div class="ct_warn">Without premium status, you must wait 5 minutes between downloads.</div></html>',
        { status: 200 },
      );

    await expect(
      onefichierResolver.resolve(new URL('https://1fichier.com/?cool1234'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: cooldownGet,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/cooldown active \(wait 5 minutes\)/);

    const cooldownPost: typeof fetch = async (_input, init) => {
      if (init?.method === 'GET') {
        return new Response('<form><input type="hidden" name="adz" value="a1"></form>', {
          status: 200,
        });
      }
      return new Response('<html><p>You must wait 12 minutes</p></html>', { status: 200 });
    };

    await expect(
      onefichierResolver.resolve(new URL('https://1fichier.com/?cool5678'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: cooldownPost,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/cooldown active \(wait 12 minutes\)/);

    const captchaFetch: typeof fetch = async () =>
      new Response('<html><div class="g-recaptcha"></div></html>', { status: 200 });

    await expect(
      onefichierResolver.resolve(new URL('https://1fichier.com/?cap12345'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: captchaFetch,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/reCAPTCHA/);

    const deletedFetch: typeof fetch = async () =>
      new Response('<html>The requested file could not be found.</html>', { status: 200 });

    await expect(
      onefichierResolver.resolve(new URL('https://1fichier.com/?del12345'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: deletedFetch,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/not found or has been deleted/);

    const passwordFetch: typeof fetch = async () =>
      new Response('<html><input type="password" name="pass"></html>', { status: 200 });

    await expect(
      onefichierResolver.resolve(new URL('https://1fichier.com/?pw123456'), {
        headers: [],
        signal: new AbortController().signal,
        fetchFn: passwordFetch,
        lookupFn: PUBLIC_LOOKUP,
      }),
    ).rejects.toThrow(/password-protected/);
  });
});
