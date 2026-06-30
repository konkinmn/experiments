import { getBigQueryService } from './bigquery.js';
import type { CaseSignalsRaw } from '../types/dispute-pipeline.js';

export const CASE_SIGNALS_QUERY = `
WITH case_data AS (
  SELECT
    c.id AS case_id,
    c.company_id,
    c.alias,
    c.created_at AS case_created_at,
    SUM(ABS(t.amount)) AS total_amount,
    MAX(ABS(t.amount)) AS max_transaction_amount,
    STRING_AGG(t.merchant_info_name, ', ' ORDER BY t.post_timestamp) AS merchants
  FROM \`anna-money.export.case_case\` c
  JOIN \`anna-money.export.case_case_artifact\` a ON a.case_id = c.id
  JOIN \`anna-money.trusted.business_account__processed_transactions\` t ON t.id = a.artifact_id
  WHERE c.id = @case_id
    AND a.artifact_type = 'TRANSACTION'
  GROUP BY c.id, c.company_id, c.alias, c.created_at
),
case_merchants AS (
  SELECT DISTINCT t.merchant_info_name
  FROM \`anna-money.export.case_case_artifact\` a
  JOIN \`anna-money.trusted.business_account__processed_transactions\` t ON t.id = a.artifact_id
  WHERE a.case_id = @case_id
    AND a.artifact_type = 'TRANSACTION'
),
account_base AS (
  SELECT
    ac.id AS customer_id,
    ac.created AS account_created_at,
    DATE_DIFF(DATE((SELECT case_created_at FROM case_data)), DATE(ac.created), DAY) AS account_age_days,
    ac.status AS current_status
  FROM \`anna-money.export.account_customer\` ac
  WHERE ac.magneta_alias = (SELECT alias FROM case_data)
  LIMIT 1
),
account_status_at_case AS (
  SELECT h.current_status AS historical_status
  FROM \`anna-money.export.account_customer_status_history\` h
  JOIN account_base ab ON h.customer_id = ab.customer_id
  WHERE h.created <= (SELECT case_created_at FROM case_data)
  ORDER BY h.created DESC
  LIMIT 1
),
account_data AS (
  SELECT
    ab.account_created_at,
    ab.account_age_days,
    COALESCE(
      (SELECT historical_status FROM account_status_at_case),
      ab.current_status
    ) AS account_status
  FROM account_base ab
),
cifas_data AS (
  SELECT COUNT(*) AS cifas_count
  FROM \`anna-money.expiring_tables.cifas_matches\` cm
  WHERE cm.alias = (SELECT alias FROM case_data)
),
tier_data AS (
  SELECT COALESCE(
    -- tier at filing: prev_tier of first change AFTER case_created_at
    (SELECT prev_tier_name
     FROM \`anna-money.verified_views.compliance_customer_tier_log\`
     WHERE company_id = (SELECT company_id FROM case_data)
       AND event_timestamp > (SELECT case_created_at FROM case_data)
     ORDER BY event_timestamp ASC
     LIMIT 1),
    -- no change after filing: most recent tier is correct
    (SELECT tier_name
     FROM \`anna-money.verified_views.compliance_customer_tier_log\`
     WHERE company_id = (SELECT company_id FROM case_data)
     ORDER BY event_timestamp DESC
     LIMIT 1),
    -- no log at all: fall back to current tier from limits table
    (SELECT tier_name
     FROM \`anna-money.verified_views.compliance_tier_limits\`
     WHERE company_id = (SELECT company_id FROM case_data)
     LIMIT 1)
  ) AS tier_name
),
money_maker AS (
  SELECT COUNT(*) AS is_money_maker
  FROM \`anna-money.export.account_customer\` ac
  JOIN \`anna-money.export.account_customer_badge_m2m\` b ON b.customer_id = ac.id
  WHERE ac.magneta_alias = (SELECT alias FROM case_data)
    AND b.badge_id = 2
),
trust_score_data AS (
  SELECT score_color AS trust_score
  FROM \`anna-money.verified_views.compliance_trust_score_changes\`
  WHERE company_id = (SELECT company_id FROM case_data)
    AND day <= DATE((SELECT case_created_at FROM case_data))
  ORDER BY day DESC
  LIMIT 1
),
scam_scammer AS (
  SELECT COUNT(*) AS scammer_count
  FROM \`anna-money.export.task_manager_agent_tasks\` t
  WHERE t.alias = (SELECT alias FROM case_data)
    AND t.group_id = 'd33eb1ad-5190-44d0-9ff5-af7119b3cd19'
    AND t.created_at < (SELECT case_created_at FROM case_data)
),
scam_victim AS (
  SELECT COUNT(*) AS victim_count
  FROM \`anna-money.export.task_manager_agent_tasks\` t
  WHERE t.alias = (SELECT alias FROM case_data)
    AND t.group_id = '58447710-7eb4-4ae0-ac01-1761786a3d41'
    AND t.created_at < (SELECT case_created_at FROM case_data)
),
transaction_activity AS (
  SELECT
    COUNT(*) AS tx_count_90_days,
    COUNT(DISTINCT DATE_TRUNC(DATE(t.post_timestamp), MONTH)) AS active_months,
    COUNTIF(t.merchant_info_name IN (SELECT merchant_info_name FROM case_merchants)) AS prior_payments_to_merchant
  FROM \`anna-money.trusted.business_account__processed_transactions\` t
  WHERE t.alias = (SELECT alias FROM case_data)
    AND t.post_timestamp >= TIMESTAMP_SUB((SELECT case_created_at FROM case_data), INTERVAL 90 DAY)
    AND t.post_timestamp < (SELECT case_created_at FROM case_data)
),
dispute_history AS (
  SELECT
    COUNT(*) AS railsr_disputes_last_6_months,
    COUNTIF(t.created_at >= TIMESTAMP_SUB((SELECT case_created_at FROM case_data), INTERVAL 30 DAY)) AS railsr_disputes_last_30_days
  FROM \`anna-money.export.task_manager_agent_tasks\` t
  WHERE
    t.alias = (SELECT alias FROM case_data)
    AND t.task_type = 'DISPUTE'
    AND t.created_at >= TIMESTAMP(DATETIME_SUB(DATETIME((SELECT case_created_at FROM case_data)), INTERVAL 6 MONTH))
    AND t.created_at < (SELECT case_created_at FROM case_data)
),
-- Customer-authentication signal: join the disputed TRANSACTION artifacts to the synced
-- balance table and mirror anna-case signal_fetcher._is_authenticated per transaction.
auth_per_tx AS (
  SELECT
    COALESCE(bvt.payment_token_lifecycle_wallet_type = 'APPLE_PAY', FALSE) AS is_apple_pay,
    COALESCE(bvt.payment_token_lifecycle_wallet_type = 'GOOGLE_PAY', FALSE) AS is_google_pay,
    COALESCE(bvt.pos_data_secure_3d_authentication_method IN (
      'PASSWORD','SECRET_KEY_OR_SECURE_3D_2_0_CHALLENGE_FLOW_OTP_SMS',
      'PKI_OR_SECURE_3D_2_0_CHALLENGE_FLOW_OTP_KEY_FOB_OR_CARD_READER',
      'SECURE_3D_2_0_CHALLENGE_FLOW_OTP_APP','SECURE_3D_2_0_CHALLENGE_FLOW_OTP_OTHER',
      'SECURE_3D_2_0_CHALLENGE_FLOW_KBA','SECURE_3D_2_0_CHALLENGE_FLOW_OOB_BIOMETRIC',
      'SECURE_3D_2_0_CHALLENGE_FLOW_OOB_APP_LOGIN','SECURE_3D_2_0_CHALLENGE_FLOW_OOB_OTHER',
      'SECURE_3D_2_0_CHALLENGE_FLOW_OTHER','SECURE_3D_2_0_PUSH_CONFIRMATION',
      'SECURE_3D_2_0_FRICTIONLESS_FLOW','SECURE_3D_2_0_FRICTIONLESS_FLOW_RBA_REVIEW'
    ), FALSE) AS is_3ds,
    COALESCE('PIN' IN UNNEST(JSON_EXTRACT_STRING_ARRAY(bvt.pos_data_cardholder_authentication_methods)), FALSE) AS has_pin,
    COALESCE('CARDHOLDER_DEVICE' IN UNNEST(JSON_EXTRACT_STRING_ARRAY(bvt.pos_data_cardholder_authentication_entries)), FALSE) AS has_device,
    -- "unknown": no card_transaction_info — approximated as all five auth/pos columns NULL
    (
      bvt.payment_token_lifecycle_wallet_type IS NULL
      AND bvt.pos_data_secure_3d_authentication_method IS NULL
      AND bvt.pos_data_cardholder_authentication_methods IS NULL
      AND bvt.pos_data_cardholder_authentication_entries IS NULL
      AND bvt.pos_data_card_presence_indicator IS NULL
    ) AS is_unknown
  FROM \`anna-money.export.case_case_artifact\` a
  JOIN \`anna-money.export.balance_virtual_transaction\` bvt ON bvt.id = a.artifact_id
  WHERE a.case_id = @case_id
    AND a.artifact_type = 'TRANSACTION'
),
auth_signals AS (
  -- Case-level any-true aggregation (mirror _scan_disputed_transactions): True if ANY disputed
  -- tx is authenticated; False only if at least one is definitively not-authenticated and there
  -- are NO unknowns; NULL otherwise (partial-unknown must stay NULL, not False).
  SELECT
    CASE
      WHEN LOGICAL_OR(is_apple_pay OR is_google_pay OR is_3ds OR has_pin OR has_device) THEN TRUE
      WHEN LOGICAL_OR(NOT (is_apple_pay OR is_google_pay OR is_3ds OR has_pin OR has_device) AND NOT is_unknown)
           AND NOT LOGICAL_OR(is_unknown) THEN FALSE
      ELSE NULL
    END AS is_authenticated,
    -- Label by global priority APPLE_PAY > GOOGLE_PAY > 3DS > PIN > DEVICE; NULL if none.
    CASE
      WHEN LOGICAL_OR(is_apple_pay) THEN 'APPLE_PAY'
      WHEN LOGICAL_OR(is_google_pay) THEN 'GOOGLE_PAY'
      WHEN LOGICAL_OR(is_3ds) THEN '3DS'
      WHEN LOGICAL_OR(has_pin) THEN 'PIN'
      WHEN LOGICAL_OR(has_device) THEN 'DEVICE'
      ELSE NULL
    END AS auth_method
  FROM auth_per_tx
)
SELECT
  cd.*,
  ad.account_age_days,
  ad.account_status,
  COALESCE(cf.cifas_count, 0) AS cifas_count,
  td.tier_name,
  COALESCE(mm.is_money_maker, 0) > 0 AS is_money_maker,
  ts.trust_score,
  COALESCE(ss.scammer_count, 0) AS scammer_count,
  COALESCE(sv.victim_count, 0) AS scam_victim_count,
  COALESCE(ta.tx_count_90_days, 0) AS tx_count_90_days,
  COALESCE(ta.active_months, 0) AS active_months,
  COALESCE(ta.prior_payments_to_merchant, 0) AS prior_payments_to_merchant,
  COALESCE(dh.railsr_disputes_last_6_months, 0) AS railsr_disputes_last_6_months,
  COALESCE(dh.railsr_disputes_last_30_days, 0) AS railsr_disputes_last_30_days,
  aus.is_authenticated,
  aus.auth_method
FROM case_data cd
LEFT JOIN account_data ad ON TRUE
LEFT JOIN cifas_data cf ON TRUE
LEFT JOIN tier_data td ON td.tier_name IS NOT NULL
LEFT JOIN money_maker mm ON TRUE
LEFT JOIN trust_score_data ts ON TRUE
LEFT JOIN scam_scammer ss ON TRUE
LEFT JOIN scam_victim sv ON TRUE
LEFT JOIN transaction_activity ta ON TRUE
LEFT JOIN dispute_history dh ON TRUE
LEFT JOIN auth_signals aus ON TRUE
`;

export async function fetchCaseSignals(caseId: number): Promise<CaseSignalsRaw> {
  const bq = getBigQueryService();
  const rows = await bq.query<CaseSignalsRaw>(CASE_SIGNALS_QUERY, { case_id: caseId });

  if (rows.length === 0) {
    throw new Error(`Case ${caseId} not found in BigQuery`);
  }

  return rows[0];
}
