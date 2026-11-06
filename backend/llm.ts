import { OpenAI } from "https://esm.town/v/std/openai";
import {
  assertElicitation,
  assertIntakeRecord,
  buildPolishPrompt,
  buildSystemPrompt,
  buildValidationPrompt,
  ELICITATION_SCHEMA,
  INITIAL_ELICITATION,
  POLISH_SCHEMA,
  repairElicitation,
  VALIDATION_SCHEMA,
} from "../shared/catalog.ts";
import type {
  AnsweredField,
  AskElicitation,
  Elicitation,
  FieldAnswer,
  InputType,
  IntakeRecord,
  IntakeState,
  PolishSuggestionForEmpty,
} from "../shared/types.ts";

const MODEL = "gpt-5-nano";
const openai = new OpenAI();

interface ValidationResult {
  needs_clarification: boolean;
  field_id: string | null;
  field_label: string | null;
  reason: string | null;
  suggestions: string[];
}

const ORIGINAL_OVERRIDE = "Use my original answer anyway";

async function callElicitOnce(
  state: IntakeState,
  corrective?: string,
): Promise<unknown> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: buildSystemPrompt(state) },
  ];
  if (corrective) messages.push({ role: "system", content: corrective });
  messages.push({
    role: "user",
    content:
      "Emit the next elicitation as JSON matching the schema. " +
      "If every required slot is already answered, emit kind=complete.",
  });

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages,
    response_format: { type: "json_schema", json_schema: ELICITATION_SCHEMA },
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned no content");
  const parsed = JSON.parse(raw) as { elicitation: unknown };
  return parsed.elicitation;
}

/** Should we run the validator on this state?
 *  - Skip turn 0 (no answers yet).
 *  - Skip when the latest step is itself a verify or clarify (already gated).
 *  - Skip if the user just used "Use my original answer anyway" — they
 *    explicitly overrode our judgment, don't pester them about it again. */
function shouldValidate(state: IntakeState): boolean {
  const last = state.history[state.history.length - 1];
  if (!last) return false;
  if (last.kind !== "ask") return false;
  if (last.id.startsWith("clarify_")) {
    const overrode = last.fields.some(
      f => typeof f.value === "string" && f.value === ORIGINAL_OVERRIDE,
    );
    if (overrode) return false;
  }
  return true;
}

async function validate(state: IntakeState): Promise<ValidationResult | null> {
  if (!shouldValidate(state)) return null;
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: buildValidationPrompt(state) },
      { role: "user", content: "Return the validation JSON." },
    ],
    response_format: { type: "json_schema", json_schema: VALIDATION_SCHEMA },
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ValidationResult;
  } catch {
    return null;
  }
}

/** Look up an answered field by id in the latest ask step. */
function findAnsweredField(
  state: IntakeState,
  fieldId: string,
): AnsweredField | null {
  const last = state.history[state.history.length - 1];
  if (!last) return null;
  return last.fields.find(f => f.field_id === fieldId) ?? null;
}

/** Heuristic input_type — the user's original FieldSpec isn't preserved on
 *  the server, so we infer from the value shape and field_id pattern. */
function inferInputType(fieldId: string, value: unknown): InputType {
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "text";
  if (fieldId.includes("email")) return "email";
  if (fieldId.includes("date") || fieldId === "needed_by") return "date";
  if (fieldId === "description" || fieldId === "notes") return "textarea";
  return "text";
}

/** Build a "clarify" ask from a validator flag. We synthesize this ourselves
 *  rather than going through the LLM again — the validator already gave us
 *  the field id, reason, and suggestions, so a second LLM call is wasted. */
function clarifyAsk(
  state: IntakeState,
  v: ValidationResult,
): AskElicitation | null {
  if (!v.field_id) return null;
  const answered = findAnsweredField(state, v.field_id);
  const value = answered?.value;
  const label = v.field_label ?? answered?.label ?? v.field_id;
  const inputType = inferInputType(v.field_id, value);
  const multi = Array.isArray(value);
  // Honour the original FieldSpec's `required` if we preserved it on the
  // answered record; default to true (most fields are required and we'd
  // rather over-prompt than silently accept).
  const required = answered?.required ?? true;

  // Validator suggestions: keep up to 4, ALWAYS append the override option
  // (no padding with "(suggestion)" placeholder fluff anymore).
  const cleaned = (v.suggestions ?? [])
    .filter(s => s.trim().length > 0 && s !== ORIGINAL_OVERRIDE)
    .slice(0, 4);
  const suggestions = [...cleaned, ORIGINAL_OVERRIDE];

  const help = value === undefined || value === null
    ? null
    : `You entered: ${
      Array.isArray(value) ? value.join(", ") : String(value)
    }`;

  return {
    kind: "ask",
    id: `clarify_${v.field_id}`,
    title: "Quick check",
    intro: null,
    reason: v.reason ?? "This answer needs a closer look.",
    fields: [
      {
        id: v.field_id,
        label,
        help,
        input_type: inputType,
        suggestions,
        allow_custom: true,
        multi,
        required,
      },
    ],
  };
}

/** Asks the model for the next elicitation given the current state.
 *  Pipeline:
 *    turn 0  → INITIAL_ELICITATION (no LLM)
 *    turn N  → validator pass (separate focused LLM call)
 *              ↳ if flagged: synthesize a clarify ask, return
 *              ↳ otherwise: main nextElicitation call (with repair-or-retry)
 */
export async function nextElicitation(state: IntakeState): Promise<Elicitation> {
  if (state.history.length === 0) return INITIAL_ELICITATION;

  // Validation pass first.
  const v = await validate(state);
  if (v && v.needs_clarification) {
    const clarify = clarifyAsk(state, v);
    if (clarify) return clarify;
  }

  // Normal flow.
  const first = await callElicitOnce(state);
  const repaired = repairElicitation(first);
  try {
    assertElicitation(repaired);
    return repaired;
  } catch (e) {
    const reason = (e as Error).message;
    const second = await callElicitOnce(
      state,
      `Your previous output was rejected: "${reason}". ` +
        "Re-emit a valid Elicitation. CRITICAL: every ask field MUST have " +
        "at least 2 entries in suggestions[]; every verify section MUST have " +
        "at least 2 entries in amendment_suggestions[]; ask MUST include " +
        "reason (string or null).",
    );
    const repaired2 = repairElicitation(second);
    assertElicitation(repaired2);
    return repaired2;
  }
}

/** User-driven clarification: the user typed a free-form question because they
 *  are stuck on the current step. Returns a plain-text 2-3 sentence explanation.
 *  Out-of-band from the elicitation loop — does NOT alter history. The model is
 *  told NOT to ask anything back; it can only EXPLAIN. */
export async function explain(state: IntakeState, question: string): Promise<string> {
  const last = state.history[state.history.length - 1];
  const fieldLabels = last?.fields?.map(f => f.label).filter(Boolean).join(", ") ?? "the current step";
  const lastValues = last?.fields
    ?.map(f => `${f.label}=${JSON.stringify(f.value)}`)
    .join("; ") ?? "(none yet)";

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a friendly legal-intake assistant helping a colleague fill out an internal request form. " +
          "The user got stuck and typed a question because they don't know how to answer. " +
          "Your job is to EXPLAIN, not to elicit. " +
          "Hard rules:\n" +
          "1. Reply in 2-3 short sentences. Plain text only — no markdown, no bullet points, no headings.\n" +
          "2. NEVER ask the user a question back. NEVER tell them to clarify their request.\n" +
          "3. Use plain language. If a concrete example fits, give one (e.g. 'something like \"Acme Corp - SaaS renewal\"').\n" +
          "4. Stay grounded in the legal-intake context: the form gathers requester info, matter type (NDA, contract review, dispute, etc.), counterparties, urgency, budget, conflict-check ack, etc.\n\n" +
          `Current step asks about: ${fieldLabels}.\n` +
          `Values entered so far on this step: ${lastValues}.`,
      },
      { role: "user", content: question },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim();
  if (!raw) return "Sorry, I couldn't generate a clarification. Try rephrasing your question.";
  return raw;
}


// ---------- Polish (single confirmation step) ----------
//
// TWO jobs in one LLM call:
//   1. Polish grammar + description on the fields the user filled in.
//   2. For each empty field, judge whether the rest of the request implies
//      the user probably should have filled it in, and suggest a value.

/** Is this raw answer effectively empty? Booleans (incl. false) count as
 *  filled. */
function isEmptyAnswer(v: FieldAnswer | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export interface PolishResult {
  polished: IntakeRecord;
  suggestions_for_empty: PolishSuggestionForEmpty[];
}

/** Run polish + empty-field assessment for the user's raw answers. */
export async function polish(
  answers: Record<string, FieldAnswer>,
): Promise<PolishResult> {
  // Build the empty-field list directly off INITIAL_ELICITATION so the prompt
  // and the schema agree on which fields need an assessment.
  const initial = INITIAL_ELICITATION as AskElicitation;
  const emptyFieldIds = initial.fields
    .filter(f => isEmptyAnswer(answers[f.id]))
    .map(f => ({ id: f.id, label: f.label, required: f.required }));

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: buildPolishPrompt(answers, emptyFieldIds) },
      {
        role: "user",
        content:
          "Is this correct? Fix grammar and description, and assess every " +
          "empty field. Return JSON matching the schema.",
      },
    ],
    response_format: { type: "json_schema", json_schema: POLISH_SCHEMA },
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("polish: LLM returned no content");
  // Length only: the model rewrites the requester's own text, which must not reach logs.
  console.log("polish response chars:", raw.length);
  const parsed = JSON.parse(raw) as PolishResult;
  if (!parsed?.polished) {
    throw new Error(
      `polish: missing 'polished' key — got keys [${
        Object.keys(parsed ?? {}).join(", ")
      }]. Raw (first 600): ${raw.slice(0, 600)}`,
    );
  }
  assertIntakeRecord(parsed.polished);
  if (!Array.isArray(parsed.suggestions_for_empty)) {
    parsed.suggestions_for_empty = [];
  }
  return parsed;
}
