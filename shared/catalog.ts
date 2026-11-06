// The "catalog" — what the model is allowed to emit. Mirrors json-render's
// defineCatalog idea: a fixed schema + system prompt that locks the model's
// output. OpenAI's `response_format: json_schema, strict: true` rejects
// anything that doesn't validate.
//
// Three rules baked into prompt + schema:
//   1. Always offer ≥2 alternatives per field (even when free-form). The
//      user picks one or writes their own.
//   2. Always allow custom text via allow_custom: true.
//   3. Before kind=complete, the model MUST run kind=verify at least once
//      so the user can confirm/amend the captured information.

import type { Elicitation, IntakeRecord, IntakeState } from "./types.ts";

export const ELICITATION_SCHEMA = {
  name: "Elicitation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["elicitation"],
    properties: {
      elicitation: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id", "title", "intro", "reason", "fields"],
            properties: {
              kind: { type: "string", const: "ask" },
              id: { type: "string" },
              title: { type: "string" },
              intro: { type: ["string", "null"] },
              reason: { type: ["string", "null"] },
              fields: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "id",
                    "label",
                    "help",
                    "input_type",
                    "suggestions",
                    "allow_custom",
                    "multi",
                    "required",
                  ],
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    help: { type: ["string", "null"] },
                    input_type: {
                      type: "string",
                      enum: [
                        "text",
                        "textarea",
                        "email",
                        "number",
                        "date",
                        "boolean",
                      ],
                    },
                    // ≥2 alternatives is enforced in the prompt + assertion
                    // below (JSON schema can't do minItems together with all
                    // keys-required strict mode reliably across versions).
                    suggestions: {
                      type: "array",
                      items: { type: "string" },
                    },
                    allow_custom: { type: "boolean" },
                    multi: { type: "boolean" },
                    required: { type: "boolean" },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: [
              "kind",
              "id",
              "title",
              "intro",
              "sections",
              "followup_suggestions",
            ],
            properties: {
              kind: { type: "string", const: "verify" },
              id: { type: "string" },
              title: { type: "string" },
              intro: { type: "string" },
              followup_suggestions: {
                type: "array",
                items: { type: "string" },
              },
              sections: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "field_id",
                    "label",
                    "current_value",
                    "amendment_suggestions",
                    "allow_custom_amendment",
                  ],
                  properties: {
                    field_id: { type: "string" },
                    label: { type: "string" },
                    current_value: { type: "string" },
                    amendment_suggestions: {
                      type: "array",
                      items: { type: "string" },
                    },
                    allow_custom_amendment: { type: "boolean" },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "summary", "intake"],
            properties: {
              kind: { type: "string", const: "complete" },
              summary: { type: "string" },
              intake: {
                type: "object",
                additionalProperties: false,
                required: [
                  "requester_name",
                  "requester_email",
                  "requester_department",
                  "business_unit",
                  "matter_type",
                  "matter_type_other",
                  "short_title",
                  "description",
                  "counterparties",
                  "jurisdiction",
                  "urgency",
                  "needed_by",
                  "budget_estimate",
                  "external_counsel_requested",
                  "prior_matter_id",
                  "conflict_check_acknowledged",
                  "confidentiality_acknowledged",
                  "notes",
                  "extra_keys",
                  "extra_values",
                ],
                properties: {
                  requester_name: { type: "string" },
                  requester_email: { type: "string" },
                  requester_department: { type: ["string", "null"] },
                  business_unit: { type: ["string", "null"] },
                  matter_type: {
                    type: "string",
                    enum: [
                      "nda",
                      "contract_review",
                      "contract_drafting",
                      "dispute",
                      "ip",
                      "employment",
                      "privacy_data",
                      "regulatory",
                      "other",
                    ],
                  },
                  matter_type_other: { type: ["string", "null"] },
                  short_title: { type: "string" },
                  description: { type: "string" },
                  counterparties: {
                    type: "array",
                    items: { type: "string" },
                  },
                  jurisdiction: { type: ["string", "null"] },
                  urgency: {
                    type: "string",
                    enum: ["low", "medium", "high", "blocking_deal"],
                  },
                  needed_by: { type: ["string", "null"] },
                  budget_estimate: { type: ["string", "null"] },
                  external_counsel_requested: { type: ["boolean", "null"] },
                  prior_matter_id: { type: ["string", "null"] },
                  conflict_check_acknowledged: { type: "boolean" },
                  confidentiality_acknowledged: { type: "boolean" },
                  notes: { type: ["string", "null"] },
                  extra_keys: { type: "array", items: { type: "string" } },
                  extra_values: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        ],
      },
    },
  },
} as const;

/** Suggested slots in priority order. The model decides exact wording and
 *  which to combine into a single multi-field ask. Skipping is allowed when
 *  context says it's irrelevant (e.g. needed_by when urgency=low). Each slot
 *  declares which IntakeRecord fields it covers — used to compute "remaining"
 *  from history (the model is allowed to pack many slots into one ask). */
export const SUGGESTED_SLOTS: ReadonlyArray<{
  id: string;
  description: string;
  /** Field IDs this slot covers. A slot is "answered" once any of these has
   *  been answered in any history step (ask or verify). */
  field_ids: ReadonlyArray<string>;
}> = [
  {
    id: "requester",
    description: "name, email, department, business unit",
    field_ids: ["requester_name", "requester_email", "requester_department", "business_unit"],
  },
  { id: "matter_type", description: "category of legal work", field_ids: ["matter_type"] },
  { id: "short_title", description: "10-word title for the matter", field_ids: ["short_title"] },
  { id: "description", description: "what the matter is about", field_ids: ["description"] },
  { id: "counterparties", description: "external parties involved", field_ids: ["counterparties"] },
  {
    id: "jurisdiction",
    description: "governing law / jurisdiction (skip if internal-only)",
    field_ids: ["jurisdiction"],
  },
  { id: "urgency", description: "urgency level", field_ids: ["urgency"] },
  {
    id: "needed_by",
    description: "needed-by date (skip if urgency=low)",
    field_ids: ["needed_by", "needed_by_date"],
  },
  { id: "budget_estimate", description: "approximate budget", field_ids: ["budget_estimate"] },
  {
    id: "external_counsel",
    description: "external counsel needed?",
    field_ids: ["external_counsel_requested"],
  },
  {
    id: "prior_matter_id",
    description: "related prior matter id (skip if none)",
    field_ids: ["prior_matter_id"],
  },
  { id: "notes", description: "anything else legal should know", field_ids: ["notes"] },
  {
    id: "conflict_check",
    description: "user acknowledges conflict-check process",
    field_ids: ["conflict_check_acknowledged"],
  },
  {
    id: "confidentiality",
    description: "user acknowledges confidentiality",
    field_ids: ["confidentiality_acknowledged"],
  },
];

/** Did the user confirm every section in the most recent verify step?
 *  Verify steps record per-section "<field_id>__confirmed" booleans; if every
 *  one is true we know the user accepted the read-back as-is. */
function lastVerifyAllConfirmed(state: IntakeState): boolean {
  const lastVerify = [...state.history].reverse().find(h => h.kind === "verify");
  if (!lastVerify) return false;
  const flags = lastVerify.fields.filter(f => f.field_id.endsWith("__confirmed"));
  if (flags.length === 0) return false;
  return flags.every(f => f.value === true);
}

export function buildSystemPrompt(state: IntakeState): string {
  const answeredFieldIds = new Set<string>();
  for (const step of state.history) {
    for (const f of step.fields) answeredFieldIds.add(f.field_id);
  }
  const remaining = SUGGESTED_SLOTS.filter(
    s => !s.field_ids.some(fid => answeredFieldIds.has(fid)),
  );
  const verifyDone = state.history.some(h => h.kind === "verify");
  const allConfirmed = lastVerifyAllConfirmed(state);
  const prefillJson = JSON.stringify(state.prefill ?? {}, null, 2);
  // Compact history: drop labels, keep id/kind/field_id/value. Shaves ~50% off
  // the prompt-input cost and noticeably speeds up the model on later turns.
  const historyJson = JSON.stringify(
    state.history.map(h => ({
      id: h.id,
      kind: h.kind,
      fields: h.fields.map(f => ({ field_id: f.field_id, value: f.value })),
    })),
  );

  return `You are the legal-department intake assistant. You DO NOT chat. You DO
NOT explain. You emit ONE Elicitation object per turn — nothing else.

# Output contract
You must emit a single JSON object that matches the Elicitation schema:
- kind="ask"      collect one slot's worth of fields from the user.
- kind="verify"   read back captured info, ask the user to confirm/amend.
- kind="complete" only after at least one verify step the user confirmed.

# Hard rules — non-negotiable

1. **Offer alternatives where they make sense.** Each suggestion MUST be a
   value the user could legitimately submit as their answer.
   - Categorical fields (matter_type, urgency, boolean acks): include the
     canonical options as chips.
   - Free-form fields (short_title, description, notes): include 2-3
     plausible example phrasings.
   - Unique-identifier fields (requester_name, requester_email, business_unit
     when truly free-form): emit \`suggestions: []\` — there is no value any
     other person could share, so a chip would be a fake answer that ends up
     in the IntakeRecord verbatim. Let the user just type.
   NEVER use suggestions to convey instructions ("Use my full name", "Type a
   different address", "Provide a real value") — those become the literal
   answer when clicked.

2. **Always allow custom text.** Set \`allow_custom: true\` on every field
   unless the field is strictly an enum (matter_type, urgency, boolean
   confirmations) where free text would break the schema downstream.

3. **Verify before complete.** Before emitting kind="complete" you MUST emit
   kind="verify" at least once and the user must have confirmed every section
   (or amended it). If the user amended anything, re-verify or ask a targeted
   followup; only then complete.

4. **Sanity-check on the fly.** When a new answer contradicts an earlier one
   (e.g. urgency=low but needed_by=tomorrow), don't silently overwrite — emit
   an "ask" with a field that surfaces the conflict and offers both
   alternatives plus "neither — let me explain".

5. **Don't repeat yourself.** Never re-ask a slot you already have unless you
   are verifying it.

6. **Use stable ids.** Field ids must use the slot id from the suggested
   slots list (or a clear extension like "extra_<thing>"). Verify section
   field_ids must match the field ids you previously asked.

7. **No prose.** No markdown, no preamble, no apology. Just the JSON object.

8. **Array fields MUST be multi: true.** Fields whose IntakeRecord type is an
   array MUST be emitted with \`multi: true\` AND each chip suggestion MUST
   contain ONE entity, not a comma-joined list. The array fields are:
   counterparties, extra_keys, extra_values. Wrong: chips like
   \`"ABC Corp, XYZ Ltd"\`. Right: separate chips \`"ABC Corp"\`, \`"XYZ Ltd"\`,
   each with \`multi: true\` so the user can select several.

# Suggested slots (cover all that apply, in any order)
${SUGGESTED_SLOTS.map(s => `- ${s.id}: ${s.description}`).join("\n")}

# Prefill (already known — do NOT re-ask unless empty/wrong)
${prefillJson}

# History so far
${historyJson}

# Status
- Verify step run yet: ${verifyDone ? "YES" : "NO"}
- Last verify all-confirmed: ${allConfirmed ? "YES" : "NO"}
- Remaining slots: ${remaining.map(s => s.id).join(", ") || "(none)"}

# Decision (apply IN ORDER, take the first that matches)
1. If "Last verify all-confirmed" is YES: emit kind="complete" NOW. Build the
   IntakeRecord from history values. Do NOT ask anything else. Map
   empty/skipped nullable slots to null. Put uncategorized facts into notes
   and extras (extra_keys / extra_values, parallel arrays).
2. Else if remaining slots > 0: emit kind="ask" with reason=null. You may
   pack multiple slots into one ask when they're related (e.g. budget +
   external_counsel + acknowledgements).
3. Else (all slots covered, verify not yet run OR last verify had amendments):
   emit kind="verify". Sections must include every captured slot, with
   current_value as a short human-readable string and amendment_suggestions
   of length ≥2.

(A separate validator runs before this prompt and short-circuits on garbage —
you do NOT need to second-guess the user's content here.)`;
}

/** Field IDs whose IntakeRecord shape is `string[]` — these MUST be rendered
 *  with the multi-textarea UI, regardless of what the LLM emits in `multi`.
 *  The frontend defensively forces `multi: true` on these. */
export const ARRAY_FIELD_IDS: ReadonlyArray<string> = [
  "counterparties",
];

/** Field IDs that don't make sense to suggest values for — every user has a
 *  unique value (name, email, etc.). For these, an empty `suggestions: []`
 *  is preferred over fake placeholder chips that get clicked into IntakeRecord. */
export const UNIQUE_IDENTIFIER_FIELD_IDS: ReadonlyArray<string> = [
  "requester_name",
  "requester_email",
];

/** Strict-JSON schema for the focused validation call. Asks ONE question:
 *  is the most recent answer set obviously garbage? gpt-5-nano is small —
 *  giving it one tight job per call is more reliable than asking it to
 *  validate AND advance the flow in the same prompt. */
export const VALIDATION_SCHEMA = {
  name: "ValidationResult",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["needs_clarification", "field_id", "field_label", "reason", "suggestions"],
    properties: {
      needs_clarification: { type: "boolean" },
      field_id: { type: ["string", "null"] },
      field_label: { type: ["string", "null"] },
      reason: { type: ["string", "null"] },
      suggestions: { type: "array", items: { type: "string" } },
    },
  },
} as const;

/** Builds the validator prompt for the current state. Only the most recent
 *  ask step needs scrutiny — earlier steps were already validated. */
export function buildValidationPrompt(state: IntakeState): string {
  const last = state.history[state.history.length - 1];
  // Surface the per-field `required` flag so the validator doesn't flag
  // legitimately-empty optional fields. Default to true for back-compat.
  const fieldsCompact = last?.fields.map(f => ({
    field_id: f.field_id,
    label: f.label,
    required: f.required ?? true,
    value: f.value,
  })) ?? [];

  return `You are a strict validator for a legal intake form. Look at the
answers below and decide if any single field is OBVIOUSLY wrong.

Flag (needs_clarification=true) if a field is:
- gibberish: "asdf", "qwerty", "test", repeated chars, keyboard mashing
- placeholder: "xxx", "tbd", "n/a" when a real value was expected
- placeholder template values that look real: "my.name@company.com",
  "first.last@company.com", "user@example.com", "John Doe", "Jane Smith"
  (these are clearly example/template values from the suggestion chips)
- instruction-like strings that are not real values: "Use my full name",
  "Type a different address", "Provide your full name"
- format-wrong: email missing "@", date that isn't a date, number that isn't
- nonsense for the field: counterparty named "potato", budget="abc"
- way too short: description under ~10 chars, name=1 char
- MANDATORY ACKNOWLEDGEMENT SET TO FALSE: the fields
  conflict_check_acknowledged and confidentiality_acknowledged are mandatory
  legal acknowledgements — they MUST be true to proceed. If either is false,
  flag it. Use the special reason format below.

Do NOT flag:
- empty value when "required": false — the user is allowed to skip these
- valid-looking but unusual content (rare names, niche jurisdictions,
  small budgets, internal-only matters with no counterparties)

When flagging, set:
- field_id: id of the offending field
- field_label: the user-facing label for that field
- reason: a SHORT message (2-3 plain sentences) addressed to the user. Follow
  this exact pattern for normal flags:
  1. Say what looks unusual or off about the answer (do not be accusatory).
  2. Say "I've added a few examples below — feel free to pick one or write
     your own." (this references the suggestions chips you'll provide next).
  3. End with "If anything's unclear, click \"Stuck? Ask the assistant\"
     below and ask away." (this points to the help drawer at the bottom of
     the card).
  Keep it warm, not preachy. Never say "must", "incorrect", or "invalid".
  Example for a sketchy short_title:
    "The title \"asdf\" looks unusual for a matter title. I've added a few
     examples below — feel free to pick one or write your own. If anything's
     unclear, click \"Stuck? Ask the assistant\" below and ask away."

  SPECIAL CASE — required acknowledgement (conflict_check_acknowledged or
  confidentiality_acknowledged) set to false. Use this exact pattern:
  1. State what acknowledgement is mandatory and WHY in one sentence.
     Conflict check: "Acknowledging the conflict-check process is required
     so legal can verify the matter doesn't conflict with existing
     representations before they take it on."
     Confidentiality: "Acknowledging confidentiality is required so the
     details you share here are treated as protected legal communications."
  2. Tell the user how to proceed: "If you can acknowledge it, switch to Yes
     below."
  3. Tell them where to ask: "If you don't understand what this means or
     can't acknowledge it, click \"Stuck? Ask the assistant\" below — or
     reach out to legal directly before submitting."
  Full example for conflict_check set to false:
    "Acknowledging the conflict-check process is required so legal can verify
     the matter doesn't conflict with existing representations before they
     take it on. If you can acknowledge it, switch to Yes below. If you don't
     understand what this means or can't acknowledge it, click \"Stuck? Ask
     the assistant\" below — or reach out to legal directly before submitting."
- suggestions: 3-4 PLAUSIBLE CONCRETE example values the user could click
  to ACTUALLY USE as their answer (e.g. for a name: "Jane Smith",
  "Alex Johnson", "Sam Lee" — NOT instructions like "Provide your full name").
  The LAST entry MUST be EXACTLY equal to "Use my original answer anyway"
  so the user can override your judgment.
  EXCEPTION — for required acknowledgements set to false, suggestions should
  be exactly ["Yes — I acknowledge", "Use my original answer anyway"]. Do not
  pad with other options; the user is choosing whether to acknowledge or stop.

When everything looks fine, set needs_clarification=false, all other fields to
null/empty.

# Most recent answers (each with its required flag)
${JSON.stringify(fieldsCompact, null, 2)}`;
}

/** Single-page intake form. Collects EVERYTHING up front so the user fills out
 *  one big form, then sees ONE confirmation step (AI-polished) before submit.
 *  No multi-turn LLM elicitation loop. */
export const INITIAL_ELICITATION: Elicitation = {
  kind: "ask",
  id: "intake",
  title: "Legal intake request",
  intro:
    "Fill out everything you can. The assistant will polish grammar and " +
    "phrasing on the next step — you'll get a chance to review and edit " +
    "before anything is submitted.",
  reason: null,
  fields: [
    // ---- Requester ----
    {
      id: "requester_name",
      label: "Your name",
      help: null,
      input_type: "text",
      suggestions: [],
      allow_custom: true,
      multi: false,
      required: true,
    },
    {
      id: "requester_email",
      label: "Work email",
      help: null,
      input_type: "email",
      suggestions: [],
      allow_custom: true,
      multi: false,
      required: true,
    },
    {
      id: "requester_department",
      label: "Department",
      help: "Optional",
      input_type: "text",
      suggestions: ["Engineering", "Sales", "Finance", "HR", "Product"],
      allow_custom: true,
      multi: false,
      required: false,
    },
    {
      id: "business_unit",
      label: "Business unit",
      help: "Optional",
      input_type: "text",
      suggestions: [],
      allow_custom: true,
      multi: false,
      required: false,
    },
    // ---- Matter ----
    {
      id: "matter_type",
      label: "Matter type",
      help: "What kind of legal work is this?",
      input_type: "text",
      suggestions: [
        "NDA",
        "Contract review",
        "Contract drafting",
        "Dispute",
        "IP",
        "Employment",
        "Privacy / data",
        "Regulatory",
        "Other",
      ],
      allow_custom: true,
      multi: false,
      required: true,
    },
    {
      id: "short_title",
      label: "Short title",
      help: "A 5-10 word headline for the matter (e.g. \"Acme Corp - SaaS renewal\").",
      input_type: "text",
      suggestions: [],
      allow_custom: true,
      multi: false,
      required: true,
    },
    {
      id: "description",
      label: "Description",
      help: "A few sentences on what's going on. Don't worry about grammar — the assistant will polish it on the next step.",
      input_type: "textarea",
      suggestions: [],
      allow_custom: true,
      multi: false,
      required: true,
    },
    {
      id: "counterparties",
      label: "Counterparties",
      help: "External parties involved. Add one per line, or leave blank if internal-only.",
      input_type: "text",
      suggestions: [],
      allow_custom: true,
      multi: true,
      required: false,
    },
    {
      id: "jurisdiction",
      label: "Jurisdiction / governing law",
      help: "Optional — skip if internal-only.",
      input_type: "text",
      suggestions: ["Delaware", "New York", "California", "England & Wales", "EU"],
      allow_custom: true,
      multi: false,
      required: false,
    },
    // ---- Timing & cost ----
    {
      id: "urgency",
      label: "Urgency",
      help: null,
      input_type: "text",
      suggestions: ["Low", "Medium", "High", "Blocking a deal"],
      allow_custom: false,
      multi: false,
      required: true,
    },
    {
      id: "needed_by",
      label: "Needed by",
      help: "Optional. Skip if urgency is low.",
      input_type: "date",
      suggestions: [],
      allow_custom: true,
      multi: false,
      required: false,
    },
    {
      id: "budget_estimate",
      label: "Approximate budget",
      help: "Optional — a rough range is fine.",
      input_type: "text",
      suggestions: ["< $5k", "$5k - $25k", "$25k - $100k", "> $100k", "Unknown"],
      allow_custom: true,
      multi: false,
      required: false,
    },
    {
      id: "external_counsel_requested",
      label: "External counsel requested?",
      help: "Do you specifically want outside lawyers involved?",
      input_type: "boolean",
      suggestions: [],
      allow_custom: false,
      multi: false,
      required: false,
    },
    {
      id: "prior_matter_id",
      label: "Related prior matter ID",
      help: "Optional — if this connects to a previous intake.",
      input_type: "text",
      suggestions: [],
      allow_custom: true,
      multi: false,
      required: false,
    },
    {
      id: "notes",
      label: "Anything else legal should know",
      help: "Optional.",
      input_type: "textarea",
      suggestions: [],
      allow_custom: true,
      multi: false,
      required: false,
    },
    // ---- Acknowledgements ----
    {
      id: "conflict_check_acknowledged",
      label: "I acknowledge the conflict-check process",
      help:
        "Legal needs to verify this matter doesn't conflict with existing representations before they take it on.",
      input_type: "boolean",
      suggestions: [],
      allow_custom: false,
      multi: false,
      required: true,
    },
    {
      id: "confidentiality_acknowledged",
      label: "I acknowledge confidentiality",
      help: "Details shared here are treated as protected legal communications.",
      input_type: "boolean",
      suggestions: [],
      allow_custom: false,
      multi: false,
      required: true,
    },
  ],
};

/** Repair common LLM mistakes BEFORE the strict assertion runs:
 *  - <2 suggestions per field → pad with neutral fallbacks.
 *  - <2 amendment_suggestions per verify section → pad similarly.
 *  Returns the (possibly mutated) elicitation. Never throws. */
export function repairElicitation(value: unknown): Elicitation | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "ask" && Array.isArray(v.fields)) {
    if (typeof v.reason !== "string" && v.reason !== null) v.reason = null;
    v.fields = (v.fields as Record<string, unknown>[]).map(f => {
      // Defensive: array-shaped fields MUST be multi=true regardless of LLM.
      if (typeof f.id === "string" && ARRAY_FIELD_IDS.includes(f.id)) {
        f.multi = true;
      }
      const sugg = Array.isArray(f.suggestions) ? (f.suggestions as string[]) : [];
      // For unique identifier fields, drop suggestions entirely — placeholder
      // chips just become bad data when clicked. For everything else, leave as-is.
      if (typeof f.id === "string" && UNIQUE_IDENTIFIER_FIELD_IDS.includes(f.id)) {
        return { ...f, suggestions: [] };
      }
      return { ...f, suggestions: sugg };
    });
  }
  if (v.kind === "verify" && Array.isArray(v.sections)) {
    v.sections = (v.sections as Record<string, unknown>[]).map(s => {
      const sugg = Array.isArray(s.amendment_suggestions)
        ? (s.amendment_suggestions as string[])
        : [];
      return { ...s, amendment_suggestions: sugg };
    });
  }
  return v as unknown as Elicitation;
}

/** Belt-and-suspenders runtime checks on top of strict json schema. */
export function assertElicitation(value: unknown): asserts value is Elicitation {
  if (!value || typeof value !== "object") throw new Error("not an object");
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== "string") throw new Error("missing kind");

  if (v.kind === "ask") {
    if (!Array.isArray(v.fields) || v.fields.length === 0) {
      throw new Error("ask.fields empty");
    }
    for (const f of v.fields as Record<string, unknown>[]) {
      const sugg = f.suggestions;
      if (!Array.isArray(sugg)) {
        throw new Error(`field ${String(f.id)}: suggestions must be an array`);
      }
      // Empty suggestions are legal for unique-identifier fields where any
      // template chip would be a fake answer (see ISSUE-001 in dogfood).
    }
    return;
  }
  if (v.kind === "verify") {
    if (!Array.isArray(v.sections) || v.sections.length === 0) {
      throw new Error("verify.sections empty");
    }
    return;
  }
  if (v.kind === "complete") {
    assertIntakeRecord((v as { intake: unknown }).intake);
    return;
  }
  throw new Error(`bad kind ${v.kind}`);
}

export function assertIntakeRecord(value: unknown): asserts value is IntakeRecord {
  if (!value || typeof value !== "object") throw new Error("not an object");
  const v = value as Record<string, unknown>;
  for (const k of [
    "requester_name",
    "requester_email",
    "matter_type",
    "short_title",
    "description",
    "urgency",
  ]) {
    if (typeof v[k] !== "string") throw new Error(`missing ${k}`);
  }
}


// ---------- Polish (single confirmation step) ----------
//
// After the user fills out the single-page intake, we send their answers to
// the AI with one prompt: "is this correct? Fix grammar and description."
// The model returns a polished IntakeRecord. The confirmation screen renders
// these polished values in editable fields so the user can freely modify them
// before submitting. The model is NEVER asked to invent missing values — it
// only cleans up what the user already wrote.

export const POLISH_SCHEMA = {
  name: "PolishedIntake",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["polished", "suggestions_for_empty"],
    properties: {
      polished: {
        type: "object",
        additionalProperties: false,
        required: [
          "requester_name",
          "requester_email",
          "requester_department",
          "business_unit",
          "matter_type",
          "matter_type_other",
          "short_title",
          "description",
          "counterparties",
          "jurisdiction",
          "urgency",
          "needed_by",
          "budget_estimate",
          "external_counsel_requested",
          "prior_matter_id",
          "conflict_check_acknowledged",
          "confidentiality_acknowledged",
          "notes",
          "extra_keys",
          "extra_values",
        ],
        properties: {
          requester_name: { type: "string" },
          requester_email: { type: "string" },
          requester_department: { type: ["string", "null"] },
          business_unit: { type: ["string", "null"] },
          matter_type: {
            type: "string",
            enum: [
              "nda",
              "contract_review",
              "contract_drafting",
              "dispute",
              "ip",
              "employment",
              "privacy_data",
              "regulatory",
              "other",
            ],
          },
          matter_type_other: { type: ["string", "null"] },
          short_title: { type: "string" },
          description: { type: "string" },
          counterparties: { type: "array", items: { type: "string" } },
          jurisdiction: { type: ["string", "null"] },
          urgency: {
            type: "string",
            enum: ["low", "medium", "high", "blocking_deal"],
          },
          needed_by: { type: ["string", "null"] },
          budget_estimate: { type: ["string", "null"] },
          external_counsel_requested: { type: ["boolean", "null"] },
          prior_matter_id: { type: ["string", "null"] },
          conflict_check_acknowledged: { type: "boolean" },
          confidentiality_acknowledged: { type: "boolean" },
          notes: { type: ["string", "null"] },
          extra_keys: { type: "array", items: { type: "string" } },
          extra_values: { type: "array", items: { type: "string" } },
        },
      },
      suggestions_for_empty: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field_id", "should_fill", "reason", "suggested_value"],
          properties: {
            field_id: { type: "string" },
            should_fill: { type: "boolean" },
            reason: { type: "string" },
            suggested_value: { type: "string" },
          },
        },
      },
    },
  },
} as const;

/** Builds the polish prompt. The model's ONLY job is grammar + clarity. */
export function buildPolishPrompt(
  rawAnswers: Record<string, unknown>,
  emptyFieldIds: ReadonlyArray<{ id: string; label: string; required: boolean }>,
): string {
  const emptyFieldsJson = JSON.stringify(emptyFieldIds, null, 2);
  return `You are reviewing a legal-intake form a colleague just filled out.

Your single task: **is this correct? Fix grammar and description.**

Rules:
1. Fix obvious typos, capitalization, and grammar in free-text fields
   (especially short_title, description, notes, counterparty names).

   CRITICAL — short_title: preserve the USER'S original meaning and wording.
   Only fix capitalization, trim whitespace, or correct clear typos. Do NOT
   replace the user's short_title with a completely different phrase. If the
   original is "Need marketing for marketing", polish to "Marketing request"
   or similar — keep it recognizable. NEVER output something unrelated like
   "Funny note" when that wasn't the user's intent. If you don't understand
   what the user meant, output their exact original text — don't guess.

2. Rewrite the description so it reads as a clear, professional summary —
   2-4 sentences max. Preserve every fact the user gave. Do NOT invent facts,
   parties, dates, or amounts. Do NOT add disclaimers or boilerplate.

3. Normalize categorical fields to their enum values:
   - matter_type: one of nda, contract_review, contract_drafting, dispute,
     ip, employment, privacy_data, regulatory, other. If "Other", PRESERVE
     the user's matter_type_other value exactly — do not change or drop it.
   - urgency: one of low, medium, high, blocking_deal.

4. Leave empty/null fields as null. Do not fill them in.
5. Keep boolean acknowledgements exactly as the user set them.
6. counterparties: trim each entry, drop empties, keep order.
7. extra_keys / extra_values: empty arrays unless the user wrote something
   that doesn't fit any canonical slot.

8. **When in doubt, pour through the original.** If you cannot meaningfully
   improve a free-text field, output the user's exact original value. Do NOT
   replace a specific user value with a vague or unrelated placeholder. Do
   NOT output instructions, meta-commentary, or template text like "The AI
   polished this" — the user sees this value directly.

SECONDARY TASK — assess empty fields:
For each field the user left blank, judge whether the rest of the request
implies the user should probably fill it in. Return your assessment in
suggestions_for_empty[].
- should_fill: true if the rest of the request implies this matters
- reason: 1-2 sentences explaining your judgment
- suggested_value: a concrete value (empty string if should_fill=false)
  - date fields → ISO YYYY-MM-DD
  - boolean fields → "true" or "false"
  - multi-value fields → one per line joined with "\\n"

Return { polished: { ...polished IntakeRecord... }, suggestions_for_empty: [...] }
matching the PolishedIntake JSON schema.

# Raw answers from the user
${JSON.stringify(rawAnswers, null, 2)}

# Empty fields to assess
${emptyFieldsJson}`;
}


// ---------- Empty-field assessment (second confirmation call) ----------
//
// Runs in parallel with the polish call. The user already submitted whatever
// they wanted on the front page; this pass looks at the EMPTY fields and
// judges — given the rest of the request — whether each was probably an
// oversight, with a suggested value the user can one-click accept on the
// confirmation screen.

export const EMPTY_ASSESSMENT_SCHEMA = {
  name: "EmptyFieldAssessment",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["suggestions_for_empty"],
    properties: {
      suggestions_for_empty: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field_id", "should_fill", "reason", "suggested_value"],
          properties: {
            field_id: { type: "string" },
            should_fill: { type: "boolean" },
            reason: { type: "string" },
            suggested_value: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export function buildEmptyAssessmentPrompt(
  rawAnswers: Record<string, unknown>,
  emptyFields: ReadonlyArray<{ id: string; label: string; required: boolean }>,
): string {
  return `You're reviewing a legal-intake form a colleague filled out. They
left some fields BLANK. Your job is to judge — given the rest of the
request — whether each blank field was probably an oversight worth filling
in, or whether leaving it blank is perfectly fine.

For each empty field, return one entry with:
- field_id: the field's id (use exactly the id given below)
- should_fill: true if the rest of the request implies this field matters
  here, false if it's genuinely fine to skip
- reason: 1-2 short, warm sentences explaining your judgment. Address the
  user directly ("You mentioned…", "Since this is an NDA…", "Given urgency
  is high…"). When should_fill=false, briefly say why skipping is fine.
- suggested_value: a concrete value the user could one-click accept. Empty
  string ("") when should_fill=false, OR when no value can be reasonably
  inferred from context. Format hints:
    - date fields → ISO YYYY-MM-DD
    - boolean fields → "true" or "false"
    - multi-value fields (counterparties) → one per line, joined with "\\n"

Heuristics to apply:
- jurisdiction: should_fill=true if counterparties exist or matter_type
  involves contracts/disputes/IP; otherwise false.
- needed_by: should_fill=true if urgency is high or blocking_deal; false
  if urgency is low.
- counterparties: should_fill=true unless the description clearly says it's
  an internal-only matter (e.g. employment, internal policy).
- budget_estimate: should_fill=true if external_counsel_requested=true or
  matter_type involves litigation/major contracts; otherwise false.
- external_counsel_requested: should_fill=true for disputes or large
  contract matters; otherwise false.
- notes: should_fill=false unless the description clearly hints at extra
  context that obviously belongs in notes.
- requester_department / business_unit: should_fill=false (always optional).
- prior_matter_id: should_fill=false unless the description references a
  prior matter.
- matter_type_other: should_fill=true ONLY when matter_type=other.

Return EXACTLY one entry per empty field id listed below, in the same order.

# Empty field ids to assess
${JSON.stringify(emptyFields, null, 2)}

# Filled answers from the user (for context)
${JSON.stringify(rawAnswers, null, 2)}

Return the JSON object matching the schema.`;
}
