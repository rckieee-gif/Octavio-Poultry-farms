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
