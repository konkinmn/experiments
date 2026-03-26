import { getBigQueryService } from './bigquery.js';
import { fetchCaseActions } from './case-api.js';

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
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
  AND (
    EXISTS (
      SELECT 1
      FROM \`anna-money.expiring_tables.cifas_matches\` cf
      WHERE cf.alias = c.alias
    )
    OR EXISTS (
      SELECT 1
      FROM \`anna-money.export.task_manager_agent_tasks\` scam
      WHERE scam.alias = c.alias
        AND scam.group_id = 'd33eb1ad-5190-44d0-9ff5-af7119b3cd19'
    )
  )
GROUP BY c.id
ORDER BY MAX(c.created_at) DESC
LIMIT 20`,

  missing_evidence: `
SELECT c.id AS case_id
FROM \`anna-money.export.case_case\` c
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
ORDER BY c.created_at DESC
LIMIT 200`,

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

async function runWithConcurrency<T>(
  items: readonly number[],
  limit: number,
  worker: (item: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function next() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
  return results;
}

async function fetchMissingEvidenceCaseIds(): Promise<number[]> {
  const bq = getBigQueryService();
  const rows = await bq.query<{ case_id: number }>(SEGMENT_QUERIES.missing_evidence);
  const candidateCaseIds = rows.map((r) => r.case_id);

  const matches = await runWithConcurrency(candidateCaseIds, 10, async (caseId) => {
    const actions = await fetchCaseActions(caseId);
    const disputeFormAction = actions.find((action) => action.action_type === 'DISPUTE_FORM_FILLED');
    const crimeRefNumber = disputeFormAction?.metadata?.crime_ref_number?.trim();
    return disputeFormAction && !crimeRefNumber ? caseId : null;
  });

  return matches.filter((caseId): caseId is number => caseId !== null).slice(0, 20);
}

export async function fetchSegmentCaseIds(segment: string): Promise<number[]> {
  if (segment === 'missing_evidence') {
    return fetchMissingEvidenceCaseIds();
  }

  const query = SEGMENT_QUERIES[segment];
  if (!query) {
    throw new Error(`Unknown segment: ${segment}`);
  }

  const bq = getBigQueryService();
  const rows = await bq.query<{ case_id: number }>(query);
  return rows.map((r) => r.case_id);
}
