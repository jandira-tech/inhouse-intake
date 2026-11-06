// Shared types - must run in both browser and Deno.
// No `Deno.*` references in this file.

export type MatterType =
  | "nda"
  | "contract_review"
  | "contract_drafting"
  | "dispute"
  | "ip"
  | "employment"
  | "privacy_data"
  | "regulatory"
  | "other";

export type Urgency = "low" | "medium" | "high" | "blocking_deal";

/** Canonical legal-intake record produced at completion.
 *  Kept relatively flexible: most fields are nullable, plus a free-form
 *  `notes` and `extra` map for anything the model gathered beyond the slots. */
export interface IntakeRecord {
  requester_name: string;
  requester_email: string;
  requester_department: string | null;
  business_unit: string | null;
  matter_type: MatterType;
  matter_type_other: string | null;
  short_title: string;
  description: string;
  counterparties: string[];
  jurisdiction: string | null;
  urgency: Urgency;
  needed_by: string | null; // ISO date
  budget_estimate: string | null;
  external_counsel_requested: boolean | null;
  prior_matter_id: string | null;
  conflict_check_acknowledged: boolean;
  confidentiality_acknowledged: boolean;
  notes: string | null;
  /** Any extra structured data the model captured beyond the canonical slots.
   *  Stored as parallel arrays so it survives strict JSON schema. */
  extra_keys: string[];
  extra_values: string[];
}

/** Per-field answer the user gave. */
export type FieldAnswer = string | string[] | boolean | null;

export interface AnsweredField {
  field_id: string;
  label: string;
  value: FieldAnswer;
  /** Preserved from the original FieldSpec so the validator + clarify path can
   *  honour the original optionality. Optional for back-compat with older
   *  history rows that pre-date this field. */
  required?: boolean;
}

export interface IntakeStep {
  /** Stable id from the elicitation (e.g. "matter_type", "verify_1"). */
  id: string;
  kind: ElicitationKind;
  title: string;
  /** Field-level answers from this step. */
  fields: AnsweredField[];
}

export interface IntakeState {
  session_id: string;
  history: IntakeStep[];
  prefill: Partial<IntakeRecord>;
}

// ---------- Elicitation specs the model is allowed to emit ----------

export type ElicitationKind = "ask" | "verify" | "complete";

export type InputType =
  | "text"
  | "textarea"
  | "email"
  | "number"
  | "date"
  | "boolean";

/** A single field within an `ask`. Always carries suggestions[] (≥2) and
 *  allow_custom: true so the user can pick or write their own answer. */
export interface FieldSpec {
  id: string;
  label: string;
  help: string | null;
  input_type: InputType;
  /** Model MUST provide at least 2 suggested alternatives — even for free-form
   *  questions, suggestions act as starting points the user can edit. */
  suggestions: string[];
  /** True ⇒ user can write their own answer in addition to suggestions. */
  allow_custom: boolean;
  /** True ⇒ user can pick multiple suggestions (checkbox). */
  multi: boolean;
  required: boolean;
}

export interface AskElicitation {
  kind: "ask";
  /** Slot id this step is collecting (e.g. "matter_type"). Multiple fields can
   *  belong to one slot — e.g. requester step has name + email + dept. */
  id: string;
  title: string;
  intro: string | null;
  fields: FieldSpec[];
  /** When this ask is a follow-up after the model flagged the previous answer
   *  as invalid/garbage/contradictory, this is a 1-2 sentence explanation the
   *  user sees as an amber callout. Null on a normal ask. */
  reason: string | null;
}

/** Verify step: model reads back what it captured. Each section is a labelled
 *  fact with its current value and 2+ amendment suggestions. */
export interface VerifySection {
  field_id: string;
  label: string;
  current_value: string;
  amendment_suggestions: string[];
  allow_custom_amendment: boolean;
}

export interface VerifyElicitation {
  kind: "verify";
  id: string;
  title: string;
  intro: string;
  sections: VerifySection[];
  /** Model must propose at least one followup question if anything looks off
   *  (e.g. inconsistency, missing context). Empty array is allowed when clean. */
  followup_suggestions: string[];
}

export interface CompleteElicitation {
  kind: "complete";
  summary: string;
  intake: IntakeRecord;
}

export type Elicitation = AskElicitation | VerifyElicitation | CompleteElicitation;

// ---------- API payloads ----------

/** Verification answers from the user: per-section either confirm or amend. */
export interface VerifyAnswerSection {
  field_id: string;
  confirmed: boolean;
  amended_value: string | null;
}

export interface ElicitRequest {
  state: IntakeState;
}

export interface ElicitResponse {
  elicitation: Elicitation;
}

export interface SubmitRequest {
  intake: IntakeRecord;
}

export interface SubmitResponse {
  ok: true;
  intake_id: number;
  demo?: boolean;
}

/** User-driven clarification: when the user is stuck on a question, they can
 *  ask the assistant for a plain-language explanation in their own words.
 *  This is OUT-OF-BAND from the elicitation loop — it does NOT push to
 *  history and does NOT alter the next elicitation. */
export interface HelpRequest {
  state: IntakeState;
  question: string;
}

export interface HelpResponse {
  explanation: string;
}


// ---------- Polish (single confirmation step) ----------
//
// After the user fills out the one-page intake, the frontend POSTs the raw
// answers to /api/polish. The server asks the AI: "is this correct? Fix
// grammar and description." and returns a polished IntakeRecord. The
// confirmation screen renders the polished values in freely-editable fields.

export interface PolishRequest {
  /** The raw field answers the user submitted on the front page, keyed by
   *  field id. Values are FieldAnswer-shaped (string | string[] | boolean
   *  | null). */
  answers: Record<string, FieldAnswer>;
}

/** Suggestion for an empty field returned by the polish endpoint.
 *  Mirrors the schema in POLISH_SCHEMA.suggestions_for_empty.items. */
export interface PolishSuggestionForEmpty {
  field_id: string;
  should_fill: boolean;
  reason: string;
  suggested_value: string;
}

export interface PolishResponse {
  polished: IntakeRecord;
  suggestions_for_empty: PolishSuggestionForEmpty[];
}
