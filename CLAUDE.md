# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Summary

Monorepo with three experimental tools for the ANNA Dispute Resolution Agent: a **Timeline Analyzer** (LLM-based case analysis), a **Rubric Tester** (dispute pipeline evaluation), and a **Dataset Builder** (ground-truth eval dataset construction with labeling and stratified analytics). The system automates dispute case triage — determining whether a case can be safely credited or needs human review.

## Commands

```bash
# Development
npm run dev           # Start frontend + backend concurrently
npm run dev:all       # Start Docker (PostgreSQL) + frontend + backend

# Build
npm run build         # Build both packages

# Lint & format
npm run lint          # ESLint across all packages
npm run format        # Prettier across all packages

# Package-specific
npm run dev -w packages/backend    # Backend only (tsx watch on port 3003)
npm run dev -w packages/frontend   # Frontend only (Vite on port 5176)
npm run build -w packages/backend  # Backend build (tsc)
npm run build -w packages/frontend # Frontend build (tsc -b && vite build)
```

No test framework is configured.

## Architecture

**npm workspaces monorepo** with two packages:

### Backend (`packages/backend`) — Fastify 5, TypeScript, ES modules

- `src/server.ts` — Entry point, starts Fastify on PORT (default 3003)
- `src/app.ts` — Fastify app factory, registers CORS and routes
- `src/routes/` — Route handlers:
  - `health.ts` — `GET /health`
  - `timeline-analyzer.ts` — `/api/timeline-analyzer` (prompts, start, status polling, cases)
  - `dispute-pipeline.ts` — `/api/dispute-pipeline` (run, results, review)
  - `dataset.ts` — `/api/datasets` (CRUD, labeling, runs, analytics, compare, compose)
- `src/services/` — Core business logic:
  - `dispute-pipeline.ts` — 5-layer pipeline (signals → hard gates → planner → executor → verifier) + `fetchCaseContext()` for dataset context-only fetching
  - `case-api.ts` — External API client (case details, artifacts, actions, dialogues)
  - `bigquery.ts` — BigQuery client for analytical signal queries
  - `signals-query.ts` — Signal-fetching SQL queries
  - `llm-api.ts` — LLM proxy integration (Anthropic/OpenAI/Gemini)
  - `db.ts` — PostgreSQL connection pool, CRUD operations, auto-migrations
  - `dataset-segments.ts` — Custom SQL execution for dataset building (BigQuery)
  - `dataset-analytics.ts` — Stratified analytics computation (confusion matrix, agreement metrics, auto-tags)
  - `prompts.ts` — Loads prompt templates from `src/prompts/*.md`
- `src/types/dispute-pipeline.ts` — Zod schemas and TypeScript types (RiskLevel, DisputeProfile, PlannerOutput, RunConfig, RubricWeights, etc.)

### Frontend (`packages/frontend`) — React 18, Vite 6, Tailwind CSS

- `src/pages/` — Four main pages: `TimelineAnalyzer.tsx`, `RubricTester.tsx`, `DatasetBuilder.tsx`, `DatasetDetail.tsx`
- `src/components/` — UI components organized by feature (`timeline-analyzer/`, `rubric-tester/`, `dataset-builder/`, `charts/`, `ui/`, `layout/`)
- `src/hooks/` — React Query (TanStack Query) hooks for API calls + polling with setInterval
- `src/lib/` — API client, xlsx export, cn helper
- Vite proxies `/api` requests to backend on port 3003
- Uses path alias `@/` mapped to `src/`
- Env prefix: `API_` (variables exposed as `import.meta.env.API_*`)

### Dispute Pipeline (5 layers)

The core domain logic in `dispute-pipeline.ts`:
1. **Layer 0** — Fetch signals from BigQuery, build dispute profile with rubric scoring (0-108 scale → green/amber/red)
2. **Layer 1** — Hard gates: deterministic checks (CIFAS, scammer flag, account status, Railsr history) that force escalation
3. **Layer 2** — Planner: LLM analyzes signals + artifacts + case actions + dialogue, outputs `credit` or `escalate_to_agent`
4. **Layer 3** — Executor: submits TaskCreationRequest or escalation
5. **Layer 4** — Verifier: audit log

### Dataset Builder Architecture

Datasets are **pure ground truth** — case IDs + raw context data + human labels. No LLM pipeline runs on creation.

- **Dataset creation**: Fetches context only (BigQuery signals + case details + artifacts via Gemini + dialogue). No LLM planner call. Concurrency limited to 3 parallel fetches.
- **Dataset tab** (renamed from "Labels"): Shows raw signals and case context for unbiased labeling. No risk badges, no pipeline decisions.
- **Runs**: Each run executes the full pipeline (profile + gates + planner) with a specific model/prompt/rubric config, using cached context from the dataset (no re-fetching from APIs). Supported models: `claude-sonnet-4-5@20250929`, `claude-sonnet-4-6`, `claude-opus-4-6`, `gemini-2.5-flash`.
- **Analytics**: Requires a run selection. Computes confusion matrix, stratified metrics by risk/dispute type/hard gate/rubric bucket, inter-annotator agreement.
- **Refresh**: POST `/:id/refresh` re-fetches context for all cases if underlying data changed.

### Database

- PostgreSQL 16 (Docker Compose, port 5433, user/pass/db: `analytics`)
- Tables: `analysis_jobs`, `dispute_pipeline_runs`, `datasets`, `dataset_cases`, `dataset_runs`, `dataset_run_cases`, `dataset_compositions`
- `datasets` has `status` column ('loading' | 'ready') tracking context fetch progress
- `dataset_cases` stores raw context (raw_signals, case_details, case_actions, dialogue_messages, file_parse_results, enrichment_metadata, context_fetched_at) + human labels
- Migrations: SQL files in `init-db/` (001–009) run on Docker init + runtime auto-migrations in `db.ts`
- External volume: `anna-ws-analytics_pgdata`

### External APIs

Backend calls several internal ANNA services (case-ag, file-share-ag, tasks, chat, llm-proxy) — URLs configured via environment variables. See `packages/backend/.env.example` for the full list. Key env vars: `GCP_PROJECT_ID`, `BIGQUERY_DATASET`, `LLM_PROVIDER`, `LLM_MODEL`, `API_TOKEN`.

## Key Conventions

- **ES modules throughout** — `"type": "module"` in both packages. Backend imports **must use `.js` extensions** (e.g., `import { foo } from './services/bar.js'`), required by NodeNext module resolution.
- Zod for runtime validation of API responses and pipeline data
- LLM response parsing uses 3-tier fallback: markdown code block extraction → full JSON parse → brace-counting extraction
- Async analysis jobs are non-blocking with polling via status endpoints (1s for timeline jobs, 5s for job lists)
- ESLint 9 flat config (`eslint.config.mjs`): `@typescript-eslint/no-unused-vars` allows `^_` prefix for intentional ignores
- Specs and design docs live in `docs/specs/`
