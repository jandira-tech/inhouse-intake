/** @jsxImportSource https://esm.sh/react@18.2.0 */
import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.2.0?deps=react@18.2.0";
import { createRoot } from "https://esm.sh/react-dom@18.2.0/client?deps=react@18.2.0,react-dom@18.2.0";
import type {
  AskElicitation,
  FieldAnswer,
  FieldSpec,
  IntakeRecord,
  IntakeState,
  PolishRequest,
  PolishResponse,
  PolishSuggestionForEmpty,
  SubmitResponse,
} from "../shared/types.ts";
import { INITIAL_ELICITATION } from "../shared/catalog.ts";

// ============================================================================
// Single-page intake.
//
// Step 1 (front page): user fills out everything from INITIAL_ELICITATION in
//   one big form.
// Step 2 (confirmation): we POST the raw answers to /api/polish, the AI fixes
//   grammar/description AND assesses each empty field. The user sees every
//   polished value in an editable field, with hints next to fields they left
//   blank. A single global "Are you sure?" gates final submission.
// ============================================================================

// The full single-page form (typed narrowly so TS knows it has `fields`).
const INTAKE_FORM = INITIAL_ELICITATION as AskElicitation;

// ---------- session (kept minimal — no multi-turn state anymore) ----------

const STATE_KEY = "legal-intake.state.v2";

function emptyState(): IntakeState {
  return { session_id: crypto.randomUUID(), history: [], prefill: {} };
}

function loadOrCreateState(): IntakeState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return JSON.parse(raw) as IntakeState;
  } catch (_e) { /* fall through */ }
  const s = emptyState();
  localStorage.setItem(STATE_KEY, JSON.stringify(s));
  return s;
}

function persistState(s: IntakeState) {
  localStorage.setItem(STATE_KEY, JSON.stringify(s));
}

function resetState(): IntakeState {
  const s = emptyState();
  localStorage.setItem(STATE_KEY, JSON.stringify(s));
  return s;
}

// ---------- API ----------

async function callPolish(answers: Record<string, FieldAnswer>): Promise<PolishResponse> {
  const body: PolishRequest = { answers };
  const r = await fetch("/api/polish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`/api/polish ${r.status}: ${await r.text()}`);
  return (await r.json()) as PolishResponse;
}

async function callSubmit(intake: IntakeRecord): Promise<SubmitResponse> {
  const r = await fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intake }),
  });
  if (!r.ok) throw new Error(`/api/submit ${r.status}: ${await r.text()}`);
  const json = (await r.json()) as SubmitResponse;
  return json;
}

// ---------- Field value helpers ----------

interface FieldValueState {
  picks: string[];      // selected suggestions (single- or multi-select)
  custom: string;       // free-text
  bool: boolean | null; // for input_type=boolean
}

function emptyFieldValue(): FieldValueState {
  return { picks: [], custom: "", bool: null };
}

function splitMultiCustom(s: string): string[] {
  return s
    .split(/[\n,;]+/)
    .map(x => x.trim())
    .filter((x, i, arr) => x.length > 0 && arr.indexOf(x) === i);
}

const ARRAY_FIELD_IDS = new Set(["counterparties"]);

function fieldToAnswer(field: FieldSpec, v: FieldValueState): FieldAnswer {
  if (field.input_type === "boolean") return v.bool;
  const isMulti = field.multi || ARRAY_FIELD_IDS.has(field.id);
  if (isMulti) {
    const customs = splitMultiCustom(v.custom);
    const merged = [...v.picks];
    for (const c of customs) if (!merged.includes(c)) merged.push(c);
    return merged;
  }
  if (v.custom.trim()) return v.custom.trim();
  return v.picks[0] ?? null;
}

function isEmpty(v: FieldAnswer | undefined | null): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// ---------- Step 1: front-page form ----------

function FrontPage({
  onPolished,
}: {
  onPolished: (
    answers: Record<string, FieldAnswer>,
    response: PolishResponse,
  ) => void;
}) {
  const [values, setValues] = useState<Record<string, FieldValueState>>(() => {
    const init: Record<string, FieldValueState> = {};
    for (const f of INTAKE_FORM.fields) init[f.id] = emptyFieldValue();
    return init;
  });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [polishing, setPolishing] = useState(false);

  function update(id: string, patch: Partial<FieldValueState>) {
    setValues(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function submit() {
    const answers: Record<string, FieldAnswer> = {};
    for (const f of INTAKE_FORM.fields) {
      answers[f.id] = fieldToAnswer(f, values[f.id]);
    }

    const missing = INTAKE_FORM.fields.find(
      f => f.required && isEmpty(answers[f.id]),
    );
    if (missing) {
      setValidationError(`"${missing.label}" is required.`);
      return;
    }

    // Both required acknowledgements must be true.
    const ackBad = INTAKE_FORM.fields.find(
      f =>
        f.required &&
        f.input_type === "boolean" &&
        answers[f.id] !== true,
    );
    if (ackBad) {
      setValidationError(
        `"${ackBad.label}" must be acknowledged before continuing.`,
      );
      return;
    }

    setValidationError(null);
    setPolishing(true);
    try {
      const response = await callPolish(answers);
      onPolished(answers, response);
    } catch (e: any) {
      setValidationError(String(e?.message ?? e));
    } finally {
      setPolishing(false);
    }
  }

  return (
    <Card>
      <form
        onSubmit={(e: any) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="text-2xl font-semibold mb-2">{INTAKE_FORM.title}</h2>
        {INTAKE_FORM.intro && (
          <p className="text-slate-600 mb-6">{INTAKE_FORM.intro}</p>
        )}
        <div className="space-y-6">
          {INTAKE_FORM.fields.map(f => (
            <FieldEditor
              key={f.id}
              field={f}
              value={values[f.id]}
              onChange={patch => update(f.id, patch)}
            />
          ))}
        </div>
        {validationError && <ErrorBox message={validationError} />}
        <div className="mt-6 flex justify-end">
          <PrimaryButton type="submit" disabled={polishing}>
            {polishing ? "Polishing with AI…" : "Continue to review"}
          </PrimaryButton>
        </div>
      </form>
    </Card>
  );
}

function FieldEditor({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: FieldValueState;
  onChange: (patch: Partial<FieldValueState>) => void;
}) {
  const isMulti = field.multi || ARRAY_FIELD_IDS.has(field.id);
  const renderField: FieldSpec = isMulti === field.multi
    ? field
    : { ...field, multi: true };

  if (field.input_type === "boolean") {
    return (
      <div>
        <label className="block font-medium mb-1">
          {field.label}
          {field.required && <span className="text-red-600"> *</span>}
        </label>
        {field.help && <p className="text-sm text-slate-500 mb-2">{field.help}</p>}
        <div className="flex gap-2">
          <Toggle active={value.bool === true} onClick={() => onChange({ bool: true })}>
            Yes
          </Toggle>
          <Toggle active={value.bool === false} onClick={() => onChange({ bool: false })}>
            No
          </Toggle>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="block font-medium mb-1">
        {field.label}
        {field.required && <span className="text-red-600"> *</span>}
      </label>
      {field.help && <p className="text-sm text-slate-500 mb-2">{field.help}</p>}

      {field.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {field.suggestions.map(s => {
            const picked = value.picks.includes(s);
            return (
              <Chip
                key={s}
                active={picked}
                onClick={() => {
                  if (isMulti) {
                    onChange({
                      picks: picked
                        ? value.picks.filter(p => p !== s)
                        : [...value.picks, s],
                    });
                  } else {
                    onChange({ picks: picked ? [] : [s], custom: "" });
                  }
                }}
              >
                {s}
              </Chip>
            );
          })}
        </div>
      )}

      {field.allow_custom && (
        <CustomInput field={renderField} value={value} onChange={onChange} />
      )}
    </div>
  );
}

function CustomInput({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: FieldValueState;
  onChange: (patch: Partial<FieldValueState>) => void;
}) {
  if (field.multi) {
    const live = splitMultiCustom(value.custom);
    return (
      <div>
        <textarea
          className="w-full border-2 border-dashed border-slate-300 focus:border-blue-500 rounded px-3 py-2 min-h-[88px] bg-slate-50 font-mono text-sm"
          placeholder={"Add entries — one per line\n(or separate with , or ;)"}
          value={value.custom}
          onChange={(e: any) => onChange({ custom: e.target.value })}
        />
        {live.length > 0 && (
          <div className="mt-2 text-xs text-slate-500">
            Will add {live.length} {live.length === 1 ? "entry" : "entries"}:{" "}
            <span className="text-slate-700">{live.join(" · ")}</span>
          </div>
        )}
      </div>
    );
  }
  const placeholder = field.suggestions.length > 0
    ? "Or write your own"
    : "Type your answer";
  if (field.input_type === "textarea") {
    return (
      <textarea
        className="w-full border border-slate-300 rounded px-3 py-2 min-h-[100px]"
        placeholder={placeholder}
        value={value.custom}
        onChange={(e: any) => onChange({ custom: e.target.value })}
      />
    );
  }
  const type = field.input_type === "email"
    ? "email"
    : field.input_type === "number"
    ? "number"
    : field.input_type === "date"
    ? "date"
    : "text";
  return (
    <input
      type={type}
      className="w-full border border-slate-300 rounded px-3 py-2"
      placeholder={placeholder}
      value={value.custom}
      onChange={(e: any) => onChange({ custom: e.target.value })}
    />
  );
}

// ---------- Step 2: confirmation (AI-polished, freely editable) ----------

/** Display config for each canonical IntakeRecord field on the confirmation
 *  screen. Mirrors the front-page form so the user sees the same labels and
 *  input affordances. */
interface ConfirmFieldConfig {
  id: keyof IntakeRecord;
  label: string;
  help?: string;
  kind: "text" | "textarea" | "email" | "date" | "select" | "multi" | "boolean";
  options?: string[]; // for select
  required?: boolean;
}

const CONFIRM_FIELDS: ConfirmFieldConfig[] = [
  { id: "requester_name", label: "Your name", kind: "text", required: true },
  { id: "requester_email", label: "Work email", kind: "email", required: true },
  { id: "requester_department", label: "Department", kind: "text" },
  { id: "business_unit", label: "Business unit", kind: "text" },
  {
    id: "matter_type",
    label: "Matter type",
    kind: "select",
    options: [
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
    required: true,
  },
  { id: "matter_type_other", label: "Matter type (other)", kind: "text" },
  { id: "short_title", label: "Short title", kind: "text", required: true },
  {
    id: "description",
    label: "Description",
    kind: "textarea",
    help: "The AI polished this — edit freely if anything is off.",
    required: true,
  },
  {
    id: "counterparties",
    label: "Counterparties",
    kind: "multi",
    help: "One per line.",
  },
  { id: "jurisdiction", label: "Jurisdiction / governing law", kind: "text" },
  {
    id: "urgency",
    label: "Urgency",
    kind: "select",
    options: ["low", "medium", "high", "blocking_deal"],
    required: true,
  },
  { id: "needed_by", label: "Needed by", kind: "date" },
  { id: "budget_estimate", label: "Approximate budget", kind: "text" },
  {
    id: "external_counsel_requested",
    label: "External counsel requested?",
    kind: "boolean",
  },
  { id: "prior_matter_id", label: "Related prior matter ID", kind: "text" },
  { id: "notes", label: "Anything else legal should know", kind: "textarea" },
  {
    id: "conflict_check_acknowledged",
    label: "I acknowledge the conflict-check process",
    kind: "boolean",
    required: true,
  },
  {
    id: "confidentiality_acknowledged",
    label: "I acknowledge confidentiality",
    kind: "boolean",
    required: true,
  },
];

/** Was this canonical field empty/null in the user's raw answers? Used to
 *  surface AI suggestions on the confirmation screen. */
function rawWasEmpty(
  rawAnswers: Record<string, FieldAnswer>,
  id: keyof IntakeRecord,
): boolean {
  return isEmpty(rawAnswers[id as string] ?? null);
}

function ConfirmationPage({
  rawAnswers,
  polishResponse,
  onSubmitted,
  onBack,
}: {
  rawAnswers: Record<string, FieldAnswer>;
  polishResponse: PolishResponse;
  onSubmitted: (result: SubmitResponse) => void;
  onBack: () => void;
}) {
  // Working copy of the IntakeRecord — every field is freely editable.
  const [intake, setIntake] = useState<IntakeRecord>(() => ({
    ...polishResponse.polished,
  }));
  const [askingSure, setAskingSure] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestionsByField = useMemo(() => {
    const m = new Map<string, PolishSuggestionForEmpty>();
    for (const s of polishResponse.suggestions_for_empty) {
      m.set(s.field_id, s);
    }
    return m;
  }, [polishResponse]);

  function setField<K extends keyof IntakeRecord>(id: K, v: IntakeRecord[K]) {
    setIntake(prev => ({ ...prev, [id]: v }));
  }

  function applySuggestion(cfg: ConfirmFieldConfig, suggested: string) {
    if (!suggested) return;
    switch (cfg.kind) {
      case "boolean": {
        setField(cfg.id, (suggested.toLowerCase() === "true") as never);
        break;
      }
      case "multi": {
        const parts = splitMultiCustom(suggested);
        setField(cfg.id, parts as never);
        break;
      }
      default:
        setField(cfg.id, suggested as never);
    }
  }

  async function reallySubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await callSubmit(intake);
      onSubmitted(result);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setAskingSure(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2 className="text-2xl font-semibold mb-2">Review your request</h2>
      <p className="text-slate-600 mb-6">
        The assistant polished grammar and rewrote the description. Edit any
        field below — what you see here is what will be submitted.
      </p>

      <div className="space-y-5">
        {CONFIRM_FIELDS.map(cfg => {
          const suggestion = rawWasEmpty(rawAnswers, cfg.id)
            ? suggestionsByField.get(cfg.id as string) ?? null
            : null;
          return (
            <ConfirmRow
              key={cfg.id as string}
              cfg={cfg}
              value={intake[cfg.id]}
              onChange={v => setField(cfg.id, v as never)}
              suggestion={suggestion}
              onApplySuggestion={() => suggestion && applySuggestion(cfg, suggestion.suggested_value)}
            />
          );
        })}
      </div>

      {error && <ErrorBox message={error} />}

      <div className="mt-8 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-slate-500 hover:text-slate-900 underline"
        >
          ← Back to form
        </button>
        {askingSure
          ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-700">Are you sure?</span>
              <button
                type="button"
                onClick={() => setAskingSure(false)}
                disabled={submitting}
                className="px-3 py-2 text-sm rounded border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                Not yet
              </button>
              <PrimaryButton onClick={reallySubmit} disabled={submitting}>
                {submitting ? "Submitting…" : "Yes, submit to legal"}
              </PrimaryButton>
            </div>
          )
          : (
            <PrimaryButton onClick={() => setAskingSure(true)}>
              Submit to legal
            </PrimaryButton>
          )}
      </div>
    </Card>
  );
}

function ConfirmRow({
  cfg,
  value,
  onChange,
  suggestion,
  onApplySuggestion,
}: {
  cfg: ConfirmFieldConfig;
  value: unknown;
  onChange: (v: unknown) => void;
  suggestion: PolishSuggestionForEmpty | null;
  onApplySuggestion: () => void;
}) {
  return (
    <div className="border border-slate-200 rounded p-4">
      <label className="block font-medium mb-1">
        {cfg.label}
        {cfg.required && <span className="text-red-600"> *</span>}
      </label>
      {cfg.help && <p className="text-xs text-slate-500 mb-2">{cfg.help}</p>}

      <ConfirmInput cfg={cfg} value={value} onChange={onChange} />

      {suggestion && (
        <SuggestionHint
          suggestion={suggestion}
          onApply={onApplySuggestion}
        />
      )}
    </div>
  );
}

function ConfirmInput({
  cfg,
  value,
  onChange,
}: {
  cfg: ConfirmFieldConfig;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const base = "w-full border border-slate-300 rounded px-3 py-2";

  if (cfg.kind === "boolean") {
    const b = value === true ? true : value === false ? false : null;
    return (
      <div className="flex gap-2">
        <Toggle active={b === true} onClick={() => onChange(true)}>Yes</Toggle>
        <Toggle active={b === false} onClick={() => onChange(false)}>No</Toggle>
      </div>
    );
  }

  if (cfg.kind === "select" && cfg.options) {
    return (
      <select
        className={base}
        value={(value as string) ?? ""}
        onChange={(e: any) => onChange(e.target.value || null)}
      >
        <option value="">(none)</option>
        {cfg.options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }

  if (cfg.kind === "multi") {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    return (
      <textarea
        className={base + " min-h-[88px] font-mono text-sm"}
        placeholder="One entry per line"
        value={arr.join("\n")}
        onChange={(e: any) => onChange(splitMultiCustom(e.target.value))}
      />
    );
  }

  if (cfg.kind === "textarea") {
    return (
      <textarea
        className={base + " min-h-[110px]"}
        value={(value as string) ?? ""}
        onChange={(e: any) => onChange(e.target.value || null)}
      />
    );
  }

  const type = cfg.kind === "email"
    ? "email"
    : cfg.kind === "date"
    ? "date"
    : "text";
  return (
    <input
      type={type}
      className={base}
      value={(value as string) ?? ""}
      onChange={(e: any) => onChange(e.target.value || null)}
    />
  );
}

function SuggestionHint({
  suggestion,
  onApply,
}: {
  suggestion: PolishSuggestionForEmpty;
  onApply: () => void;
}) {
  const color = suggestion.should_fill
    ? "bg-amber-50 border-amber-200 text-amber-900"
    : "bg-slate-50 border-slate-200 text-slate-700";
  const icon = suggestion.should_fill ? "💡" : "ℹ︎";
  return (
    <div className={`mt-3 border rounded p-3 text-sm ${color}`}>
      <div className="flex gap-2 items-start">
        <span aria-hidden>{icon}</span>
        <div className="flex-1">
          <div className="font-medium mb-0.5">
            {suggestion.should_fill ? "You left this blank — worth filling in?" : "Skipping this looks fine"}
          </div>
          <div>{suggestion.reason}</div>
          {suggestion.should_fill && suggestion.suggested_value && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-amber-700">Suggested:</span>
              <code className="px-2 py-0.5 bg-white border border-amber-200 rounded text-xs">
                {suggestion.suggested_value}
              </code>
              <button
                type="button"
                onClick={onApply}
                className="text-xs underline text-amber-800 hover:text-amber-900"
              >
                Use this
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Submitted view ----------

function SubmittedView({ result, onStartOver }: { result: SubmitResponse; onStartOver: () => void }) {
  return (
    <Card>
      <h2 className="text-2xl font-semibold mb-2">{result.demo ? "Demo complete" : "Submitted"}</h2>
      <div className="bg-green-50 border border-green-200 rounded p-3 text-green-900 mb-4">
        {result.demo ? "Your request was validated but not stored or sent to a legal department." : `Submitted as intake #${result.intake_id}. Legal can review it.`}
      </div>
      <div className="flex justify-end">
        <PrimaryButton onClick={onStartOver}>Start another</PrimaryButton>
      </div>
    </Card>
  );
}

// ---------- Shared UI bits ----------

function Card({ children }: { children: any }) {
  return (
    <div className="demo-card max-w-2xl mx-auto bg-white rounded-lg shadow-sm border border-slate-200 p-6 my-8">
      {children}
    </div>
  );
}

function Chip({ children, active, onClick }: { children: any; active: boolean; onClick: () => void }) {
  const cls = active
    ? "bg-blue-600 text-white border-blue-600"
    : "bg-white text-slate-700 border-slate-300 hover:border-slate-500";
  return (
    <button type="button" onClick={onClick} className={`px-3 py-1.5 rounded-full border text-sm ${cls}`}>
      {children}
    </button>
  );
}

function Toggle({ children, active, onClick }: { children: any; active: boolean; onClick: () => void }) {
  const cls = active
    ? "bg-slate-900 text-white border-slate-900"
    : "bg-white text-slate-700 border-slate-300 hover:border-slate-500";
  return (
    <button type="button" onClick={onClick} className={`px-3 py-1.5 rounded border text-sm ${cls}`}>
      {children}
    </button>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: any;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white px-5 py-2 rounded font-medium"
    >
      {children}
    </button>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="mt-4 bg-red-50 border border-red-200 rounded p-3 text-red-900 text-sm">
      {message}
    </div>
  );
}

// ---------- App ----------

type Stage =
  | { kind: "form" }
  | { kind: "confirm"; rawAnswers: Record<string, FieldAnswer>; polish: PolishResponse }
  | { kind: "submitted"; result: SubmitResponse };

function App() {
  const [_state, setState] = useState<IntakeState>(loadOrCreateState);
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [demo, setDemo] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/mode", { signal: controller.signal }).then(r => {
      if (!r.ok) throw new Error("mode unavailable");
      return r.json();
    }).then((data: { demo: boolean }) => setDemo(data.demo)).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => { persistState(_state); }, [_state]);

  function startOver() {
    if (stage.kind !== "submitted") {
      const ok = window.confirm(
        "Discard your in-progress intake? Anything you've entered will be lost.",
      );
      if (!ok) return;
    }
    setState(resetState());
    setStage({ kind: "form" });
  }

  return (
    <div className="inhouse-theme min-h-screen">
      <header className="app-header">
        <div className="app-nav">
          <a className="brand" href="https://arthur.law/">ARTHUR<span>.</span>SOUZA<span>.</span>RODRIGUES <span>/</span> IN-HOUSE INTAKE</a>
          <button
            onClick={startOver}
            className="app-reset"
          >
            Start over
          </button>
        </div>
      </header>
      <main>
        <section className="app-hero">
          <p className="eyebrow">/ LEGAL OPERATIONS · REQUEST INTAKE · HUMAN REVIEW</p>
          <h1>Give your legal team <mark>the right context.</mark></h1>
          <p>Describe the matter, review AI-assisted edits, and confirm the request before submitting. Your answers are sent to Val Town's model service for suggestions.</p>
          {demo === true && <p className="demo-notice">Public demo: use fictional information. Your answers are sent to the model service for suggestions. Submissions are validated but not stored or sent to a legal department.</p>}
        </section>
        {stage.kind === "form" && (
          <FrontPage
            onPolished={(rawAnswers, polish) =>
              setStage({ kind: "confirm", rawAnswers, polish })
            }
          />
        )}
        {stage.kind === "confirm" && (
          <ConfirmationPage
            rawAnswers={stage.rawAnswers}
            polishResponse={stage.polish}
            onBack={() => setStage({ kind: "form" })}
            onSubmitted={result => setStage({ kind: "submitted", result })}
          />
        )}
        {stage.kind === "submitted" && (
          <SubmittedView result={stage.result} onStartOver={startOver} />
        )}
      </main>
    </div>
  );
}

// Guard the boot so this module is safe to import in non-browser contexts.
if (typeof document !== "undefined") {
  const root = createRoot(document.getElementById("root")!);
  root.render(<App />);
}

export {};
