# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DiamondX-A1005: a web app for Indian diamond-export commercial invoices plus a tax/compliance desk (GSTR-1 filing check, export register, FEMA realization, forex, bank matching, refunds, rates) and an AI assistant. React 19 + Vite + Tailwind 4 frontend (TypeScript, ESM); Python 3.11+ FastAPI + asyncpg + PostgreSQL API in `backend/` (package `diamondx`, managed with uv).

## Commands

```bash
docker compose up postgres -d   # local Postgres (DATABASE_URL in .env.example points at it)
npm run dev                     # API (uvicorn) on :8000 + Vite on :3000, which proxies /api to :8000
npm run lint                    # tsc --noEmit — frontend type-check (the only "lint")
npm test                        # vitest run src — frontend tests
npm run test:api                # pytest — API tests
cd backend && uv run pytest tests/test_tax.py           # single file
cd backend && uv run pytest -k "name"                   # tests by name
npm run build                   # frontend → dist/
npm run migrate                 # apply pending migrations (python -m diamondx.core.migrate)
npm run seed:demo               # demo account and data; `-- --reset` reloads the demo company
```

CI (`.github/workflows/ci.yml`): job `web` runs lint, frontend tests, build; job `api` runs pytest against a Postgres 16 service and checks `requirements.txt` matches `backend/uv.lock`.

API tests (`backend/tests/`) start a throwaway Postgres from the `embedded-postgres` binaries in `node_modules` (or `PG_BIN`) unless `TEST_DATABASE_URL` is set — **that database's tables are wiped** before each test. They drive `create_app(pool, AppOptions(...))` with httpx's ASGI transport; `client_factory` gives one cookie jar per simulated user. `tests/test_assistant_eval.py` hits the real model and only runs with `RUN_AI_EVALS=1`.

## Architecture

### Layout
- API code in `backend/diamondx/` is grouped by area: `core/` (db, sessions, request pipeline, http guards, form_input, numbers, security, rate_limit, monitoring, seed, demo_data), `modules/<area>/` (auth, company, invoices, collections, stock, banking, tax, accountant, activity, billing), plus `assistant/` and `ai/`.
- Frontend: `src/features/<area>/` holds pages and desks (mirroring the API areas); `src/components/` holds shared UI (`ui.tsx`, `shared.tsx`).
- The README's "Project structure" and "Adding a feature" sections describe this layout; keep them current when moving or adding modules.

### One FastAPI app, two entry points
- `diamondx/main.py` — local/Docker: loads `.env`, creates the pool, runs migrations, seeds the demo user, `create_app`, and in production (`APP_ENV=production`) serves `dist/` with a single-page-app fallback. Port from `PORT`, default 3000.
- `api/index.py` → `diamondx/serverless.py` — Vercel: lazily builds the same app once per instance (and again if a request arrives on a new event loop). `vercel.json` rewrites every `/api/*` to this function (`/api/index?__path=...`), which restores the path. It also defines a daily cron hitting `/api/cron/rates`. Packages come from root `requirements.txt` (regenerate with `uv export` when `pyproject.toml` changes).
- `diamondx/app.py` `create_app` is the single place middleware and routers are registered: security headers → body limits → `ResponseFinisher` (pure ASGI middleware) → `/api/health` → feature routers → `/api/{path}` 404 → error handlers.
- Each feature module exposes `build_router()` using `api_router()` from `core/context.py`. That router dependency is the request pipeline: read JSON body → load session → load user (and active company) → chartered-accountant guard → subscription guard → rate limit → describe the audit entry. `ResponseFinisher` then sets session cookies, rate-limit headers (refunding sign-in attempts that succeed), and writes the audit row before the response is sent, only for status < 400.
- Errors: raise `ApiError(status, message, **extra)` → `{"error": message, ...extra}`; `FormError` is a 400. Unhandled exceptions become 500 "Something went wrong." and go to Sentry.
- External side effects are injectable through `AppOptions` (`send_password_reset_email`, `create_mail_transport`, `draft_reminder_text`, `draft_notice_reply`, `assistant_model`, and httpx transports `rates_transport`, `razorpay_transport`, `paypal_transport`) — tests pass fakes here rather than patching modules.

### Multi-tenancy and roles
- Everything is scoped by `user.organization_id` from `require_user` and friends (`core/http.py`). Every query must filter by the current user's organization.
- Roles: `admin`, `member`, `tax`, `ca` (chartered accountant). Guards are FastAPI dependencies: `require_user`, `require_admin`, `require_roles(...)` in `core/http.py`, and `tax_reader`, `tax_writer`, `tax_manager`, `chartered_accountant` in `modules/tax/shared.py`.
- A CA can belong to several companies and switch between them (`/api/workspace/switch` stores `organizationId` in the session; `home_organization_id` vs `organization_id`). `chartered_accountant_allowed` in `core/context.py` blocks all CA writes except an explicit allowlist (logout, change password, workspace switch, assistant, practice, requests, notices except delete, invoice review, month close/open). New CA-writable endpoints must be added there.
- Closed months (`modules/tax/closed_months.py`, `month_is_closed` in `tax/shared.py`) lock changes to data dated in that month; writes touching invoice/payment/bank/purchase/foreign-payment data must check this.

### Sessions
- Cookie `connect.sid`, rows in the `session` table, in the express-session/connect-pg-simple format (`core/sessions.py`: HMAC-SHA256 signing with `SESSION_SECRET`, 7-day expiry pushed forward on each request). Sign-in regenerates the session id; password change/reset deletes the user's other sessions.

### Subscriptions
- `modules/billing/plans.py` holds plan prices (INR, excl. 18% GST), limits, and `feature_for_path` (path → plan feature). `check_subscription` (`modules/billing/subscription.py`) runs in the pipeline after the CA guard: a lapsed company (trial over, or paid period + 3 grace days over) gets 402 on every non-GET except `/api/auth|billing|health|workspace|platform`, and gated feature paths return 402 `plan_feature`. `practice` is checked against the user's home (firm) company.
- A company with no `organization_subscriptions` row gets a 14-day trial on first use (`load_subscription`); tests rely on this, so new companies have every feature.
- Limits (`limit_message`) are checked when adding a team member, issuing an invoice (counts `invoices.issued_at` this month), and granting an outside accountant (counts the firm's client companies).
- Payment methods: Razorpay (UPI, card, net banking; auto-renewing subscription) in `razorpay.py` and `routes.py`; bank transfer and PayPal (one period at a time, `activate_one_period`) in `payment_methods.py`; which are on comes from env in `providers.py`. Bank transfers are approved by emails in `PLATFORM_ADMIN_EMAILS` under `/api/platform/*`. Never accept or store card numbers; cards are entered on Razorpay/PayPal pages only.
- The Razorpay webhook is signed over the raw body: `/api/billing/webhook` is in `RAW_BODY_PATHS` in `core/context.py`, so the pipeline does not parse it, and the route reads `await request.body()`.

### Data
- Migrations: `db/migrations/NNN_name.sql`, applied in order inside a transaction, recorded with checksums in `schema_migrations`, guarded by an advisory lock (`core/db.py`). **Never edit an applied migration** — add the next number. Migrations must stay pooler-safe (the app runs against Neon/pgbouncer-style poolers; the pool also disables the prepared-statement cache for this).
- asyncpg specifics: JSON/JSONB come back as Python values and UUIDs as strings (codecs in `core/db.py`); `numeric` comes back as `Decimal` (use `float()`); **date parameters must be `datetime.date`**, not strings; `execute()` returns a status like `"UPDATE 0"`.
- Invoice line items live in the `invoices.data` JSON; denormalized columns (`status`, `total_usd`, `buyer_name`, …) exist for list/search/dashboard. Keep both in sync when saving (`invoice_facts` in `modules/invoices/schema.py`).
- Invoice bodies are validated with Pydantic (`modules/invoices/schema.py`, `validate_invoice`) plus business rules: line total = carats × rate, USD only. Issued invoices are immutable; numbers are per Indian financial year (`EXP/2026-27/0001`).
- Read request bodies with `body(request)` or `form_reader(...)` in `core/form_input.py`; it raises `FormError` (400). The same file has `document_key` (normalises invoice/BoE numbers for matching), `parse_loose_date`, and financial-year helpers.
- Responses keep the shapes the frontend expects: camelCase keys, timestamps via `iso()` (JavaScript `toISOString` format), and money via `core/numbers.py` (`money`, `round_to`, `to_fixed`, `usd`, `js_json`) — these round halves up like `Math.round`/`toFixed`; Python's `round()`/`format()` do not.
- `create_pool` strips `sslmode` from non-local URLs and sets SSL itself (`DATABASE_SSL_VERIFY=false` only for self-signed certificates).

### AI
- Provider chosen by `AI_PROVIDER` (`gemini` default, or `huggingface` with `HF_TOKEN`/`HF_MODEL`) in `ai/client.py`. Gemini is called over its REST API with httpx (`gemini_generate`), Hugging Face through its OpenAI-compatible chat endpoint (`ai/huggingface.py`). All model calls go through `call_model` in `ai/call.py` (enable check, timeout, one retry on 429/5xx, daily per-org token budget, usage logging in `ai_calls`). Use it for any new AI call.
- Assistant (`assistant/`): `agent.py` runs a tool-calling loop (max steps, max messages per conversation; history stored in Gemini's Content shape), `tools.py` holds **read-only** tools over company data, `routes.py` exposes chat + confirm/reject, `review.py` is the month review, `grounding.py` is the amount check. Invariants:
  - Every money amount in a reply is checked against tool results (`is_grounded`); ungrounded replies are flagged.
  - The model may only *propose* actions; nothing mutates until the user confirms, and confirm re-validates against current data.
  - Month-review proposals are produced by code, not the model; the model only summarises, with a code-written fallback.
- Image manifest parsing (`modules/invoices/manifest.py`) and statement reading from images/PDF require Gemini; Hugging Face only handles pasted text.
- Notice replies (`modules/tax/notices.py`) follow the same rule as the assistant: a draft whose amounts are not in the facts (`is_grounded`) is replaced by a template written from the records. Payment reminders reject any model wording containing a digit; all figures come from the database.

### Frontend
- `src/App.tsx` holds the shell/navigation and the invoice workspace state; pages and tax desks are in `src/features/<area>/`.
- Invoice editor: `src/features/invoices/editor/` — `InvoiceEditor` (sections), `LineItemsEditor`, `InvoiceToolbar`, `fields.tsx` (fields read their own issues from `EditorContext`; `NumberField` keeps typed text so decimals work), and `invoiceChecks.ts` (pure, unit-tested export rules; errors block Issue in `App.changeStatus`). New invoice fields need a field in the editor, a field in `modules/invoices/schema.py`, and, if required for export, a rule in `checkInvoice`.
- Tax desk: `TaxPage.tsx` defines `GROUPS` (Overview, GST, Bank & forex, Income tax & audit, Notices & sign-off); each desk is its own component. Add a desk there, with `feature` if it is plan-gated.
- All HTTP goes through `src/api/client.ts` (`fetch` with `credentials: 'include'`, cookie session). In dev, Vite proxies `/api` to the API when `API_PROXY_TARGET` is set (`npm run dev:web` sets it).
- PDF (jspdf + html2canvas), Tally XML and SAP payloads are generated **in the browser** (`src/utils/`). The sample invoice presets live in `src/data/sampleInvoices.json` (typed wrapper `sampleInvoices.ts`); the API reads the JSON to seed demo invoices and in tests.
- `@/` aliases the repo root.

### Security
- The Content Security Policy is defined both in `core/security.py` and in `vercel.json` headers; a test enforces they match — change both together.
- Body limits: 1 MB default, larger only for named upload/import routes (`LARGE_BODY_ROUTES` and `body_limit_for` in `core/security.py`). Vercel caps requests at 4.5 MB.
- Rate limits are stored in Postgres (`rate_limits`) so they hold across serverless instances (`core/rate_limit.py`, rules in `RULES`).

## Environment

Required: `DATABASE_URL`, `SESSION_SECRET` (dev falls back to a fixed secret). `APP_ENV=production` (falls back to `NODE_ENV`) turns on CSP/HSTS, hides `/api/docs`, serves `dist/`, and disables the public demo password. See `.env.example` for the rest (AI keys, SMTP, Sentry, `MIGRATE_ON_START`, `SEED_DEMO_USER`, `VITE_*` build-time flags). Without SMTP, password-reset links are logged. Dev demo login: `owner@example.com` / `password123`.

Do not touch the `DISABLE_HMR` handling in `vite.config.ts` (AI Studio relies on it).
