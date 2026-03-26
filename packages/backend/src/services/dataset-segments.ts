import { getBigQueryService } from './bigquery.js';

export interface SegmentDefinition {
  key: string;
  label: string;
  description: string;
}

export const SEGMENTS: SegmentDefinition[] = [
  {
    key: 'clear_credit',
    label: 'Clear credit',
    description: 'Strong candidates for correct credit decision — low amount, mature account, resolved with refund',
  },
  {
    key: 'hard_gate',
    label: 'Hard gate',
    description: 'Cases that should immediately escalate — CIFAS match or confirmed scammer flag',
  },
  {
    key: 'missing_evidence',
    label: 'Missing evidence',
    description: 'Fraud claimed but no crime reference number provided in dispute form',
  },
  {
    key: 'out_of_scope',
    label: 'Out of scope',
    description: 'Transaction amount exceeds £25 threshold (up to £500)',
  },
  {
    key: 'borderline',
    label: 'Borderline',
    description: 'Recent resolved disputes — borderline cases emerge from rubric scoring (40–70 range)',
  },
  {
    key: 'complex',
    label: 'Complex',
    description: 'Recent resolved disputes — complex cases are manually identified during labeling',
  },
];

const SEGMENT_QUERIES: Record<string, string> = {
  clear_credit: `
SELECT c.id AS case_id
FROM \`anna-money.export.case_case\` c
JOIN \`anna-money.export.account_customer\` ac ON ac.magneta_alias = c.alias
JOIN \`anna-money.export.case_case_artifact\` a ON a.case_id = c.id
JOIN \`anna-money.trusted.business_account__processed_transactions\` t ON t.id = a.artifact_id
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.outcome = 'CUSTOMER_REFUNDED'
  AND a.artifact_type = 'TRANSACTION'
  AND ABS(t.amount) <= 25
  AND DATE_DIFF(DATE(c.created_at), DATE(ac.created), DAY) >= 365
  AND c.created_at >= TIMESTAMP('2026-01-01')
GROUP BY c.id
ORDER BY MAX(c.created_at) DESC
LIMIT 30`,

  hard_gate: `
SELECT c.id AS case_id
FROM \`anna-money.export.case_case\` c
LEFT JOIN \`anna-money.expiring_tables.cifas_matches\` cf ON cf.alias = c.alias
LEFT JOIN \`anna-money.export.task_manager_agent_tasks\` scam
  ON scam.alias = c.alias AND scam.group_id = 'd33eb1ad-5190-44d0-9ff5-af7119b3cd19'
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
  AND (cf.id IS NOT NULL OR scam.id IS NOT NULL)
GROUP BY c.id
ORDER BY MAX(c.created_at) DESC
LIMIT 20`,

  missing_evidence: `
SELECT c.id AS case_id
FROM \`anna-money.export.case_case\` c
JOIN \`anna-money.export.workstation_case_actions\` ca ON ca.case_id = c.id
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND ca.action_type = 'DISPUTE_FORM_FILLED'
  AND JSON_EXTRACT_SCALAR(ca.metadata, '$.crime_ref_number') IS NULL
  AND c.created_at >= TIMESTAMP('2026-01-01')
GROUP BY c.id
ORDER BY MAX(c.created_at) DESC
LIMIT 20`,

  out_of_scope: `
SELECT c.id AS case_id
FROM \`anna-money.export.case_case\` c
JOIN \`anna-money.export.case_case_artifact\` a ON a.case_id = c.id
JOIN \`anna-money.trusted.business_account__processed_transactions\` t ON t.id = a.artifact_id
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND a.artifact_type = 'TRANSACTION'
  AND ABS(t.amount) > 25
  AND ABS(t.amount) <= 500
  AND c.created_at >= TIMESTAMP('2026-01-01')
GROUP BY c.id
ORDER BY MAX(c.created_at) DESC
LIMIT 20`,

  // Borderline and complex use the same query — recent resolved disputes.
  // Borderline cases emerge from rubric scoring (40–70 range).
  // Complex cases are manually identified during labeling.
  borderline: `
SELECT c.id AS case_id
FROM \`anna-money.export.case_case\` c
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
ORDER BY c.created_at DESC
LIMIT 30`,

  complex: `
SELECT c.id AS case_id
FROM \`anna-money.export.case_case\` c
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
ORDER BY c.created_at DESC
LIMIT 30`,
};

export async function fetchSegmentCaseIds(segment: string): Promise<number[]> {
  const query = SEGMENT_QUERIES[segment];
  if (!query) {
    throw new Error(`Unknown segment: ${segment}`);
  }

  const bq = getBigQueryService();
  const rows = await bq.query<{ case_id: number }>(query);
  return rows.map((r) => r.case_id);
}
