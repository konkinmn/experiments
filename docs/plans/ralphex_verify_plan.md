# Plan: Dispute Agent Phase 1 — Complete Implementation

## Overview

Complete the Phase 1 dispute agent eval harness. The pipeline fetches BQ signals and case artifacts, runs hard gates, computes a rubric score, calls the Planner LLM, and saves a full audit record. All execution is in shadow mode — no real actions taken yet.

Current state: core pipeline is implemented and running. Several gaps remain before the eval harness produces reliable Planner decisions.

## Validation Commands
- `npx tsc --noEmit -p packages/backend`
- `npx tsc --noEmit -p packages/frontend`
- `npm run lint --workspace packages/backend`
- `npm run lint --workspace packages/frontend`

---

### Task 1: Verify overview and Phase 1 implementation status
- [x] Read `docs/specs/overview.md` and `docs/specs/phase1.md` in full
- [x] Read `packages/backend/src/services/dispute-pipeline.ts` in full
- [x] Read `packages/backend/src/services/signals-query.ts` in full
- [x] Read `packages/backend/src/services/case-api.ts` in full
- [x] Read `packages/backend/src/prompts/dispute-planner-v1.md` in full
- [x] Read `packages/frontend/src/components/rubric-tester/ResultsTable.tsx` in full
- [x] Produce a brief inline comment listing: (a) what matches the spec, (b) what is missing or wrong
- [x] Mark completed

### Task 2: Fix artifact type restriction and case detail stripping
- [x] In `dispute-pipeline.ts`, update `ALLOWED_ARTIFACT_TYPES` to contain only `DISPUTE_FORM` and `FILE` — remove `FORM`, `EVIDENCE`, `DOCUMENT`
- [x] In `dispute-pipeline.ts`, ensure case details passed to the Planner strip all resolution history: remove `status`, `outcome`, `summary`, agent comments, and any timeline events after form submission — only `id`, `ref_id`, `alias`, `issue_type_id`, and filtered artifacts should pass through
- [x] Verify the same stripping applies to what is saved in `case_details` column in DB (no outcome data persisted either)
- [x] Run validation commands
- [x] Mark completed

### Task 3: Implement file fetch pipeline for artifacts
- [x] Add `FILE_SHARE_BASE_URL` and `MEDIA_BASE_URL` to environment config (with defaults: `https://file-share-ag.k1.anna.money` and `https://media.k1.anna.money`)
- [x] In `case-api.ts`, add `fetchArtifactAsBase64(artifactId: string): Promise<{ base64: string; mimeType: string; filename: string } | null>` function:
  - Step 1: `GET {FILE_SHARE_BASE_URL}/api/workstation/files/{artifactId}` with `Authorization: Bearer {API_TOKEN}` — extract `data.path`, `data.mime_type`, `data.name`
  - Step 2: `GET {MEDIA_BASE_URL}{data.path}` — fetch raw bytes
  - Step 3: encode bytes as base64, return `{ base64, mimeType: data.mime_type, filename: data.name }`
  - On any fetch failure: log warning, return `null` (never throw — individual file failures must not fail the pipeline)
- [x] Run validation commands
- [x] Mark completed

### Task 4: Pass artifacts to Planner as multimodal content
- [x] In `dispute-pipeline.ts`, after filtering artifacts to `DISPUTE_FORM` and `FILE`, call `fetchArtifactAsBase64` for each artifact in parallel using `Promise.allSettled`
- [x] Build the Planner user message as a content array (not a plain string):
  - For each `DISPUTE_FORM` artifact with successful fetch: add `{ type: "file", file: { filename, file_data: "data:application/pdf;base64,{base64}" } }`
  - For each `FILE` artifact with successful fetch: add `{ type: "image_url", image_url: { url: "data:{mimeType};base64,{base64}" } }`
  - Append the existing JSON signals object as `{ type: "text", text: JSON.stringify({dispute_profile, raw_signals, case_details}, null, 2) }`
- [x] Verify `analyzeWithLLM` in `llm-api.ts` accepts content arrays in the user message — update if it only accepts strings
- [x] Run validation commands
- [x] Mark completed

### Task 5: Fix Planner prompt — tier eligibility and missing constraints
- [ ] In `dispute-planner-v1.md`, add explicit constraint: "Tier C, D, and E are all eligible customers. Only Tier B indicates an unestablished account. Do not treat Tier C as elevated risk."
- [ ] Add constraint: "You will always receive an open, unresolved case. Do not factor in any previous resolution history or outcome information when making your decision."
- [ ] Add constraint: "If a dispute form PDF is provided, read it carefully — it contains the customer's fraud type, dispute reason, crime reference, and card status. This is the primary evidence for your decision."
- [ ] Add constraint: "If FILE images are provided, examine them — they are customer-uploaded evidence supporting the dispute."
- [ ] Ensure the output schema in the prompt matches the Zod schema in `dispute-pipeline.ts` exactly
- [ ] Run validation commands
- [ ] Mark completed

### Task 6: Fix risk level derivation — replace old OR logic with rubric score
- [ ] In `dispute-pipeline.ts`, verify `deriveRiskLevel` uses rubric score thresholds: Green ≥ 70, Amber 40–69, Red < 40 or any hard gate
- [ ] If it still uses the old logic (account age < 180d OR trust AMBER OR tier B OR scam victim > 0), replace it with the rubric score approach
- [ ] Ensure `rubric_score` is exposed on the `DisputeProfile` type and included in what is saved to DB and returned to frontend
- [ ] Run validation commands
- [ ] Mark completed

### Task 7: Verify hard gate priority order
- [ ] In `dispute-pipeline.ts`, verify `checkHardGates` uses explicit ordered checks (not `Object.entries` iteration):
  ```
  if (gates.cifas) return 'cifas';
  if (gates.confirmed_scammer) return 'confirmed_scammer';
  if (gates.account_not_active) return 'account_not_active';
  if (gates.railsr_dispute_last_6_months) return 'railsr_dispute_last_6_months';
  return null;
  ```
- [ ] If using `Object.entries`, replace with the explicit ordered version above
- [ ] Run validation commands
- [ ] Mark completed

### Task 8: Add planner raw response to audit log
- [ ] Add `planner_raw_response TEXT` column to `dispute_pipeline_runs` in a new migration `init-db/003-planner-raw-response.sql`
- [ ] In `dispute-pipeline.ts`, capture the raw LLM response string from `callPlanner` and pass it through to `insertPipelineRun`
- [ ] Update `insertPipelineRun` in `db.ts` to save `planner_raw_response`
- [ ] Update `PipelineRunRow` type in `dispute-pipeline.ts` to include `planner_raw_response?: string`
- [ ] Run validation commands
- [ ] Mark completed

### Task 9: Final integration test with case 29452
- [ ] Run the pipeline against case 29452 and verify:
  - BQ signals fetch returns correct data including `tx_count_90_days > 0`
  - `DISPUTE_FORM` artifact is fetched and base64-encoded without error
  - Planner receives the form content and references it in `thought`
  - Planner `thought` does not mention Tier C as a risk factor
  - Dispute profile shows Green risk with score ≥ 70
  - Result saves to DB with all fields populated
- [ ] If any step fails, fix it before marking complete
- [ ] Run validation commands
- [ ] Mark completed
