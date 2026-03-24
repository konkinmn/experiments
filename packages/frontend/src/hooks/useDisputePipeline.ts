import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useRunPipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (caseId: number) => api.runDisputePipeline(caseId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipeline-results'] });
    },
  });
}

export function usePipelineResults() {
  return useQuery({
    queryKey: ['pipeline-results'],
    queryFn: () => api.getPipelineResults(),
    select: (response) => response.data,
  });
}

export function useSubmitReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, verdict, notes }: { id: number; verdict: 'correct' | 'incorrect'; notes?: string }) =>
      api.submitPipelineReview(id, verdict, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipeline-results'] });
    },
  });
}

export function useDeletePipelineRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deletePipelineResult(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipeline-results'] });
    },
  });
}
