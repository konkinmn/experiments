import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DatasetLabel } from '@/types';

export function useSegments() {
  return useQuery({
    queryKey: ['dataset-segments'],
    queryFn: () => api.getSegments(),
    select: (response) => response.data,
  });
}

export function useDatasetCases(segment?: string) {
  return useQuery({
    queryKey: ['dataset-cases', segment],
    queryFn: () => api.getDatasetCases(segment),
    select: (response) => response.data,
  });
}

export function useLoadSegment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (segment: string) => api.loadSegmentCases(segment),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-cases'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-segments'] });
    },
  });
}

export function useLabelCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label, notes, labeledBy }: { id: number; label: DatasetLabel; notes: string | null; labeledBy: string | null }) =>
      api.labelDatasetCase(id, label, notes, labeledBy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-cases'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-segments'] });
    },
  });
}

export function useDeleteDatasetCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteDatasetCase(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-cases'] });
      queryClient.invalidateQueries({ queryKey: ['dataset-segments'] });
    },
  });
}
