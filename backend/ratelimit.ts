// Limits on the routes that call the model (publicize plan 06, step 6).
// Every arthrod val on std/openai shares one 10-per-minute quota, so a single visitor
// must not be able to spend it: 8 calls per caller per 10 minutes, 6 per minute for the
// whole val (leaving room for the other vals), and a body-size cap.
// Counters live in this isolate's memory: no extra network round-trip per call, and an
// approximation when Val Town runs several isolates. No SQLite / OpenAI imports, so it
// is testable offline (ratelimit_test.ts).
import type { Context, Hono, Next } from "npm:hono@4.13.12";

export const LIMITS = { perIp: 8, perIpWindowMs: 600_000, global: 6, globalWindowMs: 60_000 };

/** Pure decision from the counts already in the two windows. */
export function decide(perIpCount: number, globalCount: number): { ok: boolean; retryAfterS?: number } {
  if (globalCount >= LIMITS.global) return { ok: false, retryAfterS: Math.ceil(LIMITS.globalWindowMs / 1000) };
  if (perIpCount >= LIMITS.perIp) return { ok: false, retryAfterS: Math.ceil(LIMITS.perIpWindowMs / 1000) };
  return { ok: true };
}

export interface Limiter {
  /** Record a call if allowed; returns the decision. */
  take(ip: string): { ok: boolean; retryAfterS?: number };
}

export function createLimiter(now: () => number = Date.now): Limiter {
  const perIp = new Map<string, number[]>();
  let global: number[] = [];
  return {
    take(ip: string) {
      const t = now();
      global = global.filter((x) => t - x < LIMITS.globalWindowMs);
      const mine = (perIp.get(ip) ?? []).filter((x) => t - x < LIMITS.perIpWindowMs);
      const verdict = decide(mine.length, global.length);
      if (verdict.ok) {
        mine.push(t);
        global.push(t);
      }
      if (mine.length) perIp.set(ip, mine);
      else perIp.delete(ip);
      return verdict;
    },
  };
}

function callerIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  return (forwarded?.split(",")[0] ?? c.req.header("cf-connecting-ip") ?? "unknown").trim();
}

/** Install the caps on the model routes. Call BEFORE the routes are declared. */
export function limitModelCalls(app: Hono, paths: string[], limiter: Limiter, maxBytes: number): void {
  const gate = async (c: Context, next: Next) => {
    // Content-Length when sent; otherwise measure (chunked bodies carry no header).
    const header = c.req.header("content-length");
    const length = header !== undefined
      ? Number(header)
      : (await c.req.raw.clone().arrayBuffer()).byteLength;
    if (length > maxBytes) {
      return c.json({ error: `request too large (max ${Math.round(maxBytes / 1024)} KB)` }, 413);
    }
    const verdict = limiter.take(callerIp(c));
    if (!verdict.ok) {
      c.header("Retry-After", String(verdict.retryAfterS ?? 60));
      return c.json({ error: "Too many requests to the model; try again in a minute." }, 429);
    }
    await next();
  };
  for (const path of paths) app.use(path, gate);
}
