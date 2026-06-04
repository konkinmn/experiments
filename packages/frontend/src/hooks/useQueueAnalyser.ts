import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { QueueTaskFilters } from '@/types';

export function useQueueGroups() {
  return useQuery({
    queryKey: ['queueGroups'],
    queryFn: () => api.getQueueGroups(),
    select: (r) => r.data,
    staleTime: Infinity,
  });
}

export function useQueueRuns(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: ['queueRuns', page, pageSize],
    queryFn: () => api.getQueueRuns(page, pageSize),
    placeholderData: keepPreviousData,
    // Poll while any run is still in progress so the list reflects completion.
    refetchInterval: (query) =>
      query.state.data?.data.some((r) => r.status === 'running') ? 3000 : false,
  });
}

export function useQueueRun(runId: number | null) {
  return useQuery({
    queryKey: ['queueRun', runId],
    queryFn: () => api.getQueueRun(runId as number),
    enabled: runId != null,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 3000 : false),
  });
}

export function useQueueRunTasks(runId: number | null, filters: QueueTaskFilters, enabled: boolean) {
  return useQuery({
    queryKey: ['queueRunTasks', runId, filters],
    queryFn: () => api.getQueueRunTasks(runId as number, filters),
    enabled: runId != null && enabled,
    select: (r) => r.data,
    placeholderData: keepPreviousData,
  });
}

export function useRunQueueAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, model }: { groupId: string; model?: string }) =>
      api.runQueueAnalysis(groupId, model),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queueRuns'] });
    },
  });
}

export function useDeleteQueueRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: number) => api.deleteQueueRun(runId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queueRuns'] });
    },
  });
}
