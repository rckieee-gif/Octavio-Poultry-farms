# Octavio Poultry Farm Backend

Node/Express backend for the Octavio Poultry Farm manager app.

## Setup

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm start
```

Required environment variables:

- `DATABASE_URL`
- `JWT_SECRET`

Optional Render keep-alive:

- `KEEP_ALIVE_URL=https://octavio-farm-api.onrender.com/health`
- `KEEP_ALIVE_INTERVAL_MINUTES=14`

Optional quick-entry AI parsing:

- `GEMINI_API_KEY`
- `GEMINI_MODEL=gemini-2.5-flash`
- `OPENAI_API_KEY`
- `OPENAI_MODEL=gpt-4o-mini`
- `AI_PARSER_DISABLED=false`

## Quick Entry

`POST /api/quick-entry` parses natural-language ledger text into the same fields used by `POST /api/batches/:batchId/transactions`.

The endpoint is authenticated and requires `OperationManager` access. It does not write to the database; the frontend fills the ledger form so the user can review before saving.
