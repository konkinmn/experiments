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

export function useUpdateDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: number; name?: string; description?: string }) =>
      api.updateDataset(params.id, { name: params.name, description: params.description }),
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ['dataset', params.id] });
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
      // Keep polling while context is still being fetched
      const hasPending = data.cases?.some((c) =>
        c.contextFetchedAt === null && !c.contextError &&
        // Legacy: also poll old datasets still running pipeline
        c.pipelineRunId === null && !c.pipelineError
      );
      return hasPending ? 3000 : false;
    },
  });
}

export function useRefreshDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (datasetId: number) => api.refreshDataset(datasetId),
    onSuccess: (_data, datasetId) => {
      queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] });
    },
  });
}

export function useAddDatasetCases() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ datasetId, caseIds }: { datasetId: number; caseIds: number[] }) =>
      api.addDatasetCases(datasetId, caseIds),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dataset', variables.datasetId] });
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

export function useLabelDatasetCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label, notes, labeledBy, confidence, disagreementReason, disagreementNotes }: { id: number; label: DatasetLabel; notes: string | null; labeledBy: string | null; confidence?: string | null; disagreementReason?: string | null; disagreementNotes?: string | null }) =>
      api.labelDatasetCase(id, label, notes, labeledBy, confidence, disagreementReason, disagreementNotes),
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
    mutationFn: ({ id, label, notes, labeledBy, confidence, disagreementReason, disagreementNotes }: { id: number; label: DatasetLabel; notes: string | null; labeledBy: string | null; confidence?: string | null; disagreementReason?: string | null; disagreementNotes?: string | null }) =>
      api.labelRunCase(id, label, notes, labeledBy, confidence, disagreementReason, disagreementNotes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-run-cases'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-runs'] });
    },
  });
}

export function useUpdateRunCaseActionNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, actionNote }: { id: number; actionNote: string | null }) =>
      api.updateRunCaseActionNote(id, actionNote),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-run-cases'] });
    },
  });
}

export function useRetryRunCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runCaseId: number) => api.retryRunCase(runCaseId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-run-cases'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-runs'] });
    },
  });
}

export function useRerunDatasetRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: number) => api.rerunDatasetRun(runId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-run-cases'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-runs'] });
    },
  });
}

export function useRenameDatasetRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, name }: { runId: number; name: string }) => api.renameDatasetRun(runId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-runs'] });
    },
  });
}

export function useDeleteDatasetRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: number) => api.deleteDatasetRun(runId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-runs'] });
    },
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
      description?: string;
    }) => api.createDatasetRun(params.datasetId, {
      name: params.name,
      description: params.description,
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

export function useTagCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tags }: { id: number; tags: string[] }) =>
      api.tagDatasetCase(id, tags),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset'] });
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

export function useLabelDatasetCase2() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label, notes, labeledBy, confidence }: { id: number; label: DatasetLabel; notes: string | null; labeledBy: string | null; confidence?: string | null }) =>
      api.labelDatasetCase2(id, label, notes, labeledBy, confidence),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset'] });
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-analytics'] });
    },
  });
}

export function useComposeDatasets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, description, datasetIds }: { name: string; description: string | null; datasetIds: number[] }) =>
      api.composeDatasets(name, description, datasetIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
}

export function useRunComparison(datasetId: number, runA?: number, runB?: number) {
  return useQuery({
    queryKey: ['run-comparison', datasetId, runA, runB],
    queryFn: () => api.compareRuns(datasetId, runA!, runB!),
    enabled: !!runA && !!runB && runA !== runB,
  });
}

