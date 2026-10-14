import { BigQuery } from '@google-cloud/bigquery';

/**
 * Named query-parameter types, e.g. `{ dialogue_ids: ['INT64'], win_from: 'DATE' }`.
 * Needed whenever a parameter's type cannot be inferred from its value (DATE
 * strings, empty arrays). Mirrors the client's own `QueryParamTypeStruct`,
 * which the package does not re-export.
 */
export type QueryParamTypeMap = Record<string, string | string[]>;

export class BigQueryService {
  private client: BigQuery;
  private projectId: string;
  private dataset: string;
  private location: string;

  constructor() {
    this.projectId = process.env.GCP_PROJECT_ID || '';
    this.dataset = process.env.BIGQUERY_DATASET || '';
    this.location = process.env.BIGQUERY_LOCATION || 'EU';

    if (!this.projectId) {
      console.warn('GCP_PROJECT_ID not set - BigQuery queries will fail');
    }

    this.client = new BigQuery({
      projectId: this.projectId,
    });
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
    jobOptions?: { maximumBytesBilled?: string },
  ): Promise<T[]> {
    const [rows] = await this.client.query({
      query: sql,
      params,
      location: this.location,
      ...(jobOptions?.maximumBytesBilled
        ? { maximumBytesBilled: jobOptions.maximumBytesBilled }
        : {}),
    });
    return rows as T[];
  }

  /**
   * Same as `query()` but also returns the bytes the job was billed for, so a
   * caller scanning large unpartitioned tables can report its own cost.
   */
  async queryWithStats<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
    jobOptions?: { maximumBytesBilled?: string; types?: QueryParamTypeMap },
  ): Promise<{ rows: T[]; totalBytesProcessed: number }> {
    const [job] = await this.client.createQueryJob({
      query: sql,
      params,
      location: this.location,
      ...(jobOptions?.types ? { types: jobOptions.types } : {}),
      ...(jobOptions?.maximumBytesBilled
        ? { maximumBytesBilled: jobOptions.maximumBytesBilled }
        : {}),
    });
    const [rows] = await job.getQueryResults();
    const [metadata] = await job.getMetadata();
    const stats = (metadata as { statistics?: { query?: Record<string, string> } })?.statistics
      ?.query;
    const bytes = stats?.totalBytesProcessed ?? stats?.totalBytesBilled ?? '0';
    return { rows: rows as T[], totalBytesProcessed: Number(bytes) };
  }

  async queryTable<T = Record<string, unknown>>(
    tableName: string,
    options?: {
      select?: string[];
      where?: string;
      orderBy?: string;
      limit?: number;
    }
  ): Promise<T[]> {
    const columns = options?.select?.join(', ') || '*';
    let sql = `SELECT ${columns} FROM \`${this.projectId}.${this.dataset}.${tableName}\``;

    if (options?.where) {
      sql += ` WHERE ${options.where}`;
    }

    if (options?.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }

    if (options?.limit) {
      sql += ` LIMIT ${options.limit}`;
    }

    return this.query<T>(sql);
  }

  getProjectId(): string {
    return this.projectId;
  }

  getDataset(): string {
    return this.dataset;
  }
}

// Lazy singleton instance (created after env vars are loaded)
let _instance: BigQueryService | null = null;

export function getBigQueryService(): BigQueryService {
  if (!_instance) {
    _instance = new BigQueryService();
  }
  return _instance;
}
