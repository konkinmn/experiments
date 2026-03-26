import { getBigQueryService } from './bigquery.js';

export interface PresetInfo {
  key: string;
  label: string;
  description: string;
}

interface PresetDefinition extends PresetInfo {
  query: string;
}

const PRESETS: PresetDefinition[] = [
  {
    key: 'clear_credit',
    label: 'Clear credit',
    description:
      'Strong refund candidates — ≤£25, established account (1yr+), resolved with refund',
    query: `
SELECT DISTINCT c.id AS case_id
FROM \`anna-money.export.case_case\` c
JOIN \`anna-money.export.account_customer\` ac ON ac.magneta_alias = c.alias
JOIN \`anna-money.export.case_case_artifact\` a ON a.case_id = c.id
JOIN \`anna-money.trusted.business_account__processed_transactions\` t ON t.id = a.artifact_id
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.outcome = 'CUSTOMER_REFUNDED'
  AND a.artifact_type = 'TRANSACTION'
  AND ABS(t.amount) <= 25
  AND DATE_DIFF(DATE(c.created_at), DATE(ac.created_at), DAY) >= 365
  AND c.created_at >= TIMESTAMP('2026-01-01')
ORDER BY c.created_at DESC
LIMIT 30`,
  },
  {
    key: 'hard_gate',
    label: 'Hard gate',
    description:
      'Cases with CIFAS match or scammer flag — should immediately escalate',
    query: `
SELECT DISTINCT c.id AS case_id
FROM \`anna-money.export.case_case\` c
LEFT JOIN \`anna-money.export.cifas_matches\` cf ON cf.alias = c.alias
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
  AND cf.id IS NOT NULL
ORDER BY c.created_at DESC
LIMIT 20`,
  },
  {
    key: 'missing_evidence',
    label: 'Missing evidence',
    description:
      'Fraud claimed but no case actions recorded — likely missing crime reference',
    query: `
SELECT DISTINCT c.id AS case_id
FROM \`anna-money.export.case_case\` c
JOIN \`anna-money.trusted.business_account__processed_transactions\` t
  ON t.alias = c.alias
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
  AND NOT EXISTS (
    SELECT 1 FROM \`anna-money.export.case_case_artifact\` a
    WHERE a.case_id = c.id AND a.artifact_type = 'CASE_ACTION'
  )
ORDER BY c.created_at DESC
LIMIT 20`,
  },
  {
    key: 'out_of_scope',
    label: 'Out of scope',
    description: 'Transaction amount exceeds £25 threshold (up to £500)',
    query: `
SELECT DISTINCT c.id AS case_id
FROM \`anna-money.export.case_case\` c
JOIN \`anna-money.export.case_case_artifact\` a ON a.case_id = c.id
JOIN \`anna-money.trusted.business_account__processed_transactions\` t ON t.id = a.artifact_id
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND a.artifact_type = 'TRANSACTION'
  AND ABS(t.amount) > 25
  AND ABS(t.amount) <= 500
  AND c.created_at >= TIMESTAMP('2026-01-01')
ORDER BY c.created_at DESC
LIMIT 20`,
  },
  {
    key: 'recent',
    label: 'Recent',
    description:
      'General recent resolved disputes — borderline and complex emerge from rubric scores',
    query: `
SELECT DISTINCT c.id AS case_id
FROM \`anna-money.export.case_case\` c
WHERE c.issue_type_id = 'dispute'
  AND c.status = 'RESOLVED'
  AND c.created_at >= TIMESTAMP('2026-01-01')
ORDER BY c.created_at DESC
LIMIT 30`,
  },
];

export function getPresets(): PresetInfo[] {
  return PRESETS.map(({ key, label, description }) => ({
    key,
    label,
    description,
  }));
}

export async function runPresetQuery(key: string): Promise<number[]> {
  const preset = PRESETS.find((p) => p.key === key);
  if (!preset) {
    throw new Error(`Unknown preset: ${key}`);
  }

  const bq = getBigQueryService();
  const rows = await bq.query<{ case_id: number }>(preset.query);
  return rows.map((r) => r.case_id);
}

// Backward-compatible exports — used by existing routes until Task 3 rewrites them
export const SEGMENTS = getPresets();

export async function fetchSegmentCaseIds(segment: string): Promise<number[]> {
  return runPresetQuery(segment);
}

export async function runCustomSql(sql: string): Promise<number[]> {
  const bq = getBigQueryService();
  const rows = await bq.query<Record<string, unknown>>(sql);

  if (rows.length === 0) {
    return [];
  }

  if (!('case_id' in rows[0])) {
    throw new Error('Query must return a `case_id` column');
  }

  if (rows.length > 100) {
    throw new Error(`Query returned ${rows.length} rows — max 100 allowed`);
  }

  return rows.map((r) => {
    const id = Number(r.case_id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid case_id value: ${r.case_id}`);
    }
    return id;
  });
}
