import { Hono } from "npm:hono@4.13.12";
import { readFile, serveFile } from "https://esm.town/v/std/utils/index.ts";
import { listIntakes, saveIntake } from "./db.ts";
import { explain, nextElicitation, polish } from "./llm.ts";
import { protectReads } from "./auth.ts";
import { InvalidIntakeError, persistenceEnabled, submitIntake } from "./submit.ts";
import { createLimiter, limitModelCalls } from "./ratelimit.ts";
import type {
  ElicitRequest,
  ElicitResponse,
  HelpRequest,
  HelpResponse,
  PolishRequest,
  PolishResponse,
  SubmitRequest,
  SubmitResponse,
} from "../shared/types.ts";

const app = new Hono();

// Bubble up real errors instead of silently 500-ing.
// Answer JSON, never a platform error page. Only the message is logged, never the
// request body: intakes carry people's names and confidential facts.
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  // Model and parser errors can include user-supplied text. Never log them.
  console.error("[legal-intake] request failed");
  if (err instanceof SyntaxError) {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (err instanceof InvalidIntakeError) return c.json({ error: err.message }, 400);
  if (/\b429\b|rate limit/i.test(message)) {
    return c.json({ error: "The model is busy; try again in a minute." }, 429);
  }
  return c.json({ error: "The model call failed; try again." }, 502);
});

/** Reject path traversal in static asset routes (decodes, then checks for `..`). */
function isSafeAssetPath(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  return !decoded.replace(/\\/g, "/").includes("..");
}

// Stored intakes are readable only with ADMIN_TOKEN (fails closed when unset).
// Must be registered before the routes it protects.
protectReads(app, () => Deno.env.get("ADMIN_TOKEN"));
limitModelCalls(app, ["/api/elicit", "/api/help", "/api/polish"], createLimiter(), 64 * 1024);

// ---------- Static frontend ----------

app.get("/frontend/*", c =>
  isSafeAssetPath(c.req.path) ? serveFile(c.req.path, import.meta.url) : c.text("Forbidden", 403));
app.get("/shared/*", c =>
  isSafeAssetPath(c.req.path) ? serveFile(c.req.path, import.meta.url) : c.text("Forbidden", 403));

app.get("/", async c => {
  const html = await readFile("/frontend/index.html", import.meta.url);
  return c.html(html);
});

// ---------- API ----------

app.post("/api/elicit", async c => {
  const body = (await c.req.json()) as ElicitRequest;
  if (!body?.state) return c.json({ error: "missing state" }, 400);
  const elicitation = await nextElicitation(body.state);
  const response: ElicitResponse = { elicitation };
  return c.json(response);
});

app.post("/api/help", async c => {
  const body = (await c.req.json()) as HelpRequest;
  if (!body?.state) return c.json({ error: "missing state" }, 400);
  if (!body?.question || typeof body.question !== "string" || !body.question.trim()) {
    return c.json({ error: "missing question" }, 400);
  }
  const explanation = await explain(body.state, body.question.trim());
  const response: HelpResponse = { explanation };
  return c.json(response);
});

app.post("/api/polish", async c => {
  const body = (await c.req.json()) as PolishRequest;
  if (!body?.answers || typeof body.answers !== "object") {
    return c.json({ error: "missing answers" }, 400);
  }
  console.log("[polish] received answers, keys:", Object.keys(body.answers));
  const result = await polish(body.answers);
  console.log("[polish] success, suggestions:", result.suggestions_for_empty?.length);
  const response: PolishResponse = {
    polished: result.polished,
    suggestions_for_empty: result.suggestions_for_empty,
  };
  return c.json(response);
});

app.post("/api/submit", async c => {
  const body = (await c.req.json()) as SubmitRequest;
  const response: SubmitResponse = await submitIntake(body?.intake, Deno.env.get("ADMIN_TOKEN"), saveIntake);
  return c.json(response);
});

app.get("/api/mode", c => c.json({ demo: !persistenceEnabled(Deno.env.get("ADMIN_TOKEN")) }));

// Read-only admin view, behind the ADMIN_TOKEN gate (backend/auth.ts).
app.get("/api/intakes", async c => {
  const rows = await listIntakes();
  return c.json({ intakes: rows });
});

export default app.fetch;
