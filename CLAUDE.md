# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Summary

Monorepo with three experimental tools for the ANNA Dispute Resolution Agent: a **Timeline Analyzer** (LLM-based case analysis), a **Rubric Tester** (dispute pipeline evaluation), and a **Dataset Builder** (ground-truth eval dataset construction with labeling). The system automates dispute case triage — determining whether a case can be safely credited or needs human review.

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
- `src/routes/` — Route handlers for timeline-analyzer, dispute-pipeline, dataset, health
- `src/services/` — Core business logic:
  - `dispute-pipeline.ts` — 5-layer pipeline (signals → hard gates → planner → executor → verifier)
  - `case-api.ts` — External API client (case details, artifacts, actions, dialogues)
  - `bigquery.ts` — BigQuery client for analytical signal queries
  - `signals-query.ts` — Signal-fetching SQL queries
  - `llm-api.ts` — LLM proxy integration (Anthropic/OpenAI/Gemini)
  - `db.ts` — PostgreSQL connection pool, CRUD operations, auto-migrations
  - `dataset-segments.ts` — Preset BigQuery segment queries and custom SQL execution for dataset building
  - `prompts.ts` — Loads prompt templates from `src/prompts/*.md`
- `src/prompts/` — Markdown prompt files for LLM calls
- `src/types/` — Zod schemas and TypeScript types

### Frontend (`packages/frontend`) — React 18, Vite 6, Tailwind CSS

- `src/pages/` — Four main pages: `TimelineAnalyzer.tsx`, `RubricTester.tsx`, `DatasetBuilder.tsx`, `DatasetDetail.tsx`
- `src/components/` — UI components organized by feature (`timeline-analyzer/`, `rubric-tester/`, `charts/`, `ui/`, `layout/`)
- `src/hooks/` — React Query hooks for API calls
- `src/lib/` — Utility functions (xlsx export, cn helper)
- Vite proxies `/api` requests to backend on port 3003
- Uses path alias `@/` mapped to `src/`

### Dispute Pipeline (5 layers)

The core domain logic in `dispute-pipeline.ts`:
1. **Layer 0** — Fetch signals from BigQuery, build dispute profile with rubric scoring (0-108 scale → green/amber/red)
2. **Layer 1** — Hard gates: deterministic checks (CIFAS, scammer flag, account status, Railsr history) that force escalation
3. **Layer 2** — Planner: LLM analyzes signals + artifacts + case actions + dialogue, outputs `credit` or `escalate_to_agent`
4. **Layer 3** — Executor: submits TaskCreationRequest or escalation
5. **Layer 4** — Verifier: audit log

### Database

- PostgreSQL 16 (Docker Compose, port 5433, user/pass/db: `analytics`)
- Tables: `analysis_jobs`, `dispute_pipeline_runs`, `datasets`, `dataset_cases`
- Migrations in `init-db/` (SQL files) + runtime auto-migrations in `db.ts`
- External volume: `anna-ws-analytics_pgdata`

### External APIs

Backend calls several internal ANNA services (case-ag, file-share-ag, tasks, chat, llm-proxy) — URLs configured via environment variables. See `packages/backend/.env.example` for the full list.

## Key Conventions

- ES modules throughout (`"type": "module"`, `.js` extensions in imports)
- Zod for runtime validation of API responses and pipeline data
- LLM response parsing uses 3-tier fallback: markdown code block extraction → full JSON parse → brace-counting extraction
- Async analysis jobs are non-blocking with polling via status endpoints
- Specs and design docs live in `docs/specs/`
