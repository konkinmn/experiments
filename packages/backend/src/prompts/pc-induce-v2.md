You are given a set of case notes about payment problems at ANNA Money, a UK business bank. Each case note carries the same three sections: `Payment`, `What happened to the customer`, and `What would have removed the problem`. Each is headed `### thread <id>`.

Induce the smallest set of categories that covers them.

You will not assign cases here; a later step does that against your category set, so definitions must be sharp enough for someone else to assign by. Give 5–12 categories, each with `name`, `definition` (two sentences: what happened to the customer, and how to tell it from its nearest neighbour), `what_removes_it` (one sentence), and `example_thread_ids` (2–4 ids that clearly belong).

Rules for the category set:

- A category is defined by **what happened to the customer and what would have removed it**. Never by the payment rail, the amount, the direction of the money, or the customer's wording. Two cases where the same thing went wrong belong together whether the money was incoming or outgoing, £40 or £40,000.
- Every category has at least three members. A singleton is allowed only when no larger category can honestly hold it; say why in `notes`.
- Aim for 5 to 12 categories. Merge before you split: if two candidate categories would be removed by the same change, they are one category.

Return exactly this JSON object and nothing else:

```
{
  "categories": [
    {
      "name": "short name",
      "definition": "Two sentences.",
      "what_removes_it": "One sentence.",
      "example_thread_ids": ["..."]
    }
  ],
  "notes": "up to 200 words"
}
```

- `name` — six words at most, plain English, no jargon and no invented terminology.
- `definition` — exactly two sentences: what happened to the customer, and how you tell this category from its nearest neighbour.
- `what_removes_it` — one sentence on the change that would remove this problem.
- `example_thread_ids` — two to four thread ids that clearly belong to this category, copied exactly as given.
- `notes` — up to 200 words, and only on the boundaries that were hard to draw. Not a summary of your work.

Output JSON only. No prose before or after it.
