import { useQuery, useMutation, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CaseBrowserListParams } from '@/types';

export function useCaseBrowserList(params: CaseBrowserListParams) {
  return useQuery({
    queryKey: ['caseBrowserList', params],
    queryFn: () => api.getCaseBrowserList(params),
    placeholderData: keepPreviousData,
  });
}

export function useCaseBrowserDetail(caseId: string | null) {
  return useQuery({
    queryKey: ['caseBrowserDetail', caseId],
    queryFn: () => api.getCaseBrowserDetail(caseId as string),
    enabled: !!caseId,
    select: (response) => response.data,
  });
}

export function useBulkExportCaseBrowser() {
  return useMutation({
    mutationFn: (caseIds: number[]) => api.bulkExportCaseBrowser(caseIds),
  });
}
