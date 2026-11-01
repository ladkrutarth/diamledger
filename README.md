# DiamondX-A1005 Precision Engine

Web app for diamond export commercial invoices. Enter shipment data, preview an A4 invoice, export a PDF, and send the same invoice to Tally, SAP, or email.

The default sample exporter is **xyz LLC**.

## Features

- Sign in and save invoices for each account
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

Set `GEMINI_API_KEY` in `.env` before using the AI parcel parser. Set `DATABASE_URL` and `SESSION_SECRET` before the API starts. SMTP settings are entered in the app when you send email.

## Vercel

The site is a static frontend plus a serverless API. In the Vercel project settings, set:

- `DATABASE_URL` to a hosted Postgres connection string. The database inside Docker is not reachable from Vercel.
- `SESSION_SECRET` to a long random string.

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
