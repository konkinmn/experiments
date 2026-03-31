import { useState, useMemo } from 'react';
import type { DatasetCase } from '@/types';

export type LabelFilter = 'all' | 'credit' | 'escalate' | 'undecided' | 'unlabeled';
export type RiskFilter = 'all' | 'green' | 'amber' | 'red';
export type HardGateFilter = 'all' | 'hit' | 'clear';
export type SortOption = 'default' | 'risk' | 'rubric' | 'amount' | 'account_age';
export type AgreementFilter = 'all' | 'agree' | 'disagree' | 'no-label';
export type FilterMode = 'dataset' | 'run';

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
  mode: FilterMode;
}

const RISK_ORDER: Record<string, number> = { red: 0, amber: 1, green: 2 };

export function useCaseFilters(cases: DatasetCase[], mode: FilterMode = 'run'): CaseFilterState {
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

    // Risk and hard gate filters only apply in run mode (pipeline data required)
    if (mode === 'run') {
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

    }

    if (sortOption === 'default') {
      result = [...result].sort((a, b) => {
        const aDate = String(a.rawSignals?.case_created_at ?? '');
        const bDate = String(b.rawSignals?.case_created_at ?? '');
        return bDate.localeCompare(aDate) || b.caseId - a.caseId;
      });
    } else if (sortOption === 'risk') {
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
    } else if (sortOption === 'amount') {
      result = [...result].sort((a, b) => {
        const aAmt = a.rawSignals?.total_amount ?? a.pipelineRun?.rawSignals?.total_amount ?? 0;
        const bAmt = b.rawSignals?.total_amount ?? b.pipelineRun?.rawSignals?.total_amount ?? 0;
        return bAmt - aAmt || a.caseId - b.caseId;
      });
    } else if (sortOption === 'account_age') {
      result = [...result].sort((a, b) => {
        const aAge = a.rawSignals?.account_age_days ?? a.pipelineRun?.rawSignals?.account_age_days ?? 0;
        const bAge = b.rawSignals?.account_age_days ?? b.pipelineRun?.rawSignals?.account_age_days ?? 0;
        return aAge - bAge || a.caseId - b.caseId;
      });
    }

    return result;
  }, [cases, labelFilter, riskFilter, hardGateFilter, sortOption, mode]);

  return {
    labelFilter, setLabelFilter,
    riskFilter, setRiskFilter,
    hardGateFilter, setHardGateFilter,
    sortOption, setSortOption,
    filteredCases,
    totalCount: cases.length,
    filteredCount: filteredCases.length,
    mode,
  };
}
