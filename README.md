# In-house legal intake

An internal legal request demo for employees to give a legal team the facts needed to triage a matter. Based on [`arthrod/legal-intake`](https://www.val.town/x/arthrod/legal-intake), the in-house predecessor of client-intake. The design adapts the accompanying paper, ink and yellow design system; see [DESIGN.md](DESIGN.md).

## Try the flow

1. Complete the single-page form: requester, matter, description, urgency and the required acknowledgements. Optional fields cover counterparties, jurisdiction, deadline, budget, external counsel and notes.
2. Select **Continue to review**. The server sends the answers to Val Town's OpenAI proxy (`gpt-5-nano`) using a strict structured-output schema. It polishes the description and suggests whether empty fields merit completion. Generated text can be wrong; check it carefully.
3. Review and edit every field. Suggestions for empty fields are optional and can be applied individually.
4. Select **Submit to legal**, then confirm. If storage is configured, the request is saved and an intake ID is shown. In demo mode the request is validated but not saved or sent to any legal department.

This demo is not legal advice or a production intake system. Use fictional information on public deployments.

## Data and configuration

| Configuration | Behavior |
| --- | --- |
| `ADMIN_TOKEN` unset or blank | Public demo mode. `/api/submit` validates the request but does not write to SQLite; the confirmation screen states this. `/api/intakes` returns 503. |
| `ADMIN_TOKEN` set in the val's environment | Validated submissions are stored in val-scoped SQLite (`intakes_v2`). `GET /api/intakes` requires `Authorization: Bearer <ADMIN_TOKEN>`; missing or incorrect tokens return 401. The UI does not provide an admin list; use an authenticated API client. |

The model receives entered request data through Val Town's OpenAI proxy. Form data remains in the browser while the page is open; the app also keeps a small session object in `localStorage`. Do not enter confidential or identifying information into a public demo. Configuring a token enables storage; review access, retention, hosting and legal requirements before using real matters. Error responses avoid exposing raw model output or request text. In-memory rate limiting applies per isolate, not as a distributed security boundary.

## Run, test and deploy

Requirements: Deno 2, a Val Town account and [`vt`](https://docs.val.town/cli/). Hosted model and SQLite services are not reproduced by running a plain local Deno server.

```sh
git clone https://github.com/jandira-tech/inhouse-intake.git
cd inhouse-intake
deno task test
deno check --allow-import backend/index.http.tsx frontend/index.tsx
```

To deploy your own copy, create or remix a Val with `vt`, then copy this repository's files into that val's local directory without replacing its `.vt` folder. Run `vt status`, `vt push --dry-run`, then `vt push`. The `.vt` directory is local deployment linkage and is not committed. Set `ADMIN_TOKEN` in your own val settings only if you intend to store and retrieve records; never commit it.

Example authenticated listing, with the token already in your shell environment:

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://YOUR-HTTP-VAL-URL/api/intakes"
```

## Architecture and API

- `frontend/index.tsx`: form, editable review, confirmation and submitted stages; `frontend/design.css` supplies the design tokens.
- `shared/catalog.ts` and `shared/types.ts`: canonical fields, schemas, prompts and record types.
- `backend/llm.ts`: structured elicitation, polish and help calls; `backend/db.ts`: SQLite persistence; `backend/auth.ts`: protected reads.
- `backend/submit.ts`: submission validation and the demo/storage decision; `backend/ratelimit.ts`: in-memory limits for model routes.

| Route | Purpose |
| --- | --- |
| `GET /api/mode` | Whether persistence is disabled for the demo. |
| `POST /api/polish` | Polish provided answers and suggest possible missing fields. |
| `POST /api/submit` | Validate and, when configured, store the reviewed intake. |
| `GET /api/intakes` | List saved records; requires the admin bearer token. |
| `POST /api/elicit`, `POST /api/help` | Legacy structured elicitation and clarification endpoints retained from the source. |

## Verification and troubleshooting

`deno task test` covers demo and configured submission branches with an isolated storage stub, bearer access control, and model rate/body limits; it does not call the model or SQLite. `deno check` verifies the frontend and backend entry points. To verify a deployment, complete the form with fictional details, review the model output and confirm submission. A 429 indicates model limits; retry later. A 503 on saved reads means no admin token is configured; a 401 means the bearer token is missing or wrong. Model and network availability can affect the polish step.
