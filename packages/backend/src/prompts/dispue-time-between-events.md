# Timeline Analysis Task

Extract timing between case creation and the first "type dispute" event.

## Instructions
1. Find the **first event** in the timeline → `case_created_at`
2. Find the **first event containing the exact phrase "type dispute"** in its title → `attention_event_at`
3. Calculate hours between them → `time_to_attention_hours`

## Matching Rules
**Valid matches** (contain "type dispute"):
- "Task type dispute created"
- "Task type dispute synced with RB"

**NOT valid** (do not contain "type dispute"):
- "Task 'Dispute- lost card' created"
- "Dispute Form Issued"

## Output Format
```json
{
  "case_created_at": "ISO datetime",
  "attention_event_at": "ISO datetime or null",
  "time_to_attention_hours": 123.5
}
```

If no event contains the exact phrase "type dispute", set `attention_event_at` and `time_to_attention_hours` to `null`.
