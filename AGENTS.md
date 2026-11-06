# Agents working on legal-intake

This val deliberately constrains the LLM. The point is to **prevent free-form
chat** and force a structured elicitation loop, MCP-style, using the
json-render technique.

## Hard rules for any change

1. The model output must always conform to the JSON Schema in
   `shared/catalog.ts`. If you add a new elicitation kind, you must:
   - add it to the discriminated union in `shared/types.ts`,
   - extend the JSON Schema (every field listed under `properties` must also
     appear in `required` for `gpt-5-nano` strict mode),
   - render it in `frontend/registry.tsx`.
2. Never call OpenAI without `response_format: { type: "json_schema", ... }`.
3. Never let the model emit prose outside the spec. If it tries, that's a bug
   in the system prompt or schema — fix the schema, don't add a string-cleaner.
4. Frontend imports use React **18.2.0** pinned (`?deps=react@18.2.0,react-dom@18.2.0`)
   and the `/** @jsxImportSource https://esm.sh/react@18.2.0 */` pragma.
5. SQLite: change table name (e.g. `intakes_v3`) when changing schema; do not
   `ALTER TABLE`.
6. Storage: use `https://esm.town/v/std/sqlite/main.ts` (val-scoped) — not the
   legacy account-scoped version.
7. No secrets in code. Free `std/openai` is used; no API key needed.

## When the model misbehaves

If the model loops, asks the same question twice, or fails to mark complete,
the fix is almost always in `shared/catalog.ts` (system prompt + schema), not
in the renderer.
