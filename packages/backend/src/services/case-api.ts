export interface TimelineEntry {
  id: number;
  category: string;
  title: string;
  description: string;
  occurred_at: string;
  sources: unknown[];
}

export interface CaseTimeline {
  caseId: number;
  timeline: TimelineEntry[];
}

export interface CaseDetails {
  id: number;
  ref_id: string;
  alias: string;
  artifacts: unknown[];
  attention_markers: unknown[];
  business_area_id: string;
  company_id: string;
  created_at: string;
  issue_type_id: string;
  members: string[];
  outcome: string | null;
  owner: string | null;
  scope: string;
  status: string;
  summary: string;
  updated_at: string;
}

const CASE_API_BASE_URL = process.env.CASE_API_BASE_URL || 'https://case-ag.k1.anna.money';
const API_TOKEN = process.env.API_TOKEN || '';

export async function fetchCaseTimeline(caseId: number): Promise<CaseTimeline> {
  const url = `${CASE_API_BASE_URL}/api/workstation/cases/${caseId}/timeline`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Case API error: Failed to fetch timeline for case ${caseId}: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { data?: { entries?: TimelineEntry[] } };
  return {
    caseId,
    timeline: data.data?.entries || [],
  };
}

export async function fetchCaseDetails(caseId: number): Promise<CaseDetails> {
  const url = `${CASE_API_BASE_URL}/api/workstation/cases/${caseId}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Case API error: Failed to fetch details for case ${caseId}: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { data?: CaseDetails };
  if (!data.data) {
    throw new Error(`Case API error: No data returned for case ${caseId}`);
  }
  return data.data;
}

export interface CaseListItem {
  id: number;
  [key: string]: unknown;
}

export interface FetchCasesParams {
  issueTypeId?: string;
  status?: string;
  createdAtFrom?: string;  // YYYY-MM-DD
  createdAtTo?: string;    // YYYY-MM-DD
}

export async function fetchFilteredCaseIds(params: FetchCasesParams): Promise<number[]> {
  const allCaseIds: number[] = [];
  let currentPage = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    const queryParams = new URLSearchParams();
    if (params.issueTypeId) queryParams.set('issue_type_id', params.issueTypeId);
    if (params.status) queryParams.set('status', params.status);
    if (params.createdAtFrom) queryParams.set('created_at_from', params.createdAtFrom);
    if (params.createdAtTo) queryParams.set('created_at_to', params.createdAtTo);
    queryParams.set('page', String(currentPage));
    queryParams.set('page_size', '100');

    const url = `${CASE_API_BASE_URL}/api/workstation/agent-cases?${queryParams}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Case API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      data?: {
        cases?: CaseListItem[];
        pagination?: { has_next?: boolean };
      };
    };
    const cases = data?.data?.cases || [];
    allCaseIds.push(...cases.map((c) => c.id));

    hasMorePages = data?.data?.pagination?.has_next || false;
    currentPage++;
  }

  return allCaseIds;
}

export async function fetchCaseTimelines(caseIds: number[]): Promise<Map<number, CaseTimeline>> {
  const results = new Map<number, CaseTimeline>();

  // Fetch timelines in parallel with concurrency limit
  const BATCH_SIZE = 5;
  for (let i = 0; i < caseIds.length; i += BATCH_SIZE) {
    const batch = caseIds.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (caseId) => {
      try {
        const timeline = await fetchCaseTimeline(caseId);
        return { caseId, timeline, error: null };
      } catch (error) {
        return { caseId, timeline: null, error: error instanceof Error ? error.message : String(error) };
      }
    });

    const batchResults = await Promise.all(promises);
    for (const result of batchResults) {
      if (result.timeline) {
        results.set(result.caseId, result.timeline);
      }
    }
  }

  return results;
}
