# DiamondX API (Python / FastAPI)

The API for DiamondX-A1005: a FastAPI app (package `diamondx`) on PostgreSQL through asyncpg. The React frontend in `src/` calls it at `/api`. It replaced the former Express server and keeps the same routes, responses, database, migrations, and session cookie.

## Run

```bash
npm run dev       # from the repo root: this API on :8000 and Vite on :3000
npm run test:api  # pytest
```

Directly, from `backend/`:

```bash
uv run python -m diamondx.main          # the API on PORT (default 3000)
uv run python -m diamondx.core.migrate  # apply pending migrations
uv run python -m diamondx.core.seed     # demo account and data (--reset to reload)
uv run pytest                           # tests
```

In development the interactive API docs are at `/api/docs`.

## Layout

| Path | What it holds |
| --- | --- |
| `diamondx/app.py` | `create_app` and `AppOptions`: middleware, router list, error handlers |
| `diamondx/main.py`, `diamondx/serverless.py` | Local/Docker entry, and the Vercel entry used by `api/index.py` |
| `diamondx/core/` | DB pool and migrations, sessions, the request pipeline (`context.py`), guards, security, rate limits, form readers, JS-compatible number formatting, seeding |
| `diamondx/modules/<area>/` | One `build_router()` per feature: auth, company, invoices, collections, stock, banking, tax, accountant, activity, billing |
| `diamondx/assistant/` | Tool-calling agent, read-only tools, month review, grounding check |
| `diamondx/ai/` | `call_model` (budget, timeout, retry, usage log), Gemini REST and Hugging Face clients |
| `tests/` | pytest suites; `conftest.py` starts a temporary PostgreSQL unless `TEST_DATABASE_URL` is set |

See the repo `README.md` ("Adding a feature") and `CLAUDE.md` for conventions.

## Compatibility with the former Node server

- Same tables and migrations (`db/migrations`, `schema_migrations`, the same advisory lock).
- Same session cookie (`connect.sid`) and `session` rows as express-session/connect-pg-simple, so existing sign-ins keep working after a deploy.
- Same JSON shapes: camelCase keys, `toISOString`-style timestamps, and money rounded as `Math.round`/`toFixed` round (`core/numbers.py`).
- Same rate-limit keys, activity-log rules, CA allowlist, plan gates, and error messages.

## Dependencies

`pyproject.toml` and `uv.lock` are the source. Vercel and Docker install from the root `requirements.txt`; after changing dependencies, regenerate it:

```bash
uv export --no-dev --no-hashes --no-emit-project --format requirements-txt > ../requirements.txt
```

(CI fails if the two disagree; keep the two comment lines at the top of `requirements.txt`.)
