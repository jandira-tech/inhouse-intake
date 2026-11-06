// Bearer-token gate for the routes that read stored records.
// No SQLite / OpenAI / esm.town imports, so it is unit-testable offline
// (auth_test.ts). Fails closed: with ADMIN_TOKEN unset, nobody can read.
import type { Hono, MiddlewareHandler } from "npm:hono@4.13.12";

/** Every route that returns stored records. Keep in sync with index.http.tsx. */
export const READ_PATHS = ["/api/intakes", "/api/intakes/*"];
// playbook-from-doc: ["/api/playbooks", "/api/playbooks/*"]

/** Compare without an early exit, so timing does not reveal a matching prefix. */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * 503 when no token is configured, 401 when the caller's
 * `Authorization: Bearer <token>` does not match, otherwise pass through.
 */
export function adminOnly(getToken: () => string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const token = (getToken() ?? "").trim();
    c.header("Cache-Control", "no-store");
    if (!token) {
      return c.json({ error: "read access is not configured" }, 503);
    }
    if (!safeEqual(c.req.header("authorization") ?? "", `Bearer ${token}`)) {
      c.header("WWW-Authenticate", 'Bearer realm="admin"');
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

/** Install the gate on every READ_PATHS entry. Call BEFORE the routes are declared. */
export function protectReads(app: Hono, getToken: () => string | undefined): void {
  const gate = adminOnly(getToken);
  for (const path of READ_PATHS) app.use(path, gate);
}
