# DiamondX-A1005 Precision Engine

Web app for diamond export commercial invoices. Enter shipment data, preview an A4 invoice, export a PDF, and send the same invoice to Tally, SAP, or email.

The default sample exporter is **xyz LLC**.

## Features

- Company accounts: invoices, buyers, and settings are shared by everyone in a company
- Team members with two roles. Admins manage the company profile, team, deletions, and cancellations. Members create and issue invoices.
- Company profile that fills exporter, bank, and signatory details on every new invoice
- Buyer address book, with a picker in the workspace
- Automatic invoice numbers per Indian financial year, such as `EXP/2026-27/0001`, with your own prefix
- Invoice status: Draft, Issued, Paid, Cancelled. Issued invoices are locked; use Duplicate to start a new draft from one.
- Payment tracking per invoice. An invoice becomes Paid once payments cover its total.
- Dashboard with this month's exports, carats, exports by destination, and unpaid balances
- Invoice search by number, buyer, status, and date, with export to CSV for Excel
- Change password, and forgot-password reset by email
- Invoice workspace with live A4 preview
- PDF export
- AI parcel manifest parsing (Gemini)
- Tally Prime XML and SAP payload generation
- SMTP email dispatch

## Requirements

- Node.js 22
- Docker, for PostgreSQL
- A [Gemini API key](https://aistudio.google.com/apikey) if you use the AI parcel parser

## Run locally

Start the database, then the app:

```bash
docker compose up postgres -d
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Create an account on the sign-in page, then save invoices from the workspace.

Set `GEMINI_API_KEY` in `.env` before using the AI parcel parser. Set `DATABASE_URL` and `SESSION_SECRET` before the API starts. SMTP settings for invoice email are entered in the app when you send it.

Password reset emails use `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. Without them, the reset link is printed to the server log instead. Set `APP_URL` to your public site address so reset links point to it.

Existing databases are upgraded when the app starts: each existing account becomes the admin of its own company, and its invoices move to that company as drafts.

## Vercel

The site is a static frontend plus a serverless API. In the Vercel project settings, set:

- `DATABASE_URL` to a hosted Postgres connection string. The database inside Docker is not reachable from Vercel.
- `SESSION_SECRET` to a long random string.
- Optional: `APP_URL` and the `SMTP_*` variables above for password reset emails.

All `/api` requests go to one serverless function, `api/index.ts`, through the rewrite in `vercel.json`.

Redeploy after saving those variables. The sign-in page opens even if the database is missing. The demo account `owner@example.com` / `password123` is created the first time the API connects.

## Docker

```bash
docker compose up --build
```

PostgreSQL and the app start together. The app listens on port 3000. Pass `GEMINI_API_KEY` in the environment if you want AI parsing inside the container. Override `SESSION_SECRET` for anything other than a local demo.

## Tests

```bash
npm test
```

The suite starts a temporary PostgreSQL database, then checks accounts, saved invoices, and the login form. Docker is only needed when you run the app.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the app |
| `npm start` | Start the app |
| `npm run build` | Build the frontend |
| `npm run lint` | Type-check the project |
| `npm test` | Run auth, invoice, and login tests |
