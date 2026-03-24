import type { SavedAnalysis, AnalysisResult } from '@/types';

const STORAGE_KEY = 'timeline-analyzer-saved';
const MAX_SAVED = 10;

function generateId(): string {
  return crypto.randomUUID();
}

export function getSavedAnalyses(): SavedAnalysis[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    return JSON.parse(data) as SavedAnalysis[];
  } catch {
    return [];
  }
}

export function saveAnalysis(
  analysis: Omit<SavedAnalysis, 'id' | 'savedAt'>
): SavedAnalysis {
  const saved = getSavedAnalyses();

  const newAnalysis: SavedAnalysis = {
    ...analysis,
    id: generateId(),
    savedAt: new Date().toISOString(),
  };

  // Add to beginning, limit to MAX_SAVED
  const updated = [newAnalysis, ...saved].slice(0, MAX_SAVED);

  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));

  return newAnalysis;
}

export function deleteSavedAnalysis(id: string): void {
  const saved = getSavedAnalyses();
  const updated = saved.filter((a) => a.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function loadSavedAnalysis(id: string): SavedAnalysis | null {
  const saved = getSavedAnalyses();
  return saved.find((a) => a.id === id) ?? null;
}

export function generateAnalysisName(): string {
  const now = new Date();
  return `Analysis - ${now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })} ${now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

export function computeAnalysisCounts(results: AnalysisResult[]): {
  successCount: number;
  errorCount: number;
} {
  const successCount = results.filter((r) => !r.error).length;
  const errorCount = results.filter((r) => r.error).length;
  return { successCount, errorCount };
}
