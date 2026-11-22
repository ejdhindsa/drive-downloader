import type { FastifyInstance, FastifyRequest } from 'fastify';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Inline script/style allowance is temporary until PR 2 moves the UI into compiled Svelte bundles.
const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export interface RateLimiter {
  check: (key: string, now?: number) => RateLimitDecision;
  clear: () => void;
}

export function createRateLimiter(opts: { windowMs: number; maxRequests: number }): RateLimiter {
  const buckets = new Map<string, number[]>();

  return {
    check(key: string, now = Date.now()): RateLimitDecision {
      const cutoff = now - opts.windowMs;
      const existing = buckets.get(key) ?? [];
      const recent = existing.filter((ts) => ts > cutoff);

      if (recent.length >= opts.maxRequests) {
        buckets.set(key, recent);
        const oldest = recent[0] ?? now;
        const retryAfterMs = Math.max(1000, opts.windowMs - (now - oldest));
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
          remaining: 0,
        };
      }

      recent.push(now);
      buckets.set(key, recent);

      if (buckets.size > 1000) {
        for (const [k, list] of buckets.entries()) {
          if (list.every((ts) => ts <= cutoff)) {
            buckets.delete(k);
          }
        }
      }

      return {
        allowed: true,
        retryAfterSeconds: 0,
        remaining: Math.max(0, opts.maxRequests - recent.length),
      };
    },
    clear() {
      buckets.clear();
    },
  };
}

function getExpectedHost(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-host'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded || request.headers.host || '';
  return raw.split(',')[0].trim().toLowerCase();
}

function extractHeaderHost(headerValue: string): string | null {
  try {
    return new URL(headerValue).host.toLowerCase();
  } catch {
    return null;
  }
}

export function verifySameOriginRequest(request: FastifyRequest): string | null {
  const fetchSite = String(request.headers['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (fetchSite === 'cross-site') {
    return 'Cross-site requests are not allowed';
  }

  const expectedHost = getExpectedHost(request);
  const originHeader = request.headers.origin;
  if (typeof originHeader === 'string' && originHeader.trim() !== '') {
    if (originHeader.trim().toLowerCase() === 'null') {
      return 'Requests with null Origin are not allowed';
    }
    const originHost = extractHeaderHost(originHeader);
    if (!originHost || !expectedHost || originHost !== expectedHost) {
      return `Origin mismatch: ${originHeader}`;
    }
    return null;
  }

  const refererHeader = request.headers.referer;
  if (typeof refererHeader === 'string' && refererHeader.trim() !== '') {
    const refererHost = extractHeaderHost(refererHeader);
    if (!refererHost || !expectedHost || refererHost !== expectedHost) {
      return `Referer mismatch: ${refererHeader}`;
    }
  }

  return null;
}

export interface HttpSecurityOptions {
  csp?: string;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
}

export function registerHttpSecurity(
  app: FastifyInstance,
  opts: HttpSecurityOptions = {},
): { rateLimiter: RateLimiter } {
  const csp = opts.csp ?? DEFAULT_CSP;
  const rateLimiter = createRateLimiter({
    windowMs: opts.rateLimitWindowMs ?? 60_000,
    maxRequests: opts.rateLimitMaxRequests ?? 60,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', csp);
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method.toUpperCase())) {
      return;
    }

    const csrfError = verifySameOriginRequest(request);
    if (csrfError) {
      return reply.code(403).send({ error: csrfError });
    }

    if (request.url.startsWith('/api/')) {
      const decision = rateLimiter.check(request.ip || 'unknown');
      if (!decision.allowed) {
        reply.header('Retry-After', String(decision.retryAfterSeconds));
        return reply.code(429).send({
          error: `Rate limit exceeded. Try again in ${decision.retryAfterSeconds}s.`,
        });
      }
    }
  });

  return { rateLimiter };
}
