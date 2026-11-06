import { Hono } from "npm:hono@4.13.12";
import { adminOnly } from "./auth.ts";
import { persistenceEnabled, submitIntake } from "./submit.ts";
import { createLimiter, limitModelCalls } from "./ratelimit.ts";

const intake = { requester_name:"Fictional User", requester_email:"fictional@example.com", matter_type:"other", short_title:"Test", description:"Fictional matter", urgency:"normal", conflict_check_acknowledged:true, confidentiality_acknowledged:true };
Deno.test("demo submission validates but never calls storage; configured mode persists", async () => {
  let calls = 0;
  const save = () => { calls++; return Promise.resolve(42); };
  for (const token of [undefined, "", "  "]) {
    const result = await submitIntake(intake, token, save);
    if (!result.demo || calls !== 0 || persistenceEnabled(token)) throw new Error("demo persisted");
  }
  const stored = await submitIntake(intake, "configured", save);
  if (stored.demo || stored.intake_id !== 42 || Number(calls) !== 1) throw new Error("configured mode failed");
  let rejected = false;
  try { await submitIntake({}, undefined, save); } catch { rejected = true; }
  if (!rejected) throw new Error("invalid records must be rejected before demo result");
  rejected = false;
  try { await submitIntake({ ...intake, confidentiality_acknowledged: false }, "configured", save); } catch { rejected = true; }
  if (!rejected || Number(calls) !== 1) throw new Error("missing acknowledgements must not be stored");
});
Deno.test("admin reads fail closed and require bearer token", async () => {
  const app = new Hono(); let token: string | undefined;
  app.use("/private", adminOnly(() => token)); app.get("/private", c => c.json({ok:true}));
  if ((await app.request("/private")).status !== 503) throw new Error("unconfigured should fail closed");
  token = "secret";
  if ((await app.request("/private")).status !== 401) throw new Error("missing token accepted");
  if ((await app.request("/private", {headers:{Authorization:"Bearer secret"}})).status !== 200) throw new Error("valid token rejected");
});
Deno.test("model guard limits requests and oversized bodies", async () => {
  const app = new Hono();
  limitModelCalls(app, ["/model"], createLimiter(() => 1), 16);
  app.post("/model", c => c.text("ok"));
  if ((await app.request("/model", {method:"POST", body:"x".repeat(17)})).status !== 413) throw new Error("size guard failed");
  for (let i = 0; i < 6; i++) if ((await app.request("/model", {method:"POST", body:"{}"})).status !== 200) throw new Error("request incorrectly limited");
  if ((await app.request("/model", {method:"POST", body:"{}"})).status !== 429) throw new Error("rate guard failed");
});
