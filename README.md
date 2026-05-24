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

Optional Gemini/OpenAI AI features:

- `GEMINI_API_KEY`
- `GEMINI_MODEL=gemini-2.5-flash`
- `OPENAI_API_KEY`
- `OPENAI_MODEL=gpt-4o-mini`
- `AI_PARSER_DISABLED=false`

## Quick Entry

`POST /api/quick-entry` parses natural-language ledger text into the same fields used by `POST /api/batches/:batchId/transactions`.

The endpoint is authenticated and requires `OperationManager` access. It does not write to the database; the frontend fills the ledger form so the user can review before saving.

## FlockOps Chat

`POST /api/flockops-chat` sends authenticated assistant messages to Gemini and returns a role-aware farm operations reply.

The endpoint uses `GEMINI_API_KEY` and `GEMINI_MODEL`. It filters financial context unless the signed-in user has `OperationManager` access.

## Regression Check

Run the cash-advance/reimbursement API regression against a running backend:

```bash
npm run test:regression
```

The check logs in, picks `REGRESSION_BATCH_ID` or the active batch, parses quick-entry cash advance and reimbursement text for an existing employee, saves both transactions, verifies employee pay summary deltas, voids the created transactions, and verifies cleanup. The login must be a primary owner because cleanup uses the void endpoint.

Optional environment overrides:

- `REGRESSION_API_BASE=http://localhost:5000`
- `REGRESSION_LOGIN=admin.roland`
- `REGRESSION_PASSWORD=121232`
- `REGRESSION_BATCH_ID=20260418`
- `REGRESSION_EMPLOYEE_NAME=Jane`
- `REGRESSION_PAID_BY=Rolly`
- `REGRESSION_ADVANCE_AMOUNT=600`
- `REGRESSION_REIMBURSEMENT_AMOUNT=200`
