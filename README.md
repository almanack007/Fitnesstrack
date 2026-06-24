# FitTrack Pro

FitTrack Pro is a muscle-building nutrition tracker with Postgres persistence.

## Run With Postgres

1. Create a Postgres database named `fittrack`.
2. Install dependencies:

```bash
npm install
```

3. Start the app:

```bash
DATABASE_URL=postgres://postgres:password@localhost:5432/fittrack npm start
```

On Windows PowerShell:

```powershell
$env:DATABASE_URL="postgres://postgres:password@localhost:5432/fittrack"
npm start
```

4. Open:

```text
http://localhost:3000
```

The server creates the required tables automatically. The SQL is also available in `schema.sql`.

If your password or database name is different, set `DATABASE_URL` before running `npm start`.

## Stored Data

Daily tracking is stored in `fittrack_daily_logs` by `user_id` and `log_date`.

The API supports:

- `GET /api/daily/:userId/:date` retrieves one day plus the last 7 days of protein data.
- `PUT /api/daily/:userId/:date` saves profile, food log, water intake, and totals.
- `GET /api/history/:userId?limit=30` retrieves saved daily history.
- `DELETE /api/users/:userId` clears the profile and all daily logs for that user.

The browser still keeps a localStorage cache so the app remains usable if the database API is offline.
