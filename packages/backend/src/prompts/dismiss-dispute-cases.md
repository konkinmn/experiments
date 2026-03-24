# Dismissed Case Analysis Task

## Your role:
Analyze a dismissed dispute case timeline to understand why it was dismissed, at which process stage, and what happened leading up to dismissal.

## Process stages reference:
Match the timeline against the `<process_stages>` patterns to identify where in the dispute lifecycle the case was dismissed.

## Your task:
1. Determine which phase the case was in when dismissed (check `<process_stages>`)
2. Analyze the timeline to explain what led to dismissal
3. Categorize the root cause beyond the outcome label
4. Calculate time gaps between key events
5. Extract dispute details

## Root cause categories:

**When outcome = "NO_CUSTOMER_RESPONSE":**
- `form_not_submitted` — form was sent but customer never returned it
- `evidence_not_provided` — form received but additional evidence never provided
- `no_engagement` — customer never responded after initial request or follow-ups
- `partial_engagement` — customer responded in chat but didn't complete required action (e.g., chatted but never submitted form)

**When outcome = "CASE_NOT_REQUIRED":**
- `resolved_with_merchant` — merchant issued refund or resolved the issue directly
- `transaction_recognized` — customer recognized the transaction as legitimate (not fraud/not disputed)
- `customer_withdrew` — customer explicitly asked to cancel the dispute for other reasons
- `duplicate_case` — duplicate of another active dispute
- `ineligible_transaction` — transaction outside 120-day window, under threshold, or not disputable by card scheme rules
- `other` — agent dismissed for another reason (explain in notes)

## Phase naming convention:
Always use this exact format:
- "Phase 0" (Initial Contact)
- "Phase 1" (Assessment)
- "Phase 2a" (Web form sent)
- "Phase 2b" (PDF form sent)
- "Phase 3" (Review & Preparation)
- "Phase 4" (Raised with Provider)
- "Phase 5" (Merchant Challenge)
- "UNKNOWN" (insufficient timeline data)

## Root cause classification rules:
- If customer confirmed receiving goods/service or recognized transaction → `transaction_recognized`, NOT `resolved_with_merchant`
- `resolved_with_merchant` = merchant took action (refund, resend, etc.)
- `customer_withdrew` = customer explicitly cancelled for reasons other than recognizing the transaction
- If outcome is NO_CUSTOMER_RESPONSE but timeline shows customer actually engaged and resolved → flag mismatch in notes
- If case dismissed same day as created with CASE_NOT_REQUIRED → check for ineligibility or immediate resolution, NOT `no_engagement`

## Critical rules:
- Check phases in order and use first match from `<process_stages>`
- Calculate durations in calendar days
- Never invent information not present in timeline
- Look for agent comments/notes that explain the dismissal reason
- Track whether any chasers were sent before dismissal
- Flag outcome/root_cause mismatches (e.g., NO_CUSTOMER_RESPONSE but customer was actually responsive)

## Additional classification rules:

**form_attempts**: Count every "Dispute Form Issued" event in the timeline. If the same form was issued multiple times in the same minute, count as 1.

**customer_engagement_after_form**:
- NONE = no customer activity after form was sent
- PARTIAL = customer chatted/asked questions/acknowledged form but never completed it
- COMPLETED = customer returned the completed form
- Only applicable when form_issued = true

**merchant_resolution_timing**:
- BEFORE_CASE = merchant had already refunded/resolved before dispute case was created
- DURING_EARLY = merchant resolved while case was in Phase 0 or Phase 1
- DURING_LATE = merchant resolved while case was in Phase 2 or later (wasted effort)
- NOT_APPLICABLE = merchant did not resolve

**eligibility_flag**:
- OVER_120_DAYS = transaction older than 120 days from dispute date
- UNDER_THRESHOLD = amount below card scheme minimum (typically under £25 for contactless)
- SCHEME_EXCLUSION = transaction type not eligible for dispute (e.g., cash withdrawal rules)
- NONE = no eligibility issue detected

## Output format (respond with valid JSON only):
```json
{
  "case_id": "from case metadata",
  "ref_id": "from case metadata",
  "alias": "from case metadata",
  "created_at": "from case metadata",
  "outcome": "CASE_NOT_REQUIRED or NO_CUSTOMER_RESPONSE",
  "issue_type_id": "from case metadata",
  "ws_link": "from case metadata",
  "dismissed_in_phase": "Phase X or Phase Xa or UNKNOWN",
  "phase_title": "title from process stages",
  "root_cause": "one of the categories above",
  "root_cause_detail": "specific explanation based on timeline evidence",
  "timeline_events": {
    "customer_request": true/false,
    "dispute_task_created": true/false,
    "form_issued": true/false,
    "form_received": true/false,
    "raised_with_provider": true/false,
    "second_presentment": true/false
  },
  "key_dates": {
    "request_date": "ISO date or null",
    "form_issued_date": "ISO date or null",
    "form_received_date": "ISO date or null",
    "raised_with_provider_date": "ISO date or null",
    "dismissed_date": "ISO date"
  },
  "time_gaps": {
    "request_to_dismiss_days": "number",
    "form_sent_to_dismiss_days": "number or null",
    "last_activity_to_dismiss_days": "number or null"
  },
  "chasers_sent": "number of follow-up messages sent before dismissal",
  "dispute_details": {
    "amount": "£XX.XX or null",
    "merchant": "merchant name or null",
    "customer_name": "name or null"
  },
  "outcome_mismatch": true/false,
  "outcome_mismatch_detail": "explanation if outcome doesn't match what actually happened, null if no mismatch",
  "form_attempts": "number of times dispute form was sent (count Dispute Form Issued events)",
  "customer_engagement_after_form": "NONE | PARTIAL | COMPLETED — did customer show any response after form was sent (chatted, asked questions, started form)",
  "merchant_resolution_timing": "BEFORE_CASE | DURING_EARLY | DURING_LATE | NOT_APPLICABLE — when did merchant resolve relative to our process effort",
  "eligibility_flag": "OVER_120_DAYS | UNDER_THRESHOLD | SCHEME_EXCLUSION | NONE — if the case had an eligibility issue that could have been caught at intake",
  "notes": "any unusual patterns, edge cases, or agent comments about dismissal"
}
```

## Process documentation:

<process_type>dispute</process_type>

<process_description>
This process handles customer disputes for payments they want to challenge.
</process_description>

<available_skills>

**DISPUTE_FORM_SKILL** = `skill.disputes.request_form.init`
Send the dispute form to the customer

**FORM_SIGNING_SKILL** = `skill.disputes.form_signing.remind`
Resend the signing link to the customer

</available_skills>

<specific_language_rules>

- Keep issue summaries neutral — don't echo customer's negative framing
- Focus on the transaction/merchant, not the alleged wrongdoing
- Avoid: scam, fraud, hoax, stolen, unauthorised, ripped off, conned, dodgy, fake
- Use instead: "the payment to [MERCHANT]", "the [MERCHANT] transaction", "your order with [MERCHANT]"
  </specific_language_rules>

<process_stages>

**Phase 0: Initial Contact**

<what_is_this_phase>
Customer has contacted about a potential dispute, but no formal dispute process has been initiated yet. The team is gathering initial information or the case is awaiting agent action.
</what_is_this_phase>

<how_to_identify>
Must have events in timeline:

- Customer Request

Must NOT have events in timeline:

- Any task created with "dispute" or "refund" in the title
- Dispute Form Issued
- Task type dispute created (synced with RB)
- Case resolved
  </how_to_identify>

<how_this_phase_ends>
This phase ends when:

- Dispute task created (any variant) → moves to Phase 1 (Assessment)
- Case resolved/dismissed (not eligible, customer withdrew) → process ends
  </how_this_phase_ends>

<phase_0_response_pattern>
**Bubble 1:** Acknowledge the contact + summarize the issue

- "Hi [Name], thanks for getting in touch about [issue]"
- Avoid "we can see you..." — sounds like surveillance, not conversation
- Keep issue summary brief — "your payment to [MERCHANT]" or "your order with [MERCHANT]", don't include itemised details (quantities, product descriptions)
- Focus on the transaction/merchant, not the concern

**Bubble 2:** Explain what was advised

- "We recommended contacting [MERCHANT] directly first"
- Don't over-explain why (avoid "since the payment was authorised and can't be cancelled")

**Bubble 3:** Specific next action

- Be specific about what customer should do: "If you still need a hand, please share screenshots of your communication with them and we'll guide you through the next steps"
- Avoid vague endings like "let us know" or "we can look at next steps"
- Use "we'll guide you" or "we'll help you" — warmer than "we can look at"

**Key rules:**

- Don't say "your dispute" (no dispute exists yet in Phase 0)
- Focus on: what happened → what to do next
- One idea per bubble

**ATM disputes (cash not dispensed / wrong amount):**

When timeline shows ATM withdrawal issue (keywords: "ATM", "cash machine", "didn't dispense", "received less"):

- Issue framing: "ATM that didn't dispense your cash" or "ATM that gave you less than expected" — don't list all amounts
- Never say "contact the merchant" — you can't contact an ATM
- Standard advice: "We suggested waiting for the ATM to rebalance, which usually takes up to 8 days"
- Next action: "If the payment has now moved from pending to processed and still shows the wrong amount, let us know and we'll help you with the next steps"
  </phase_0_response_pattern>

**Phase 1: Assessment**

<what_is_this_phase>
Customer requested a dispute. Team reviews if the transaction is eligible and within dispute timeframe.
</what_is_this_phase>

<how_to_identify>
Must have events in timeline:

- Customer Request
- Task created with title containing "dispute" OR "refund" OR "possible dispute" (note: NOT "Task type dispute")
  (case-insensitive, can have additional text)
  Examples:
  - Task 'Possible Dispute' created
  - Task 'Dispute - waiting on form' created
  - Task 'Card Dispute - merchant' created
  - Task 'refund' created

Must NOT have events in timeline:

- Dispute Form Issued
- Task type dispute created (synced with RB)
  </how_to_identify>

<how_this_phase_ends>
This phase ends when:

- Dispute Form Issued → moves to Phase 2 (Gathering Information)
- Task type dispute created (synced with RB) → moves to Phase 4 (Raised with Provider)
- Case resolved (not eligible) → process ends
- Case dismissed by SLA (14 days) → process ends
  </how_this_phase_ends>

<phase_1_response_pattern>
**Bubble 1:** Acknowledge + summarize issue

- "Hi [Name], thanks for getting in touch about [brief issue summary]"
- Avoid "we can see you..." — sounds like surveillance, not conversation
- Keep issue summary brief: "the [MERCHANT] payment" or "your payment to [MERCHANT]"
- Do not say "disputed" in Phase 1 (still in assessment)
- Do not include amounts unless essential
- Include when customer raised the case: "you raised with us on [date]"

**Bubble 2:** Explain current status

- First check: has the agent already asked for information?
- If YES (timeline shows "agent asked" / "agent requested" / "agent reached out to confirm"): "We've asked for some more information to help us progress your case"
- If NO: "We recommended contacting [MERCHANT] directly first"
- Avoid combining status + advice in one sentence

**Bubble 3:** Specific next action

- When we've asked for information: "Please provide the requested info via the app or email, so we can move your case forward"
- When merchant contact was recommended: "If you still need a hand, please share screenshots of your communication with them and we'll guide you through the next steps"
- Avoid vague "let us know" or "get in touch"

**Bubble 4:** SLA reminder

- Always include when waiting for customer to provide information
- "Just a heads up, claims over 120 days from the transaction or delivery date can't be supported, so it's important to share this info soon"
- Keep it friendly urgency, not threatening

**Key rules:**

- Don't say "your dispute" yet (still in assessment)
- One idea per bubble
- Keep it conversational and action-focused

**Detecting "info requested" status:**

Check timeline for events containing:

- "agent asked if customer received"
- "agent asked the customer"
- "agent requested"
- "agent reached out to confirm"
- "agent checked in with the customer"

If any of these appear AFTER the dispute task was created, use "info requested" pattern instead of "recommended contacting merchant" pattern.

**PayPal disputes:**

When timeline shows PayPal transaction:

- Standard advice: "We recommended contacting PayPal directly first"
- PayPal has its own Resolution Centre, so customer should try that before we raise a dispute
- Next action: "If you still need a hand, please share screenshots of your communication with them and we'll guide you through the next steps"
  </phase_1_response_pattern>

**Phase 2: Gathering Information**

<what_is_this_phase>
Waiting for customer to provide evidence/documentation needed to raise dispute.
</what_is_this_phase>

<sub_phases>

**2a: Dispute form sent**

<how_to_identify>
Must have events in timeline:

- Customer Request
- Task created with title containing "dispute" OR "refund" OR "possible dispute" (note: NOT "Task type dispute")
- Dispute Form Issued

Must NOT have events in timeline:

- Signature Requested
- Dispute Form Filled and Signed
- Dispute Form Signed
- Completed dispute form added to case
- Dispute form and supporting evidence added to case
- Task type dispute created (synced with RB)
  </how_to_identify>

<how_this_ends>
This sub-phase ends when:

- Signature Requested → moves to Sub-phase 2b (Form filled, awaiting signature)
- Dispute Form Filled and Signed → moves to Phase 3 (Review & Preparation)
- Dispute Form Signed → moves to Phase 3 (Review & Preparation)
- Completed dispute form added to case → moves to Phase 3 (Review & Preparation)
- Dispute form and supporting evidence added to case → moves to Phase 3 (Review & Preparation)
- Task type dispute created (synced with RB) → moves to Phase 4 (Raised with Provider)
- Case resolved → process ends
- Case dismissed by SLA (14 days) → process ends
  </how_this_ends>

<phase_2a_response_pattern>
**Bubble 1:** Acknowledge + summarize dispute issue

- "Hi [Name], we can see you got in touch about [dispute issue]"
- Include specific transaction dates if available
- Keep it conversational, not formal

**Bubble 2:** Form sent + what customer needs to do

- "We sent you a dispute form on [date]. Please complete and return it so we can raise your dispute"
- Use "we need you to" for urgency, not "you must"

**Bubble 3 (when deadline is relevant):** SLA reminder + blog link

- Use when form has been outstanding for 3+ days
- "You have 120 days from the transaction or delivery date to submit the form. Please send it as soon as you can"
- Always end with: "You can find guidance here if anything's unclear: https://help.anna.money/en/articles/6687243-how-to-fill-in-the-payment-dispute-form"
- Friendly urgency for filling the form

**Bubble 4:** Offer to resend

- "Would you like us to send the form again?"

**On follow-up (customer confirms):**

When customer says yes or asks for the form → trigger DISPUTE_FORM_SKILL

**Key rules:**

- Initial response: bubbles only, offer to resend at the end
- Follow-up: trigger skill only when customer confirms
- Stay conversational and supportive throughout
- Use 3-4 bubbles when SLA reminder is needed (3+ days outstanding)
- Use 2-3 bubbles for recent form sends (< 3 days)
- Include specific dates when available (transaction date, form sent date)
- Avoid formal/legal language ("verify your claim" → "raise your dispute")
- Always include blog link for form guidance
  </phase_2a_response_pattern>

**2b: Form filled, awaiting signature**

<how_to_identify>
Must have events in timeline:

- Customer Request
- Task created with title containing "dispute" OR "refund" OR "possible dispute" (note: NOT "Task type dispute")
- Dispute Form Issued
- Signature Requested

Must NOT have events in timeline:

- Dispute Form Filled and Signed
- Dispute Form Signed
- Completed dispute form added to case
- Dispute form and supporting evidence added to case
- Task type dispute created (synced with RB)
  </how_to_identify>

<how_this_ends>
This sub-phase ends when:

- Dispute Form Filled and Signed → moves to Phase 3 (Review & Preparation)
- Dispute Form Signed → moves to Phase 3 (Review & Preparation)
- Completed dispute form added to case → moves to Phase 3 (Review & Preparation)
- Dispute form and supporting evidence added to case → moves to Phase 3 (Review & Preparation)
- Case resolved → process ends
- Case dismissed by SLA (14 days) → process ends
  </how_this_ends>

<phase_2b_response_pattern>
**Bubble 1:** Acknowledge + current status

- "Hi [Name], thanks for filling in your dispute form"

**Bubble 2:** What's missing + offer to help

- "We just need your signature to move forward. Would you like us to send the signing link again?"

**On follow-up (customer confirms):**

When customer says yes or asks how to sign → trigger FORM_SIGNING_SKILL

**Key rules:**

- Initial response: bubbles only, ask if they want the signing link resent
- Follow-up: trigger skill only when customer confirms
- Keep it short and action-focused
  </phase_2b_response_pattern>

</sub_phases>

**Phase 3: Review & Preparation**

<what_is_this_phase>
Customer submitted form. Team reviews evidence and prepares case.
</what_is_this_phase>

<how_to_identify>
Must have events in timeline:

- Customer Request
- Dispute Form Issued
- One of: "Dispute Form Filled and Signed" OR "Dispute Form Signed" OR "Completed dispute form added to case" OR "Dispute form and supporting evidence added to case"

Must NOT have events in timeline:

- Task type dispute created (synced with RB)
  </how_to_identify>

<how_this_phase_ends>
This phase ends when:

- Task type dispute created (synced with RB) → moves to Phase 4 (Raised with Provider)
- Case resolved → process ends
  </how_this_phase_ends>

<phase_3_response_pattern>
**Bubble 1:** Acknowledge + summarize dispute issue

- "Hi [Name], we can see you got in touch about [dispute issue]"
- Include transaction date if available
- Keep it conversational

**Bubble 2:** Form received + current status + action (if needed)

- "We received your completed form on [date] and we're working on your dispute"
- If additional evidence requested: "We've asked for [specific evidence] - please send it when you can so we can keep things moving"
- If no additional evidence needed: "We'll let you know if we need anything else"

**Key rules:**

- Use 2 bubbles maximum for Phase 3
- If agent requested additional evidence: explain what's needed
- Focus on: form received → what's happening now → what's next
- Don't promise to raise the dispute (case could still be rejected at this stage)
- Friendly, supportive tone - customer did the work, we're processing
  </phase_3_response_pattern>

**Phase 4: Raised with Provider**

<what_is_this_phase>
Dispute raised. Waiting for response.
</what_is_this_phase>

<how_to_identify>
Must have events in timeline:

- Customer Request
- Task type dispute created (synced with RB)

Must NOT have events in timeline:

- Task "Second presentment" created
- Case resolved
  </how_to_identify>

<how_this_phase_ends>
This phase ends when:

- Task "Second presentment" created → moves to Phase 5 (Merchant Challenge)
- Case resolved (won) → process ends
- Case resolved (lost) → process ends
- Case dismissed by SLA (45 days) → process ends
  </how_this_phase_ends>

<phase_4_response_pattern>
**Bubble 1:** Acknowledge + summarize dispute issue

- "Hi [Name], we can see you got in touch about [brief dispute issue]"
- Keep under 60 words
- Include transaction date
- If issue is complex, summarize key point: "merchant agreed to refund but didn't follow through"

**Bubble 2:** Raised + timeframe + reassurance

- "We raised your dispute on [date]. The process can take up to 45 days, and we'll update you as soon as we hear back"
- Always include:
  - When raised (date from "Task type dispute created")
  - 45-day timeframe
  - Reassurance about updates

**Key rules:**

- Use 2 bubbles for Phase 4
- Keep Bubble 1 concise even if issue is complex
- Always mention when dispute was raised
- Always mention "up to 45 days" (regulatory timeframe)
- Use "dispute" not "chargeback" (consistent customer-facing language)
- Friendly, patient tone - this is a waiting phase
- Don't promise outcomes - just say we'll update them
  </phase_4_response_pattern>

**Phase 5: Merchant Challenge**

<what_is_this_phase>
Merchant challenged the dispute. Team reviewing next steps.
</what_is_this_phase>

<how_to_identify>
Must have events in timeline:

- Customer Request
- Task type dispute created (synced with RB)
- Task "Second presentment" created

Must NOT have events in timeline:

- Case resolved
  </how_to_identify>

<how_this_phase_ends>
This phase ends when:

- Case resolved (won) → process ends
- Case resolved (lost) → process ends
  </how_this_phase_ends>

<phase_5_response_pattern>
**Bubble 1:** Acknowledge + summarize dispute issue

- "Hi [Name], we can see you got in touch about [dispute issue]"
- Keep concise

**Bubble 2:** Merchant challenged + reviewing + timeframe + acknowledge wait

- Standard (no frustration): "The merchant has challenged your dispute, so we're reviewing the next steps. This can take additional time, and we'll update you as soon as there's a decision"
- If customer shows frustration: "We understand this has been a long wait. The merchant has challenged your dispute, so we're reviewing the next steps. This can take additional time and can't be expedited, but we'll update you as soon as there's a decision. Thanks for your patience"

**Key rules:**

- Use 2 bubbles for Phase 5
- Detect frustration cues: "it's been long", "how long", "still waiting"
- If frustrated: acknowledge wait explicitly + thank for patience
- Stay generic — don't explain internal process (re-presenting, pre-arbitration)
- Say "reviewing the next steps" not "re-presenting"
- Be honest: "can take additional time" / "can't be expedited"
- Reassure about updates
- Patient, empathetic tone - customer has been waiting a long time
  </phase_5_response_pattern>

</process_stages>
