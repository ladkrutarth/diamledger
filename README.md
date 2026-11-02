# DiamondX-A1005 Precision Engine

Export invoicing and tax compliance for Indian diamond exporters, in one web app shared by the company, its accountant, its chartered accountant (CA), and its tax auditor.

- **The company** makes A4 export invoices, tracks payments and stock, and chases buyers.
- **The accountant** matches the bank, GSTR-2B, and Tally against the books, and records TDS on payments abroad.
- **The CA** reviews invoices, closes months, raises document requests, answers notices, and runs a practice across clients.
- **The tax auditor** gets automatic audit checks and a Form 3CD pack built from the books.

The default sample exporter is **xyz LLC**.

---

## Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Project structure](#project-structure)
4. [Roles and permissions](#roles-and-permissions)
5. [Data model](#data-model)
6. [AI](#ai)
7. [Run locally](#run-locally)
8. [Configuration](#configuration)
9. [Database migrations](#database-migrations)
10. [Deploy](#deploy)
11. [Security](#security)
12. [Monitoring and backups](#monitoring-and-backups)
13. [Tests and CI](#tests-and-ci)
14. [Plans and pricing](#plans-and-pricing)
15. [Adding a feature](#adding-a-feature)
16. [Scripts](#scripts)

---

## Features

### Invoicing

| Feature | What it does |
| --- | --- |
| Invoice workspace | Live A4 preview, PDF export, duplicate an invoice into a new draft |
| Numbering | Automatic per Indian financial year, such as `EXP/2026-27/0001`, with your own prefix |
| Status | Draft → Issued → Paid, or Cancelled. Issued invoices are locked |
| Accounts export | Tally Prime XML and SAP payload, built in the browser |
| Email | Send the invoice PDF by SMTP; every send is logged |
| AI manifest parsing | Read a parcel manifest (image or text) into invoice lines |
| Buyers | Address book, buyer portal links, payment record grade (A–D), and credit limits. Issuing an invoice warns when the buyer is overdue, slow, or over the limit |
| Collections | Overdue list and payment reminder emails drafted by AI, with a written fallback |
| Dashboard | This month's exports, carats, destinations, unpaid balances, and a cash-flow forecast |

### Diamonds and stock

| Feature | What it does |
| --- | --- |
| Parcels | Rough and polished parcels with cost. A polished parcel records the rough parcel it was cut from |
| Stock register | Opening, received, sent for cutting, sold, and closing carats per year, with yield, process loss, and closing value at cost (Form 3CD clause 35) |
| Certificate check | Grading certificates on invoices: certified stones, certificates used twice, one certificate for several stones |
| Kimberley Process register | KP certificate, HS codes, and rough carats per export |

### Tax desk

| Desk | What it does |
| --- | --- |
| Calendar | GSTR-1, GSTR-3B, LUT, realization, and refund due dates |
| Filing check | GSTR-1 table 6A and e-invoice readiness for each issued invoice |
| Export register | Month register with shipping bills and the CA's review; GST pack download |
| Purchases & ITC | Purchase register (imports by Bill of Entry, local purchases by GST invoice). Import GSTR-2B and see credit matched, at risk, and not claimed |
| Bank match | Import a statement (CSV, or PDF/image read by AI) and match credits to invoices |
| Tally match | Import a Tally Day Book (XML or CSV) and compare sales, receipts, and purchases with the app |
| Realization | FEMA realization deadline per export, and e-BRC import |
| Exchange gain / loss | Invoice rate vs bank rate per receipt, exported to Tally |
| Exchange rates | Daily reference rates, plus your own rates |
| GST refund | Refund statement for zero-rated exports under LUT |
| Payments abroad / TDS | Brokerage, freight, and fees paid outside India: TDS, treaty rate, and the Form 15CA part (A, C, or D) with 15CB when needed |
| Audit checks | Gaps in invoice numbers, edits after a closed month was reopened, unusual rates per carat, unmatched payments, round amounts, Sunday invoices, missing shipping bills, foreign payments without TDS or 15CA |
| Tax audit (3CD) | Turnover, clauses 23, 34, 35, and 44, exchange differences, and receivables past the realization period, with one zip download |
| Notices | GST, Income Tax, Customs, DGFT, and RBI notices with reply deadlines, linked invoices, and a reply drafted from your own records |
| Closed months | The CA signs off a month; nothing dated in it can change until it is reopened. Financial year pack download |

### Working with the accountant

| Feature | What it does |
| --- | --- |
| Outside accountants | A company invites a CA or tax firm; the firm switches between its client companies |
| Requests | The CA asks for a document or answer; the company replies with a message or file. Open, answered, or closed, with a due date |
| Practice | For a firm with clients: health score per client, time logged, fees, and fee bills |
| Activity | Every change, with who made it and when; CSV download |
| Assistant | Answers questions from the company's own data and proposes actions; see [AI](#ai) |

## Architecture

The browser runs a React app. Every signed-in screen calls one Express API, which keeps all data for a company in PostgreSQL. PDF, Tally XML, and SAP files are built in the browser. AI calls, email, and file imports run on the server.

```mermaid
flowchart TB
  user["Company, accountant, CA, auditor"] --> spa

  subgraph Browser
    spa["React app (src/)"]
    files["Built in the browser:<br/>A4 preview, PDF, Tally XML, SAP payload"]
    spa --> files
  end

  spa -- "/api, session cookie" --> entry

  subgraph Server["Express API (server/)"]
    entry{"Entry point"}
    entry --> local["server/main.ts<br/>local and Docker"]
    entry --> vercel["api/index.ts → vercelHandler.ts<br/>Vercel function"]
    local --> app
    vercel --> app
    app["app.ts: middleware and routes"]
    app --> core["core/: db, http guards, security,<br/>rate limits, monitoring"]
    app --> modules["modules/: auth, invoices, company,<br/>collections, stock, banking, tax,<br/>accountant, activity"]
    app --> assistant["assistant/: agent, read-only tools, month review"]
    app --> billing["modules/billing: plans, subscription guard"]
    modules --> ai["ai/: callModel with budget,<br/>timeout, and usage log"]
    assistant --> ai
  end

  core --> db[("PostgreSQL")]
  modules --> db
  ai --> llm["Gemini or Hugging Face"]
  modules --> smtp["SMTP mail server"]
  modules --> rates["Reference rate feed"]
  billing --> razorpay["Razorpay: checkout, subscriptions, webhooks"]
  spa -- "Checkout popup" --> razorpay
  cron["Vercel Cron, daily"] -.-> modules
  app -.-> sentry["Sentry, optional"]
  spa -.-> sentry
```

### How a request is handled

Every `/api` request passes the same steps, in this order. A route only runs once the user is known, allowed, and within limits.

```mermaid
flowchart LR
  req["Request"] --> headers["Security headers<br/>(CSP, HSTS)"]
  headers --> body["Body size limit<br/>(1 MB default)"]
  body --> health{"/api/health?"}
  health -- yes --> ok["200 / 503"]
  health -- no --> session["Session cookie<br/>(stored in PostgreSQL)"]
  session --> user["Load user and<br/>active company"]
  user --> ca["CA guard:<br/>read-only except allowlist"]
  ca --> plan["Plan guard:<br/>read-only when lapsed,<br/>features by plan"]
  plan --> limit["Rate limits"]
  limit --> audit["Activity log"]
  audit --> route["Route: role check,<br/>closed-month check, query"]
  route --> errors["Error handler<br/>(400 / 404 / 409 / 500)"]
```

- **Company scope.** Every query filters by the signed-in user's active company.
- **Closed months.** Changes to invoices, payments, purchases, and payments abroad dated in a closed month are refused with `409`.
- **Two entry points, one app.** On Vercel, `vercel.json` sends every `/api` request to `api/index.ts`, which builds the same Express app once per instance. Locally, `server/main.ts` also serves the Vite dev server; in Docker it serves the built files from `dist/`.

---

## Project structure

Code is grouped by feature. Each server module owns its routes, SQL, and rules; each frontend feature owns its pages. Shared pieces live in `core/` (server) and `components/` (browser).

```text
.
├── api/
│   └── index.ts                 Vercel serverless entry
├── db/
│   ├── init/                    Creates the test database in Docker
│   └── migrations/              Numbered SQL, applied once, in order
│
├── server/                      Express API
│   ├── main.ts                  Local and Docker entry: env, migrate, serve
│   ├── app.ts                   Middleware order and route registration
│   ├── vercelHandler.ts         Adapter used by api/index.ts
│   │
│   ├── core/                    Shared by every module
│   │   ├── db.ts                Pool, migrations
│   │   ├── http.ts              Roles, guards, current user
│   │   ├── formInput.ts         Request body readers, document-number matching
│   │   ├── security.ts          Headers, CSP, body limits
│   │   ├── rateLimit.ts         Limits stored in PostgreSQL
│   │   ├── monitoring.ts        Sentry
│   │   ├── health.ts            /api/health
│   │   ├── mailer.ts            Password reset mail
│   │   ├── migrate.ts           npm run migrate
│   │   ├── seed.ts, demoData.ts Demo account and sample data
│   │   └── types.ts, zip.ts
│   │
│   ├── modules/                 One folder per business area
│   │   ├── auth/                Sign in, password reset, team members
│   │   ├── company/             Company profile, buyers, buyer credit risk
│   │   ├── invoices/            Invoices, payments, dashboard, buyer portal
│   │   ├── collections/         Overdue reminders, invoice email
│   │   ├── stock/               Parcels, stock register
│   │   ├── banking/             Bank statements, AI statement reader, Tally sync
│   │   ├── tax/                 Filing, register, purchases & ITC, realization,
│   │   │                        forex, rates, refunds, TDS, audit checks,
│   │   │                        3CD pack, notices, closed months
│   │   ├── accountant/          Multi-company workspace, requests, practice
│   │   ├── billing/             Plans and prices, Razorpay, subscription guard
│   │   └── activity/            Activity log
│   │
│   ├── assistant/               Tool-calling agent, read-only tools, month review
│   ├── ai/                      Provider choice and callModel (budget, timeout, log)
│   └── tests/                   API tests against a temporary PostgreSQL
│
├── src/                         React app
│   ├── main.tsx, App.tsx        Start-up, sign-in, navigation shell
│   ├── api/client.ts            Every call to /api, and response types
│   ├── components/              Shared UI: buttons, cards, tables, form fields
│   ├── features/                One folder per area, matching the server
│   │   ├── auth/  company/  buyers/  invoices/  collections/
│   │   ├── dashboard/  diamonds/  tax/  accountant/  assistant/  billing/
│   ├── utils/                   PDF, Tally XML, SAP, amount in words
│   ├── types/, data/            Invoice types and sample invoices
│   └── monitoring.ts            Browser Sentry
│
├── Dockerfile, docker-compose.yml
├── vercel.json                  Rewrites, headers, cron, function settings
└── vite.config.ts, vitest.config.ts, tsconfig.json
```

### Where each area lives

| Area | Server module | Screens | Main routes |
| --- | --- | --- | --- |
| Accounts and team | `modules/auth` | `features/auth`, `features/company` | `/api/auth/*`, `/api/team/*` |
| Company and buyers | `modules/company` | `features/company`, `features/buyers` | `/api/company`, `/api/buyers/*` |
| Invoices and payments | `modules/invoices` | `features/invoices`, `features/dashboard` | `/api/invoices/*`, `/api/dashboard`, `/api/portal/*` |
| Collections | `modules/collections` | `features/collections` | `/api/reminders/*`, `/api/send-email` |
| Stock | `modules/stock` | `features/diamonds` | `/api/parcels/*`, `/api/stock/*` |
| Banking and Tally | `modules/banking` | `features/tax` | `/api/bank/*`, `/api/tally/*` |
| Tax desk | `modules/tax` | `features/tax` | `/api/tax/*`, `/api/purchases/*`, `/api/foreign-payments/*`, `/api/notices/*`, `/api/rates/*` |
| Accountant | `modules/accountant` | `features/accountant` | `/api/workspace/*`, `/api/requests/*`, `/api/practice/*` |
| Activity | `modules/activity` | `features/company` | `/api/audit` |
| Plan & billing | `modules/billing` | `features/billing` | `/api/billing/*` |
| Assistant | `assistant/` | `features/assistant` | `/api/assistant/*` |


## Data model

Every row belongs to one company (`organizations`). Invoice line items stay inside the invoice `data` JSON; the plain columns (`status`, `total_usd`, `buyer_name`, …) exist so lists, search, and the dashboard do not have to read the JSON.

### Invoicing and company

```mermaid
erDiagram
  organizations ||--o{ users : "members"
  organizations ||--o{ organization_access : "outside accountants"
  users ||--o{ organization_access : "has access"
  organizations ||--o{ buyers : "address book"
  organizations ||--o{ invoices : "owns"
  organizations ||--o{ invoice_counters : "next number"
  invoices ||--o{ payments : "paid against"
  invoices ||--o| invoice_tax : "scheme, shipping bill"
  invoices ||--o{ invoice_documents : "SB, AWB, LUT files"
  invoices ||--o| invoice_reviews : "CA review"
  invoices ||--o| invoice_einvoices : "IRN"
  invoices ||--o| invoice_brcs : "e-BRC"
  invoices ||--o{ payment_reminders : "reminders"
  organizations ||--o{ email_dispatches : "sent mail"
  organizations ||--o{ buyer_portal_links : "portal links"
  organizations ||--o{ parcels : "stock"
  organizations ||--o{ audit_events : "activity"
  users ||--o{ password_reset_tokens : "reset links"
```

### Tax, banking, and the accountant

```mermaid
erDiagram
  organizations ||--o{ purchases : "imports and local buys"
  organizations ||--o{ gstr2b_lines : "GSTR-2B by month"
  organizations ||--o{ bank_lines : "bank credits"
  bank_lines }o--o| payments : "matched to"
  organizations ||--o{ tally_vouchers : "Tally day book"
  organizations ||--o{ foreign_payments : "payments abroad, TDS"
  organizations ||--o{ tax_notices : "notices"
  organizations ||--o{ closed_months : "signed off"
  organizations ||--o| organization_tax_settings : "LUT, realization period"
  organizations ||--o{ organization_rates : "own rates"
  organizations ||--o{ client_requests : "requests"
  client_requests ||--o{ client_request_messages : "replies and files"
  organizations ||--o{ ca_engagements : "firm to client fee"
  organizations ||--o{ ca_time_entries : "time logged"
  organizations ||--o{ ca_fee_bills : "fee bills"
  organizations ||--o| organization_subscriptions : "plan"
  organizations ||--o{ subscription_payments : "plan payments"
  organizations ||--o{ ai_calls : "AI usage"
  organizations ||--o{ assistant_sessions : "chats"
  assistant_sessions ||--o{ assistant_messages : "messages"
  assistant_sessions ||--o{ assistant_actions : "proposals"
```

`reference_rates` holds daily exchange rates for everyone; `razorpay_plans` caches the Razorpay plan IDs and `billing_events` records webhooks already handled. Sessions live in `session`, rate-limit counters in `rate_limits`, and applied migrations in `schema_migrations`.

---

## AI

All AI features use one provider, chosen by `AI_PROVIDER`. Every call goes through `callModel` in `server/ai/call.ts`, which checks AI is on, enforces a daily token budget per company, times out slow calls, retries once, and logs each call to `ai_calls`.

| Feature | Model's job | When the model fails or is unsure |
| --- | --- | --- |
| Assistant | Answer from read-only tools; propose an action | Amounts not found in the looked-up data are flagged |
| Month review | Summarise findings that code produced | A summary written from the findings |
| Payment reminder | Write the wording | A written template |
| Notice reply | Draft a reply from the notice and linked invoices | A reply written from the records |
| Manifest and statement reading | Read lines from a file | The user checks the lines before saving |

### Assistant flow

The assistant opens as a popup after sign-in. The model can only read and propose; nothing changes until the user confirms, and confirming checks the books again first.

```mermaid
sequenceDiagram
  actor U as User
  participant UI as Assistant popup
  participant API as /api/assistant
  participant AG as Agent
  participant T as Read-only tools
  participant DB as PostgreSQL

  U->>UI: Asks a question
  UI->>API: Message with session cookie
  API->>AG: Question and company scope
  loop Look up facts
    AG->>T: Call a tool (invoices, payments, tax desk)
    T->>DB: Read company data
    T-->>AG: Results
  end
  AG-->>API: Reply and optional proposal
  API->>API: Check every amount against the results
  API-->>UI: Reply, sources, proposal
  U->>UI: Confirms
  UI->>API: Confirm action
  API->>DB: Re-check, then apply
  API-->>UI: Result
```

### Notice reply flow

```mermaid
flowchart LR
  notice["Notice + linked invoices"] --> facts["Facts from the books:<br/>shipping bill, BRC, amounts"]
  facts --> model["Model drafts paragraphs"]
  model --> check{"Every amount<br/>in the facts?"}
  check -- yes --> draft["AI draft saved"]
  check -- no --> template["Reply written from the records"]
  model -. "error or timeout" .-> template
  draft --> review["User edits and sends it themselves"]
  template --> review
```

### Choosing the model

| `AI_PROVIDER` | Needs | Model |
| --- | --- | --- |
| `gemini` (default) | `GEMINI_API_KEY` | Gemini |
| `huggingface` | `HF_TOKEN` | `HF_MODEL`, default `meta-llama/Llama-3.3-70B-Instruct` |

For Hugging Face, create a token at https://huggingface.co/settings/tokens with "Make calls to Inference Providers", and pick a chat model that supports tool calling. Reading manifest images needs Gemini; with Hugging Face, paste the text. Restart the server after changing `.env`.

---

## Run locally

Requirements: Node.js 22 and Docker (for PostgreSQL).

```bash
docker compose up postgres -d
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the demo account `owner@example.com` / `password123`, or create an account.

- Set `GEMINI_API_KEY` (or the Hugging Face variables) before using AI features.
- Without SMTP settings, password reset links are printed to the server log.

---

## Configuration

| Variable | Required | Purpose |
| --- | :---: | --- |
| `DATABASE_URL` | ✓ | PostgreSQL connection string |
| `SESSION_SECRET` | ✓ | Long random string that signs session cookies |
| `APP_URL` | | Public site address, used in password reset and portal links |
| `AI_PROVIDER` | | `gemini` (default) or `huggingface` |
| `GEMINI_API_KEY` | | Gemini key |
| `HF_TOKEN`, `HF_MODEL` | | Hugging Face token and model |
| `AI_ENABLED` | | `false` turns every AI feature off |
| `AI_DAILY_TOKEN_BUDGET` | | Tokens per company per day, default 2,000,000 |
| `AI_TIMEOUT_MS` | | Per-call timeout, default 20000 |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | | Mail server for password reset |
| `CRON_SECRET` | | Bearer token Vercel Cron sends to `/api/cron/rates` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | | Razorpay API keys. Without them plans are shown but checkout is off |
| `RAZORPAY_WEBHOOK_SECRET` | | Secret of the Razorpay webhook pointed at `/api/billing/webhook` |
| `MIGRATE_ON_START` | | `false` skips migrations at start-up |
| `SEED_DEMO_USER` | | `true` creates the demo account in production |
| `VITE_SHOW_DEMO_LOGIN` | | `true` shows demo credentials on the sign-in page. Build time |
| `SENTRY_DSN`, `VITE_SENTRY_DSN` | | Server and browser error reporting. The browser one is read at build time |
| `TEST_DATABASE_URL` | | Use an existing database for tests. **Its tables are wiped** |

In production the demo account is not created, and if one exists with the public password, that password is replaced.

---

## Database migrations

Schema changes live in `db/migrations` as numbered SQL files. Each file runs once inside a transaction and is recorded with a checksum in `schema_migrations`. An advisory lock stops two servers from migrating at once, and the files stay safe to run through a connection pooler (Neon, pgbouncer).

| File | Adds |
| --- | --- |
| `001`–`003` | Users, invoices, sessions, companies, buyers, payments, email log, rate limits |
| `004` | Payment reminders and credit days |
| `005` | AI calls and assistant sessions |
| `006` | Invoice tax details, documents, CA reviews, closed months |
| `007` | E-invoices, bank lines, e-BRCs, tax settings, outside accountant access |
| `008` | Assistant tax actions |
| `009` | Exchange rates, activity log, parcels, buyer portal |
| `010` | Purchases and GSTR-2B, stock kinds, requests, notices, payments abroad, Tally vouchers, practice, buyer credit limits |
| `011` | Subscriptions, Razorpay plans, plan payments, webhook events, and when each invoice was issued |

Pending migrations run at start-up. To run them as a release step instead, set `MIGRATE_ON_START=false` and run `npm run migrate`.

To change the schema, add the next number. **Never edit a file that has already run**; the app warns if one changes.

---

## Deploy

### Vercel

The site is a static frontend plus one serverless function.

1. In the project settings, set `DATABASE_URL` (a hosted Postgres; the Docker one is not reachable), `SESSION_SECRET`, and `CRON_SECRET`.
2. Add any other variables from [Configuration](#configuration).
3. Redeploy. Pending migrations run the first time a new deployment connects.

`vercel.json` rewrites `/api/*` to `api/index.ts`, ships `db/**` with the function for migrations, sets the security headers for static files, and calls `/api/cron/rates` daily.

### Docker

```bash
docker compose up --build
```

PostgreSQL and the app start together on port 3000. The image compiles the server to `dist-server/`, installs only production packages, runs as the unprivileged `node` user, and uses `/api/health` as its health check. Set `SESSION_SECRET` for anything beyond a local demo, and `SEED_DEMO_USER=true` for the demo account.

---

## Security

- **Sessions** are stored in PostgreSQL; cookies are signed with `SESSION_SECRET`.
- **Headers:** Content Security Policy, HSTS, and anti-framing. The same CSP is in `server/core/security.ts` and `vercel.json`; a test keeps them in sync.
- **Validation:** invoices are checked with zod plus business rules (line total = carats × rate, USD only). Other forms use `core/formInput.ts`.
- **Uploads:** request files accept PDF, images, CSV, and Excel up to 2 MB; downloads are sent as attachments with `nosniff`.
- **Email:** at most 10 recipients and 2 PDF attachments of 10 MB each. SMTP must present a valid certificate unless the sender allows otherwise.

### Body size limits

| Route | Limit |
| --- | --- |
| Default | 1 MB |
| Manifest parsing, statement reading | 15 MB |
| Invoice email | 25 MB |
| Tally import | 4 MB |
| Invoice documents, bank and e-BRC import, statement lines, GSTR-2B, request replies | 3 MB |

Vercel caps every request at 4.5 MB.

### Rate limits

Counters are stored in PostgreSQL, so limits hold across serverless instances. Too many requests get HTTP 429.

| Request | Limit |
| --- | --- |
| Sign in | 10 failed attempts per 15 minutes per IP and email |
| Create account | 5 per hour per IP |
| Forgot password / reset password | 5 / 10 per hour per IP |
| Send invoice email / test SMTP | 30 / 20 per hour per user |
| AI manifest parsing / statement reading | 60 / 30 per hour per user |
| Reminder draft / reminder send | 60 / 30 per hour per user |
| Notice reply draft | 30 per hour per user |
| Tally import | 30 per hour per user |
| Assistant question / month review | 30 / 10 per hour per user |
| Buyer portal | 120 per 15 minutes per IP |
| Plan checkout | 20 per hour per user |

---

## Monitoring and backups

- `GET /api/health` returns `200 {"status":"ok"}` when the database answers and `503` when it does not. Point an uptime monitor at it.
- Set `SENTRY_DSN` and `VITE_SENTRY_DSN` to send errors to [Sentry](https://sentry.io). Reports include method, path, user ID, and company ID, never bodies, cookies, or headers.
- Use a host with point-in-time recovery. On [Neon](https://neon.tech), check the restore window under **Settings → Storage**; to recover, branch from a point before the problem, check it, then point `DATABASE_URL` at it.
- For your own copy, run `pg_dump "$DATABASE_URL" -Fc -f diamondx-$(date +%F).dump` on a schedule and store it outside the host.

---

## Tests and CI

```bash
npm test                                   # everything
npx vitest run server/tests/tax.test.ts    # one file
npx vitest run -t "stock register"         # tests whose name matches
```

Server tests start a temporary PostgreSQL (`embedded-postgres`) and drive the real app through `supertest`. They cover:

- accounts, roles, the CA guard, and password reset
- invoices, numbering, payments, search, and closed months
- the tax desk: filing, register, realization, forex, bank matching
- purchases and GSTR-2B, stock register, payments abroad, audit checks, 3CD pack, Tally reconciliation, requests, notices, practice, and buyer risk
- the assistant and month review, with a fake model
- rate limits, email safety, security headers, and migrations
- in the browser code: Tally XML, SAP payloads, amounts in words, and the login form

GitHub Actions (`.github/workflows/ci.yml`) runs the type check, the tests against a PostgreSQL 16 service, and the build on every push to `main` and every pull request

### Turning on payments

1. Create a [Razorpay](https://razorpay.com) account, and under **Account & Settings → API keys** create test keys (`rzp_test_...`).
2. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
3. Under **Webhooks**, add `https://<your site>/api/billing/webhook` with the `subscription.*` events (activated, charged, pending, halted, cancelled, completed, resumed), and set its secret as `RAZORPAY_WEBHOOK_SECRET`.
4. Pay for a plan with a [test card or UPI ID](https://razorpay.com/docs/payments/payments/test-card-details/), and check it on the Plan & billing page.
5. When Razorpay activates your live account, swap in the live keys and a live webhook.

Razorpay plans are created on first checkout for each plan, cycle, and price, so there is nothing to set up in the Razorpay dashboard. A price change creates a new Razorpay plan; existing subscribers stay on their old price until they change plan.

```mermaid
sequenceDiagram
  actor A as Company admin
  participant UI as Plan & billing page
  participant API as /api/billing
  participant RP as Razorpay
  participant DB as PostgreSQL

  A->>UI: Chooses a plan and monthly or yearly
  UI->>API: checkout
  API->>RP: Create plan (first time) and subscription
  API->>DB: Remember the pending subscription
  API-->>UI: Subscription ID and key
  UI->>RP: Open Checkout (UPI, card, net banking)
  RP-->>UI: Payment ID and signature
  UI->>API: verify
  API->>API: Check the signature with the key secret
  API->>DB: Switch the plan, cancel the one it replaces
  RP-)API: Webhook: activated, charged, halted, cancelled
  API->>API: Check the webhook signature, skip repeats
  API->>DB: Update status, period, and payment history
```

Not covered yet: GST tax invoices for the subscription itself (Razorpay sends a payment receipt; issue a GST invoice from your own books, or turn on Razorpay Invoices), coupons, and refunds, which are made from the Razorpay dashboard.

---

## Adding a feature

1. **Schema:** add `db/migrations/NNN_name.sql` with the next number.
2. **Server:** add a file under the right `server/modules/<area>/` that exports `registerXRoutes(app, pool)`, and register it in `server/app.ts`.
   - Filter every query by `currentUser(res).organizationId`.
   - Guard routes with `requireUser`, `requireAdmin`, `requireRoles`, or the tax guards in `modules/tax/taxShared.ts`.
   - Read bodies with `formReader` from `core/formInput.ts`.
   - Refuse changes dated in a closed month (`closedMonthMessage`).
   - If a CA must write to it, add the path to the allowlist in `charteredAccountantGuard`.
   - Add a rule to `modules/activity/audit.ts` so the change shows in Activity.
   - Route any AI call through `callModel`, and add its feature name to `ModelCallContext`.
   - If it belongs to a paid tier, add its path to `featureForPath` in `modules/billing/plans.ts`.
3. **Browser:** add response types to `src/api/client.ts`, a screen under `src/features/<area>/`, and a navigation entry in `App.tsx` or a desk in `TaxPage.tsx`.
4. **Tests:** add API tests under `server/tests/`, and run `npm run lint && npm test`.

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the app with live reload (`server/main.ts`) |
| `npm run build` | Build the frontend to `dist/` |
| `npm run build:server` | Compile the server to `dist-server/` |
| `npm start` | Run the compiled server. Build both first and set `NODE_ENV=production` |
| `npm run migrate` | Apply pending migrations |
| `npm run seed:demo` | Create the demo account. Add `-- --reset` to wipe and reload its sample data |
| `npm run lint` | Type-check the project |
| `npm test` | Run all tests |
| `npm run clean` | Remove `dist/` and `dist-server/` |
