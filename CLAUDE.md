# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Summary

Monorepo with three experimental tools for the ANNA Dispute Resolution Agent: a **Timeline Analyzer** (LLM-based case analysis), a **Dataset Builder** (ground-truth eval dataset construction with labeling, pipeline runs, and stratified analytics), and a **Case Browser** (drill-down investigation surface — filter cases, open one, inspect every dialogue/message/comment/assessment/artifact, JSON export). The system automates dispute case triage — determining whether a case can be safely credited or needs human review.

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

## Setup

```bash
npm install
cp packages/backend/.env.example packages/backend/.env  # fill in values
```

## Ports

| Service    | Port |
|------------|------|
| Frontend   | 5176 |
| Backend    | 3003 |
| PostgreSQL | 5433 |

## Prerequisites

- Node.js 18+
- Docker (for PostgreSQL)
- Google Cloud SDK with Application Default Credentials (for BigQuery)

## Architecture

**npm workspaces monorepo** with two packages:

### Backend (`packages/backend`) — Fastify 5, TypeScript, ES modules

- `src/server.ts` — Entry point, starts Fastify on PORT (default 3003)
- `src/app.ts` — Fastify app factory, registers CORS and routes
- `src/routes/` — Route handlers:
  - `health.ts` — `GET /health`
  - `timeline-analyzer.ts` — `/api/timeline-analyzer` (prompts, start, status polling, cases)
  - `dataset.ts` — `/api/datasets` (CRUD, labeling, runs, run-options, analytics, compare, compose, rename)
  - `case-browser.ts` — `/api/case-browser` (BQ-only): `GET /list` paginated cases joined to latest dispute assessment; `GET /:caseId` full bundle (case + assessment + dialogues + messages + comments + artifacts + events) — dialogues windowed by alias in `[case_created - 30d, case_created + 7d]`; messages from `verified_tables.assistance_processed_message` (~6h export lag, surfaced via `dataFreshness.bqMaxTimestamp` + drawer banner); `GET /:caseId/export` same with attachment header; `POST /bulk-export` NDJSON stream (≤500 caseIds, 4 concurrent workers via `reply.hijack()`)
- `src/services/` — Core business logic:
  - `dispute-pipeline.ts` — 5-layer pipeline (signals → hard gates → planner → executor → verifier) + `fetchCaseContext()` for dataset context-only fetching. Exports `DEFAULT_PIPELINE_CONFIG` with all configurable defaults (hard gates, rubric weights, scoring rules).
  - `case-api.ts` — External API client (case details, artifacts, actions, dialogues)
  - `bigquery.ts` — BigQuery client for analytical signal queries
  - `signals-query.ts` — Signal-fetching SQL queries
  - `llm-api.ts` — LLM proxy integration (Anthropic/OpenAI/Gemini)
  - `db.ts` — PostgreSQL connection pool, CRUD operations, auto-migrations
  - `dataset-segments.ts` — Custom SQL execution for dataset building (BigQuery)
  - `dataset-analytics.ts` — Stratified analytics computation (confusion matrix, agreement metrics, auto-tags)
  - `prompts.ts` — Loads prompt templates from `src/prompts/*.md`
- `src/types/dispute-pipeline.ts` — TypeScript types and Zod schemas: `RiskLevel`, `DisputeProfile`, `PlannerOutput`, `RunConfig`, `PipelineConfig` (with `HardGateConfig`, `RubricWeights`, `RubricScoringRules`), `AIIterationArtifact`, `buildArtifactFromRun()`, `formatPipelineRun()`, etc.

### Frontend (`packages/frontend`) — React 18, Vite 6, Tailwind CSS

- `src/pages/` — Four pages: `TimelineAnalyzer.tsx`, `DatasetBuilder.tsx`, `DatasetDetail.tsx`, `CaseBrowser.tsx`
- `src/components/` — UI components organized by feature (`timeline-analyzer/`, `dataset-builder/`, `case-browser/`, `charts/`, `ui/`, `layout/`)
- `src/components/case-browser/` — Filters, Table, manual Tailwind `CaseDetailDrawer` (max-w-5xl, Esc/overlay close, lag banner when case.createdAt > bqMaxTimestamp), `TabNav` + 6 tab components (Overview / Dialogues / Messages / Comments / Artifacts / Timeline), `MessageBubble` (chat-style: customer right / operator left / bot italic-center)
- `src/hooks/` — `useTimelineAnalyzer.ts`, `useDatasetBuilder.ts` (React Query hooks), `useCaseFilters.ts` (filter/sort state), `useCaseBrowser.ts` (list, detail, bulk-export mutation)
- `src/types/` — `timeline-analyzer.ts`, `dataset-builder.ts`, `case-browser.ts` (all pipeline + dataset + case-browser types)
- `src/lib/` — API client, xlsx export, cn helper
- UI primitives: Radix UI (dialog, slot) + class-variance-authority + tailwind-merge. Icons: lucide-react.
- Charts: visx (axis, shape, scale, tooltip, responsive)
- Data fetching: TanStack React Query v5. Routing: react-router-dom v7.
- Vite proxies `/api` requests to backend on port 3003
- Uses path alias `@/` mapped to `src/`
- Env prefix: `API_` (variables exposed as `import.meta.env.API_*`)

### Dispute Pipeline (5 layers)

The core domain logic in `dispute-pipeline.ts`:
1. **Layer 0** — Fetch signals from BigQuery, build dispute profile with configurable rubric scoring (0–108 scale → green/amber/red)
2. **Layer 1** — Hard gates: deterministic checks (CIFAS, scammer flag, account status, Railsr history) that force escalation. Each gate is toggleable per run via `HardGateConfig`.
3. **Layer 2** — Planner: LLM analyzes signals + case metadata (issue_type_id, created_at) + case actions + dialogue + parsed file descriptions, outputs `credit` or `escalate_to_agent`
4. **Layer 3** — Executor: currently shadow-only (no live actions)
5. **Layer 4** — Audit log: full pipeline run persisted to `dispute_pipeline_runs`

### Pipeline Configuration (`PipelineConfig`)

All pipeline rules are configurable per dataset run via `PipelineConfig`:
- **`hard_gates`**: Toggle each gate on/off (CIFAS, scammer, account inactive, Railsr). Defaults all on.
- **`rubric_weights`**: Category maxes (account_trust: 58, dispute_history: 30, transaction_risk: 20) and thresholds (green: 70, amber: 40).
- **`scoring_rules`**: All scoring breakpoints are editable — account age brackets, tier points, trust score points, money maker bonus, amount brackets, dispute history brackets, penalties. Defaults in `DEFAULT_SCORING_RULES`.

Stored in `dataset_runs.config` JSONB per run for full reproducibility.

### AI Iteration Artifact

Each pipeline run produces an `AIIterationArtifact` — a structured projection of the run data (dispute profile, hard gate result, planner output, enrichment metadata). Generated by `buildArtifactFromRun()` in `types/dispute-pipeline.ts`. This is the stable contract for future integration with anna-case (WorkStation artifact system). No separate DB storage — it's a view over existing `dispute_pipeline_runs` columns.

### Dataset Builder Architecture

Datasets are **pure ground truth** — case IDs + raw context data + human labels. No LLM pipeline runs on creation.

- **Dataset creation**: Fetches context only (BigQuery signals + case details + artifacts via Gemini + dialogue). No LLM planner call. Concurrency limited to 3 parallel fetches.
- **Dataset tab**: Shows raw signals and case context for unbiased labeling. No risk badges, no pipeline decisions. Supports labeling (credit/escalate/undecided), confidence, disagreement tracking, dual-labeling, manual tags.
- **Runs**: Each run executes the full pipeline with a configurable `PipelineConfig` (model, prompt text, hard gate toggles, rubric weights, scoring rules), using cached context from the dataset. Default model from `LLM_MODEL` env var (fallback: `claude-sonnet-4-5@20250929`). Default prompt: `dispute-planner-v1`. Full prompt text + entire pipeline config stored per run. Runs can be renamed (double-click tab).
- **Run tab UI**: Each case row shows two-column layout — Pipeline output (risk, decision, duration) vs Human Label (dataset label, confidence, tags, notes). Agreement badge (match/disagree) per case. No labeling on run tab — labels come from dataset tab.
- **Analytics**: Requires a run selection. Computes confusion matrix, stratified metrics by risk/dispute type/hard gate/rubric bucket, inter-annotator agreement.
- **Compare**: Side-by-side run comparison showing flipped cases (improved/regressed/changed), delta metrics.
- **Refresh**: POST `/:id/refresh` re-fetches context for all cases if underlying data changed.

### Database

- PostgreSQL 16 (Docker Compose, port 5433, user/pass/db: `analytics`)
- Tables: `analysis_jobs`, `dispute_pipeline_runs`, `datasets`, `dataset_cases`, `dataset_runs`, `dataset_run_cases`, `dataset_compositions`
- `datasets` has `status` column ('loading' | 'ready') tracking context fetch progress
- `dataset_cases` stores raw context (raw_signals, case_details, case_actions, dialogue_messages, file_parse_results, enrichment_metadata, context_fetched_at) + human labels + manual_tags
- `dataset_runs.config` JSONB stores full `RunConfig` including `PipelineConfig` and `prompt_content`
- Migrations: SQL files in `init-db/` (001–009) run on Docker init + runtime auto-migrations in `db.ts`
- External volume: `anna-ws-analytics_pgdata`

### External APIs

Backend calls several internal ANNA services (case-ag, file-share-ag, tasks, chat, llm-proxy) — URLs configured via environment variables. See `packages/backend/.env.example` for the full list. The backend loads `packages/backend/.env` first and falls back to a repo root `.env` if present. Key env vars: `GCP_PROJECT_ID`, `BIGQUERY_DATASET`, `LLM_PROVIDER`, `LLM_MODEL`, `API_TOKEN`.

## Key Conventions

- **ES modules throughout** — `"type": "module"` in both packages. Backend imports **must use `.js` extensions** (e.g., `import { foo } from './services/bar.js'`), required by NodeNext module resolution.
- Zod for runtime validation of API responses and pipeline data
- LLM response parsing uses 3-tier fallback: markdown code block extraction → full JSON parse → brace-counting extraction
- Async analysis jobs are non-blocking with polling via status endpoints (1s for timeline jobs, 5s for job lists)
- ESLint 9 flat config (`eslint.config.mjs`): `@typescript-eslint/no-unused-vars` allows `^_` prefix for intentional ignores
- Specs and design docs live in `docs/specs/`
