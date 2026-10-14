import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CreateSnapshotRequest, Job, PassRequest } from '@/types';

/** Every pass costs money, so the page only ever observes the backend job. */
const JOB_POLL_MS = 2000;

/**
 * The snapshot / run / label the page opens on. A missing endpoint is not an
 * error worth showing — the page falls back to picking the furthest-along run.
 */
export function usePcDefaults() {
  return useQuery({
    queryKey: ['pcDefaults'],
    queryFn: () => api.getPcDefaults(),
    select: (r) => r.data,
    retry: false,
    staleTime: Infinity,
  });
}

export function usePcSnapshots() {
  return useQuery({
    queryKey: ['pcSnapshots'],
    queryFn: () => api.getPcSnapshots(),
    select: (r) => r.data,
  });
}

export function usePcSnapshot(name: string | null) {
  return useQuery({
    queryKey: ['pcSnapshot', name],
    queryFn: () => api.getPcSnapshot(name as string),
    enabled: !!name,
    select: (r) => r.data,
  });
}

export function usePcRuns(name: string | null) {
  return useQuery({
    queryKey: ['pcRuns', name],
    queryFn: () => api.getPcRuns(name as string),
    enabled: !!name,
    select: (r) => r.data,
  });
}

/** All jobs, so the page can find the latest one for the selected snapshot. */
export function usePcJobs() {
  return useQuery({
    queryKey: ['pcJobs'],
    queryFn: () => api.getPcJobs(),
    select: (r) => r.data,
    refetchInterval: (query) =>
      query.state.data?.data.some((j) => j.status === 'running') ? JOB_POLL_MS : false,
  });
}

/**
 * Polls one job while it runs. On the running → finished transition it
 * invalidates runs / threads / report, which are the only surfaces allowed to
 * show counts.
 */
export function usePcJob(jobId: string | null) {
  const queryClient = useQueryClient();
  const previousStatus = useRef<string | null>(null);

  const query = useQuery({
    queryKey: ['pcJob', jobId],
    queryFn: () => api.getPcJob(jobId as string),
    enabled: !!jobId,
    select: (r) => r.data,
    refetchInterval: (q) => (q.state.data?.data.status === 'running' ? JOB_POLL_MS : false),
  });

  const status = query.data?.status ?? null;
  useEffect(() => {
    if (previousStatus.current === 'running' && status !== null && status !== 'running') {
      queryClient.invalidateQueries({ queryKey: ['pcRuns'] });
      queryClient.invalidateQueries({ queryKey: ['pcRunThreads'] });
      queryClient.invalidateQueries({ queryKey: ['pcReport'] });
      queryClient.invalidateQueries({ queryKey: ['pcSnapshot'] });
      queryClient.invalidateQueries({ queryKey: ['pcSnapshots'] });
      queryClient.invalidateQueries({ queryKey: ['pcJobs'] });
    }
    previousStatus.current = status;
  }, [status, queryClient]);

  return query;
}

export function usePcRunThreads(
  name: string | null,
  run: string | null,
  label: string | undefined,
) {
  return useQuery({
    queryKey: ['pcRunThreads', name, run, label ?? null],
    queryFn: () => api.getPcRunThreads(name as string, run as string, label),
    enabled: !!name && !!run,
    select: (r) => r.data,
    placeholderData: keepPreviousData,
  });
}

export function usePcThreadDetail(
  name: string | null,
  run: string | null,
  threadId: string | null,
  label: string | undefined,
) {
  return useQuery({
    queryKey: ['pcThreadDetail', name, run, threadId, label ?? null],
    queryFn: () => api.getPcThreadDetail(name as string, run as string, threadId as string, label),
    enabled: !!name && !!run && !!threadId,
    select: (r) => r.data,
  });
}

/** The report endpoint is the only source of counts — the backend gates it. */
export function usePcReport(
  name: string | null,
  run: string | null,
  label: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['pcReport', name, run, label ?? null],
    queryFn: () => api.getPcReport(name as string, run as string, label),
    enabled: enabled && !!name && !!run,
    select: (r) => r.data,
  });
}

export function usePcComparePass3(
  name: string | null,
  run: string | null,
  a: string | null,
  b: string | null,
) {
  return useQuery({
    queryKey: ['pcComparePass3', name, run, a, b],
    queryFn: () => api.comparePcPass3(name as string, run as string, a as string, b as string),
    enabled: !!name && !!run && !!a && !!b,
    select: (r) => r.data,
  });
}

export function useCreatePcSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSnapshotRequest) => api.createPcSnapshot(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pcSnapshots'] });
    },
  });
}

export function useBuildPcBundles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, force }: { name: string; force?: boolean }) =>
      api.buildPcBundles(name, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pcJobs'] });
    },
  });
}

export function useCreatePcRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, run }: { name: string; run: string }) => api.createPcRun(name, run),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pcRuns'] });
      queryClient.invalidateQueries({ queryKey: ['pcSnapshot'] });
    },
  });
}

/** Plan is the confirmation step: no spend happens until Run is clicked. */
export function usePcPlan() {
  return useMutation({
    mutationFn: ({ name, run, request }: { name: string; run: string; request: PassRequest }) =>
      api.planPcPass(name, run, request),
  });
}

export function useStartPcPass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, run, request }: { name: string; run: string; request: PassRequest }) =>
      api.startPcPass(name, run, request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pcJobs'] });
    },
  });
}

export function useCancelPcJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.cancelPcJob(jobId),
    onSuccess: (_data, jobId) => {
      queryClient.invalidateQueries({ queryKey: ['pcJob', jobId] });
      queryClient.invalidateQueries({ queryKey: ['pcJobs'] });
    },
  });
}

/** Latest job for a snapshot, running or just finished (jobs come newest-first or not). */
export function latestJobForSnapshot(jobs: Job[] | undefined, snapshot: string | null): Job | null {
  if (!jobs || !snapshot) return null;
  const mine = jobs.filter((j) => j.snapshot === snapshot);
  if (mine.length === 0) return null;
  return mine.reduce((latest, j) =>
    new Date(j.startedAt).getTime() > new Date(latest.startedAt).getTime() ? j : latest,
  );
}
