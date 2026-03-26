# Plan: Dispute Agent — Add CASE_ACTION and DIALOGUE artifact enrichment

## Overview

The dispute pipeline currently only passes `FILE` artifacts to the Planner. This means structured data like crime reference numbers (in `CASE_ACTION`) and customer chat messages (in `DIALOGUE`) are stripped before the Planner sees the case.

This plan adds fetching and passing of both artifact types. Neither requires Gemini — they are already structured data. Gemini remains only for `FILE` artifacts (binary PDFs and images).

## Validation Commands
- `npx tsc --noEmit -p packages/backend`
- `npm run lint --workspace packages/backend`

---

### Task 1: Fetch CASE_ACTION artifacts and extract structured metadata

- [x] In `case-api.ts`, add a `fetchCaseActions(caseId: number): Promise<CaseAction[]>` function:
  - `GET https://tasks.k1.anna.money/api/workstation/case-actions?case_id={caseId}` with `Authorization: Bearer {API_TOKEN}`
  - Return the `data` array from the response
  - On failure: log warning, return empty array — do not throw
- [x] Add `CaseAction` type to backend types:
  ```typescript
  interface CaseAction {
    id: number
    action_type: string        // e.g. "DISPUTE_FORM_FILLED"
    status: string
    created_at: string
    metadata: {
      crime_ref_number?: string
      crime_date?: string
      dispute_form_file_id?: string
      [key: string]: unknown
    }
  }
  ```
- [x] Run validation commands
- [x] Mark completed

### Task 2: Fetch DIALOGUE artifacts and extract message content

- [x] In `case-api.ts`, add a `fetchCaseDialogues(artifactIds: string[]): Promise<DialogueMessage[]>` function that follows the existing two-step pattern:
  - Step 1: `GET {TASKS_BASE_URL}/api/v3/dialogues?id={ids.join(',')}` — get dialogue records including alias
  - Step 2: For each dialogue, `GET {TASKS_BASE_URL}/api/v3/messages?dialogue_id={id}` — get message IDs
  - Step 3: For each dialogue, `GET {CHAT_BASE_URL}/api/2/user/{alias}/messages?id[]={id1}&id[]={id2}...` — get message content
  - Filter out hidden messages (`is_hidden: true`)
  - Return flat array of all messages across all dialogues with fields: `role` (sender_type or similar), `content` (text), `created_at`
  - On any individual failure: log warning, skip that dialogue — do not throw
- [x] Add env vars if not already present: `TASKS_BASE_URL`, `CHAT_BASE_URL`
- [x] Run validation commands
- [x] Mark completed

### Task 3: Add CASE_ACTION and DIALOGUE to pipeline and Planner context

- [x] In `dispute-pipeline.ts`, add `CASE_ACTION` and `DIALOGUE` to `ALLOWED_ARTIFACT_TYPES`
- [x] In `runDisputePipeline`, after fetching case details, run in parallel:
  - Existing: fetch + Gemini-parse `FILE` artifacts
  - New: `fetchCaseActions(caseId)` — get structured metadata
  - New: collect `DIALOGUE` artifact IDs from case artifacts and call `fetchCaseDialogues`
- [x] Build the Planner text payload to include three enrichment sections:
  ```
  ## Case actions
  [{action_type, metadata: {crime_ref_number, crime_date, dispute_form_file_id}}]

  ## Customer dialogue messages
  [{role, content, created_at}]  -- customer messages only, filter out agent/system

  ## File artifact descriptions
  [{filename, description: "<Gemini text description>"}]
  ```
- [x] For dialogue messages: pass **customer messages only** to the Planner — filter to messages where sender is the customer (not agent, not system/ANNABOT). The Planner doesn't need to see agent instructions or ANNABOT notes.
- [x] Save `case_actions` as a separate jsonb column in `dispute_pipeline_runs` for audit trail — add to DB migration `init-db/003-...sql` (or create `004` if `003` already exists)
- [x] Run validation commands
- [x] Mark completed

### Task 4: Update Planner prompt to use new context sections

- [x] In `dispute-planner-v1.md`, add guidance for the new sections:
  - `## Case actions` — "Check for `crime_ref_number` in DISPUTE_FORM_FILLED action metadata. If present, use it in `args.crime_reference`."
  - `## Customer dialogue messages` — "These are the customer's own words about the dispute. Use them to understand what the customer claims happened."
- [x] Ensure the prompt makes clear that `crime_ref_number` from case actions is a reliable structured signal — not inferred
- [x] Run validation commands
- [x] Mark completed

### Task 5: Integration test with case 29452

- [ ] Run pipeline against case 29452 and verify:
  - `CASE_ACTION` with `action_type: DISPUTE_FORM_FILLED` is fetched and `metadata.crime_ref_number: RF26020134020C` appears in Planner context
  - Customer dialogue messages are present in Planner context
  - Planner `thought` references the crime reference number
  - Planner `args.crime_reference` is populated with `RF26020134020C`
  - Decision is `credit` or a well-reasoned escalation — NOT escalation due to missing crime reference
- [ ] If Planner still escalates, check `thought` for the actual reason — fix prompt if needed
- [ ] Run validation commands
- [ ] Mark completed
