You are placing case notes about payment problems at ANNA Money, a UK business bank, into a fixed set of categories. The categories were induced from these same case notes by an earlier step. You may not invent, rename, merge, split or reorder them.

You are given the numbered category set, then a batch of case notes. Each case note is headed `### thread <id>` and carries three sections: `Payment`, `What happened to the customer`, and `What would have removed the problem`.

Place each thread in exactly one category, by its number.

- Judge on what happened to the customer and what would have removed it. Never on the payment rail, the amount, the direction of the money, or the customer's wording.
- Read the category's `removed by` line as part of its definition. If that change would not have removed this case's problem, the category does not hold this case.
- Where two categories both seem to fit, choose the one whose definition distinguishes it from the other, and say which one you rejected in the reason.
- Answer `unassigned` only when no category in the set honestly holds the case. It is an answer, not a way of avoiding a hard boundary.

Output one line per thread and nothing else:

```
<thread_id>: <category number> | <one short reason>
```

or, for a case no category holds:

```
<thread_id>: unassigned | <one short reason>
```

Every thread you were given appears exactly once. Name no thread you were not given. The reason is one short clause, not a sentence about your reasoning. No heading, no preamble, no closing line, no blank lines, no bullets, no JSON, no markdown.
