# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DiamondX-A1005: a web app for Indian diamond-export commercial invoices plus a tax/compliance desk (GSTR-1 filing check, export register, FEMA realization, forex, bank matching, refunds, rates) and an AI assistant. React 19 + Vite + Tailwind 4 frontend, Express 4 + PostgreSQL backend, all TypeScript (ESM).

## Commands

```bash
docker compose up postgres -d   # local Postgres (DATABASE_URL in .env.example points at it)
npm run dev                     # tsx server/main.ts — Express API + Vite middleware on :3000
npm run lint                    # tsc --noEmit (this is the only "lint"; type-check)
npm test                        # vitest run — all tests
npx vitest run server/tests/tax.test.ts            # single file
npx vitest run server/tests/api.test.ts -t "name"  # single test by name
npm run build                   # frontend → dist/
npm run build:server            # esbuild server/main.ts + server/core/migrate.ts → dist-server/
npm run migrate                 # apply pending migrations manually
npm run seed:demo               # seed demo data
```

CI (`.github/workflows/ci.yml`) runs `npm run lint`, `npm test`, `npm run build` against a Postgres 16 service.

Server tests (`server/tests/*.test.ts`) start a throwaway Postgres via `embedded-postgres` on port 54329 unless `TEST_DATABASE_URL` is set — **that database's tables are wiped**. Tests run serially (`fileParallelism: false`) with long hook timeouts. They drive the app with `supertest` against `createApp(pool, options)`.

## Architecture

### Layout
- Server code is grouped by area: `server/core/` (db, http guards, formInput, security, rateLimit, monitoring, seed), `server/modules/<area>/` (auth, company, invoices, collections, stock, banking, tax, accountant, activity), plus `server/assistant/` and `server/ai/`. Tests live in `server/tests/`.
- Frontend: `src/features/<area>/` holds pages and desks (mirroring the server areas); `src/components/` holds shared UI (`ui.tsx`, `shared.tsx`).
- The README's "Project structure" and "Adding a feature" sections describe this layout; keep them current when moving or adding modules.

### One Express app, two entry points
- `server/main.ts` — local/Docker: loads `.env`, creates pool, runs migrations, seeds demo user, `createApp`, then mounts Vite middleware (dev) or serves `dist/` (prod).
- `api/index.ts` → `server/vercelHandler.ts` — Vercel: lazily builds the same app once per instance. `vercel.json` rewrites every `/api/*` to this single function (`/api/index?__path=...`). It also defines a daily cron hitting `/api/cron/rates`.
- `server/app.ts` `createApp` is the single place middleware and routes are registered. Order matters: security headers → body parser → `/api/health` → session (`connect-pg-simple`, `session` table) → `loadUser` → `charteredAccountantGuard` → rate limits → `auditTrail` → feature routes → `/api` 404 → error handler.
- Each feature module exports `registerXRoutes(app, pool, ...deps)`. Add new modules there.
- External side effects are injectable through `AppOptions` (`sendPasswordResetEmail`, `createMailTransport`, `draftReminderText`, `assistantModel`, `fetchRates`, `draftNoticeReply`) — tests pass fakes here rather than mocking modules.

### Multi-tenancy and roles
- Everything is scoped by `organizationId` from `currentUser(res)` (`server/core/http.ts`). Every query must filter by the current user's organization.
- Roles: `admin`, `member`, `tax`, `ca` (chartered accountant). Guards in `server/core/http.ts` (`requireUser`, `requireAdmin`, `requireRoles`) and `server/modules/tax/taxShared.ts` (`taxReader`, `taxWriter`, `taxManager`, `charteredAccountant`).
- A CA can belong to several companies and switch between them (`/api/workspace/switch`; `homeOrganizationId` vs `organizationId`). `charteredAccountantGuard` in `app.ts` blocks all CA writes except an explicit allowlist (logout, change password, workspace switch, assistant, invoice review, month close/open). New CA-writable endpoints must be added to that allowlist (it already covers requests, notices, and practice).
- Closed months (`server/modules/tax/closedMonths.ts`, `monthIsClosed` in `taxShared.ts`) lock changes to data dated in that month; writes touching invoice/payment/bank/purchase/foreign-payment data should check this.

### Data
- Migrations: `db/migrations/NNN_name.sql`, applied in order inside a transaction, recorded with checksums in `schema_migrations`, guarded by an advisory lock. **Never edit an applied migration** — add the next number. Migrations must stay pooler-safe (the app runs against Neon/pgbouncer-style poolers).
- Invoice line items live in the `invoices.data` JSON; denormalized columns (`status`, `total_usd`, `buyer_name`, …) exist for list/search/dashboard. Keep both in sync when saving (see `invoiceValidation.ts` `invoiceFacts`).
- Invoice bodies are validated with zod (`invoiceSchema.ts`) plus business rules (`invoiceValidation.ts`): line total = carats × rate, USD only. Issued invoices are immutable; numbers are per Indian financial year (`EXP/2026-27/0001`).
- Newer modules read request bodies with `formReader` in `server/core/formInput.ts`; it throws `FormError` (status 400), which the app error handler returns to the user. The same file has `documentKey` (normalises invoice/BoE numbers for matching) and financial-year helpers.
- `createPool` (`server/core/db.ts`) strips `sslmode` from non-local URLs and sets SSL itself.

### AI
- Provider chosen by `AI_PROVIDER` (`gemini` default, or `huggingface` with `HF_TOKEN`/`HF_MODEL`) in `server/ai/client.ts`. All model calls go through `callModel` in `server/ai/call.ts` (enable check, timeout, daily per-org token budget, usage logging). Use it for any new AI call.
- Assistant (`server/assistant/`): `agent.ts` runs a tool-calling loop (max steps), `tools.ts` holds **read-only** tools over company data, `routes.ts` exposes chat + confirm, `review.ts` is the month review. Invariants:
  - Every money amount in a reply is checked against tool results (`isGrounded`); ungrounded replies are flagged.
  - The model may only *propose* actions; nothing mutates until the user confirms, and confirm re-validates against current data.
  - Month-review proposals are produced by code, not the model; the model only summarises, with a code-written fallback.
- Image manifest parsing requires Gemini; Hugging Face only handles pasted text.
- Notice replies (`modules/tax/notices.ts`) follow the same rule as the assistant: a draft whose amounts are not in the facts (`isGrounded`) is replaced by a template written from the records.

### Frontend
- `src/App.tsx` holds the shell/navigation; pages and tax desks are in `src/features/<area>/` (tax desks are tabs in `src/features/tax/TaxPage.tsx`).
- All HTTP goes through `src/api/client.ts` (`fetch` with `credentials: 'include'`, cookie session).
- PDF (jspdf + html2canvas), Tally XML and SAP payloads are generated **in the browser** (`src/utils/`). Shared types/presets in `src/types/invoice.ts` and `src/data/sampleInvoices.ts` are also imported by server tests.
- `@/` aliases the repo root.

### Security
- The Content Security Policy is defined both in `server/core/security.ts` and in `vercel.json` headers; a test enforces they match — change both together.
- Body limits: 1 MB default, larger only for named upload/import routes (see `LARGE_BODY_ROUTES` and `jsonBodyParser`). Vercel caps requests at 4.5 MB.
- Rate limits are stored in Postgres (`rate_limits`) so they hold across serverless instances (`server/core/rateLimit.ts`).

## Environment

Required: `DATABASE_URL`, `SESSION_SECRET` (dev falls back to a fixed secret). See `.env.example` for the rest (AI keys, SMTP, Sentry, `MIGRATE_ON_START`, `SEED_DEMO_USER`, `VITE_*` build-time flags). Without SMTP, password-reset links are logged to the console. Dev demo login: `owner@example.com` / `password123`.

Do not touch the `DISABLE_HMR` handling in `vite.config.ts` (AI Studio relies on it).
