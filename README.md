# Experiments

Experiment tools extracted from `anna-ws-analytics`: Timeline Analyzer (LLM-based case analysis) and Rubric Tester (dispute pipeline evaluation).

## Prerequisites

- Node.js 18+
- Docker (for PostgreSQL)
- Google Cloud SDK with Application Default Credentials (for BigQuery)

## Quick Start

```bash
# Start PostgreSQL, backend, and frontend
npm install
npm run dev:all

# Or without Docker (if PostgreSQL is already running)
npm run dev
```

## Ports

| Service    | Port |
|------------|------|
| Frontend   | 5176 |
| Backend    | 3003 |
| PostgreSQL | 5433 |

## Environment Variables

Copy `packages/backend/.env.example` to `packages/backend/.env` and fill in.
The backend loads `packages/backend/.env` first and falls back to a repo root `.env` if present:

| Variable                         | Description                                      |
|----------------------------------|--------------------------------------------------|
| `GCP_PROJECT_ID`                 | Google Cloud project ID                          |
| `BIGQUERY_DATASET`               | BigQuery dataset name                            |
| `BIGQUERY_LOCATION`              | BigQuery location (e.g. `EU`)                    |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional; uses gcloud ADC if not set             |
| `CASE_API_BASE_URL`              | Case API base URL for fetching timelines         |
| `API_TOKEN`                      | API token for Case API                           |
| `LLM_API_BASE_URL`              | LLM proxy base URL                               |
| `LLM_PROVIDER`                  | `ANTHROPIC` or `OPENAI`                           |
| `LLM_MODEL`                     | Model identifier                                  |
| `DATABASE_URL`                   | PostgreSQL connection string (default: `postgresql://analytics:analytics@localhost:5433/analytics`) |
| `PORT`                           | Backend port (default: `3003`)                   |
| `CORS_ORIGIN`                    | Frontend origin (default: `http://localhost:5176`) |

## Architecture

npm workspaces monorepo with two packages:

- `packages/backend` - Fastify server with BigQuery and PostgreSQL for job persistence
- `packages/frontend` - React 18 + Vite dashboard with Timeline Analyzer and Rubric Tester pages

## Commands

```bash
npm run dev:all                     # Start PostgreSQL + frontend + backend
npm run dev                         # Start frontend + backend (without Docker)
npm run dev -w packages/frontend    # Frontend only (Vite on :5176)
npm run dev -w packages/backend     # Backend only (Fastify on :3003)
npm run build                       # Build both packages
npm run lint                        # Lint
npm run format                      # Format
```
