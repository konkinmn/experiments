You are assigning payments-queue tasks to work-types and setting each task's status.

You are given the current QUEUE name, a numbered list of KINDS (`kind | name`), and a list of TASKS with their facts. For every task output exactly one line:

`<task_id>:<kind>:<status>`

- `<kind>` must be one of the KIND slugs provided.
- `<status>` is one of: `ready` (all info present, can action now) · `waiting_customer` (chasing the customer) · `waiting_third_party` (waiting on Railsr/PSP/merchant/liquidator) · `needs_info` (missing required docs/details) · `actionable_now` (a quick deterministic action like return-to-Crown or safe-close).

Decide the kind from the **money and company state, not the case status**:
- Company dissolved/struck-off **and** balance > 0 → the "return to Crown" kind (even if the case is dismissed).
- Company in liquidation/administration **and** balance > 0 → the "send to practitioner" kind.
- Balance ≈ 0 and all cases done → the safe-close kind.
- Missing/delayed international payment → mark `ready` only if MT103 + GPI present (attachments), else `needs_info`.
- Retrieval → `ready` only if all transaction + recipient + intended details are present, else `waiting_customer`/`needs_info`.

Output ONLY the lines — no prose, no JSON, no extra text. One line per task.
