import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DatasetLabel, DatasetSourceType, RubricWeights } from '@/types';

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

export function useLabelRunCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label, notes, labeledBy }: { id: number; label: DatasetLabel; notes: string | null; labeledBy: string | null }) =>
      api.labelRunCase(id, label, notes, labeledBy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-run-cases'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-runs'] });
    },
  });
}

export function useRunOptions() {
  return useQuery({
    queryKey: ['run-options'],
    queryFn: () => api.getRunOptions(),
  });
}

export function useDatasetRuns(datasetId: number, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['dataset-runs', datasetId],
    queryFn: () => api.getDatasetRuns(datasetId),
    select: (response) => response.data,
    enabled: options?.enabled ?? true,
    refetchInterval: (query) => {
      const runs = query.state.data?.data;
      if (!runs) return false;
      const hasActive = runs.some((r) => r.status === 'pending' || r.status === 'running');
      return hasActive ? 3000 : false;
    },
  });
}

export function useCreateRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      datasetId: number;
      name: string;
      model: string;
      prompt_version: string;
      rubric_weights: RubricWeights;
    }) => api.createDatasetRun(params.datasetId, {
      name: params.name,
      model: params.model,
      prompt_version: params.prompt_version,
      rubric_weights: params.rubric_weights,
    }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dataset-runs', variables.datasetId] });
    },
  });
}

export function useDatasetRunCases(runId: number, options?: { enabled?: boolean; polling?: boolean }) {
  return useQuery({
    queryKey: ['dataset-run-cases', runId],
    queryFn: () => api.getDatasetRunCases(runId),
    select: (response) => response.data,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.polling ? 3000 : false,
  });
}

export function useDatasetAnalytics(datasetId: number, runId?: number, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['dataset-analytics', datasetId, runId],
    queryFn: () => api.getDatasetAnalytics(datasetId, runId),
    enabled: options?.enabled ?? true,
  });
}

export function useExcludeCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, excluded, reason }: { id: number; excluded: boolean; reason?: string }) =>
      api.excludeDatasetCase(id, excluded, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset'] });
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-analytics'] });
    },
  });
}

export function useDeriveAllTags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (datasetId: number) => api.deriveAllTags(datasetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-analytics'] });
    },
  });
}
