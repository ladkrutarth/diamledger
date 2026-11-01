# DiamondX-A1005 Precision Engine

Web app for diamond export commercial invoices. Enter shipment data, preview an A4 invoice, export a PDF, and send the same invoice to Tally, SAP, or email.

The default sample exporter is **xyz LLC**.

## Features

- Invoice workspace with live A4 preview
- PDF export
- AI parcel manifest parsing (Gemini)
- Tally Prime XML and SAP payload generation
- SMTP email dispatch

## Requirements

- Node.js 22
- A [Gemini API key](https://aistudio.google.com/apikey) if you use the AI parcel parser

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Set `GEMINI_API_KEY` in `.env` before using the AI parcel parser. SMTP settings are entered in the app when you send email.

## Docker

```bash
docker compose up --build
```

The app listens on port 3000. Pass `GEMINI_API_KEY` in the environment if you want AI parsing inside the container.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the app |
| `npm start` | Start the app |
| `npm run build` | Build the frontend |
| `npm run lint` | Type-check the project |
