import { useState, useMemo } from 'react';
import type { DatasetCase } from '@/types';

export type LabelFilter = 'all' | 'credit' | 'escalate' | 'undecided' | 'unlabeled';
export type RiskFilter = 'all' | 'green' | 'amber' | 'red';
export type HardGateFilter = 'all' | 'hit' | 'clear';
export type SortOption = 'default' | 'risk' | 'rubric';

export interface CaseFilterState {
  labelFilter: LabelFilter;
  setLabelFilter: (v: LabelFilter) => void;
  riskFilter: RiskFilter;
  setRiskFilter: (v: RiskFilter) => void;
  hardGateFilter: HardGateFilter;
  setHardGateFilter: (v: HardGateFilter) => void;
  sortOption: SortOption;
  setSortOption: (v: SortOption) => void;
  filteredCases: DatasetCase[];
  totalCount: number;
  filteredCount: number;
}

const RISK_ORDER: Record<string, number> = { red: 0, amber: 1, green: 2 };

export function useCaseFilters(cases: DatasetCase[]): CaseFilterState {
  const [labelFilter, setLabelFilter] = useState<LabelFilter>('all');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [hardGateFilter, setHardGateFilter] = useState<HardGateFilter>('all');
  const [sortOption, setSortOption] = useState<SortOption>('default');

  const filteredCases = useMemo(() => {
    let result = cases;

    if (labelFilter !== 'all') {
      result = result.filter((c) =>
        labelFilter === 'unlabeled' ? c.label === null : c.label === labelFilter,
      );
    }

    if (riskFilter !== 'all') {
      result = result.filter(
        (c) => c.pipelineRun?.disputeProfile.risk_level === riskFilter,
      );
    }

    if (hardGateFilter !== 'all') {
      result = result.filter((c) => {
        if (!c.pipelineRun) return false;
        const hit = c.pipelineRun.hardGateTriggered != null;
        return hardGateFilter === 'hit' ? hit : !hit;
      });
    }

    if (sortOption === 'risk') {
      result = [...result].sort((a, b) => {
        const aRisk = RISK_ORDER[a.pipelineRun?.disputeProfile.risk_level ?? ''] ?? 3;
        const bRisk = RISK_ORDER[b.pipelineRun?.disputeProfile.risk_level ?? ''] ?? 3;
        return aRisk - bRisk || a.caseId - b.caseId;
      });
    } else if (sortOption === 'rubric') {
      result = [...result].sort((a, b) => {
        const aScore = a.pipelineRun?.disputeProfile.rubric_score ?? -1;
        const bScore = b.pipelineRun?.disputeProfile.rubric_score ?? -1;
        return bScore - aScore || a.caseId - b.caseId;
      });
    }

    return result;
  }, [cases, labelFilter, riskFilter, hardGateFilter, sortOption]);

  return {
    labelFilter, setLabelFilter,
    riskFilter, setRiskFilter,
    hardGateFilter, setHardGateFilter,
    sortOption, setSortOption,
    filteredCases,
    totalCount: cases.length,
    filteredCount: filteredCases.length,
  };
}
