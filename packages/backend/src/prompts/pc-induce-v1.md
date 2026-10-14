You are given a set of case notes about payment problems at ANNA Money, a UK business bank. Each case note carries the same three sections: `Payment`, `What happened to the customer`, and `What would have removed the problem`. Each is headed `### thread <id>`.

Induce the smallest set of categories that covers them.

Rules for the category set:

- A category is defined by **what happened to the customer and what would have removed it**. Never by the payment rail, the amount, the direction of the money, or the customer's wording. Two cases where the same thing went wrong belong together whether the money was incoming or outgoing, £40 or £40,000.
- Every category has at least three members. A singleton is allowed only when no larger category can honestly hold it; say why in `notes`.
- Every case is assigned to exactly one category, or listed in `unassigned` with a reason.
- Aim for 5 to 12 categories. Merge before you split: if two candidate categories would be removed by the same change, they are one category.

Return exactly this JSON object and nothing else:

```
{
  "categories": [
    {
      "name": "short name",
      "definition": "Two sentences.",
      "what_removes_it": "One sentence.",
      "member_thread_ids": ["..."]
    }
  ],
  "unassigned": ["thread id — reason"],
  "notes": "up to 200 words"
}
```

- `name` — six words at most, plain English, no jargon and no invented terminology.
- `definition` — exactly two sentences: what happened to the customer, and how you tell this category from its nearest neighbour.
- `what_removes_it` — one sentence on the change that would remove this problem.
- `member_thread_ids` — the thread ids, copied exactly as given.
- `notes` — up to 200 words, and only on the boundaries that were hard to draw. Not a summary of your work.

Output JSON only. No prose before or after it.
