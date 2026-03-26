import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DatasetLabel, DatasetSourceType } from '@/types';

export function useDatasets() {
  return useQuery({
    queryKey: ['datasets'],
    queryFn: () => api.getDatasets(),
    select: (response) => response.data,
  });
}

export function useCreateDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      name: string;
      description: string | null;
      sourceType: DatasetSourceType;
      sourceConfig: Record<string, unknown>;
    }) => api.createDataset(params.name, params.description, params.sourceType, params.sourceConfig),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

export function useDeleteDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteDataset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

export function useDataset(id: number, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['dataset', id],
    queryFn: () => api.getDataset(id),
    enabled: options?.enabled ?? true,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      // Keep polling only if cases are still pending (no run ID and no error)
      const hasPending = data.cases?.some((c) => c.pipelineRunId === null && !c.pipelineError);
      return hasPending ? 3000 : false;
    },
  });
}

export function useLabelDatasetCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label, notes, labeledBy }: { id: number; label: DatasetLabel; notes: string | null; labeledBy: string | null }) =>
      api.labelDatasetCase(id, label, notes, labeledBy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset'] });
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

export function useDeleteDatasetCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteDatasetCase(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset'] });
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}
