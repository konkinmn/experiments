import { getBigQueryService } from './bigquery.js';

export async function runCustomSql(sql: string): Promise<number[]> {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  // Reject multi-statement queries
  if (trimmed.includes(';')) {
    throw new Error('Multi-statement queries are not allowed');
  }

  // Only allow SELECT statements (including WITH ... SELECT CTEs)
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    throw new Error('Only SELECT queries are allowed');
  }

  // Block DDL/DML keywords
  const forbidden =
    /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE|GRANT|REVOKE|CALL|EXEC)\b/i;
  if (forbidden.test(trimmed)) {
    throw new Error('Only read-only SELECT queries are allowed');
  }

  // Require explicit LIMIT clause to prevent expensive scans
  if (!/\bLIMIT\b/i.test(trimmed)) {
    throw new Error('Query must include a LIMIT clause (max 100)');
  }

  const bq = getBigQueryService();
  const rows = await bq.query<Record<string, unknown>>(sql, undefined, {
    maximumBytesBilled: '5368709120', // 5 GB scan limit
  });

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
