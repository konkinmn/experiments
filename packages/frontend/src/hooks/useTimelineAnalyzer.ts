import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AnalysisStatus, AnalysisProgress, AnalysisResult, CaseFilterParams } from '@/types';

const POLL_INTERVAL = 1000; // 1 second

interface UseTimelineAnalyzerState {
  status: AnalysisStatus;
  progress: AnalysisProgress;
  results: AnalysisResult[];
  error: string | null;
  jobId: string | null;
}

export function usePrompts() {
  return useQuery({
    queryKey: ['prompts'],
    queryFn: () => api.getPrompts(),
    select: (response) => response.data,
  });
}

export function useFilteredCases() {
  return useMutation({
    mutationFn: (params: CaseFilterParams) => api.getFilteredCaseIds(params),
  });
}

export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.getJobs(),
    select: (response) => response.data,
    refetchInterval: 5000, // Refresh every 5 seconds
  });
}

export function useDeleteJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.cancelAnalysis(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useTimelineAnalyzer(initialJobId?: string | null) {
  const [state, setState] = useState<UseTimelineAnalyzerState>({
    status: initialJobId ? 'running' : 'idle',
    progress: { current: 0, total: 0, currentCaseId: null },
    results: [],
    error: null,
    jobId: initialJobId || null,
  });

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(async (jobId: string) => {
    try {
      const job = await api.getAnalysisStatus(jobId);
      setState((prev) => ({
        ...prev,
        status: job.status === 'running' ? 'running' : job.status === 'completed' ? 'completed' : 'error',
        progress: job.progress,
        results: job.results,
        error: job.error,
      }));

      if (job.status !== 'running') {
        stopPolling();
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to get analysis status',
      }));
      stopPolling();
    }
  }, [stopPolling]);

  const startAnalysis = useCallback(async (promptId: string, caseIds: number[]) => {
    stopPolling();

    setState({
      status: 'running',
      progress: { current: 0, total: caseIds.length, currentCaseId: null },
      results: [],
      error: null,
      jobId: null,
    });

    try {
      const { jobId } = await api.startAnalysis({ promptId, caseIds });
      setState((prev) => ({ ...prev, jobId }));

      // Start polling
      pollIntervalRef.current = setInterval(() => {
        pollStatus(jobId);
      }, POLL_INTERVAL);

      // Initial poll
      pollStatus(jobId);
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to start analysis',
      }));
    }
  }, [stopPolling, pollStatus]);

  const cancelAnalysis = useCallback(async () => {
    stopPolling();

    if (state.jobId) {
      try {
        await api.cancelAnalysis(state.jobId);
      } catch {
        // Ignore errors on cancel
      }
    }

    setState((prev) => ({
      ...prev,
      status: 'idle',
    }));
  }, [state.jobId, stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setState({
      status: 'idle',
      progress: { current: 0, total: 0, currentCaseId: null },
      results: [],
      error: null,
      jobId: null,
    });
  }, [stopPolling]);

  // Resume polling if initialJobId is provided on mount
  useEffect(() => {
    if (initialJobId && !pollIntervalRef.current) {
      // Start polling for the existing job
      pollIntervalRef.current = setInterval(() => {
        pollStatus(initialJobId);
      }, POLL_INTERVAL);
      // Initial poll
      pollStatus(initialJobId);
    }
  }, [initialJobId, pollStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  return {
    ...state,
    startAnalysis,
    cancelAnalysis,
    reset,
  };
}
