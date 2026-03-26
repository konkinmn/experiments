import { BigQuery } from '@google-cloud/bigquery';

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
