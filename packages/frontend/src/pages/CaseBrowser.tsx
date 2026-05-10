import { useState, useMemo, useCallback } from 'react';
import { Download, X } from 'lucide-react';
import { api } from '@/lib/api';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Pagination } from '@/components/ui/pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CaseBrowserFilters,
  CaseBrowserTable,
  CaseDetailDrawer,
} from '@/components/case-browser';
import type { CaseBrowserFiltersState } from '@/components/case-browser/CaseBrowserFilters';
import { useCaseBrowserList, useBulkExportCaseBrowser } from '@/hooks/useCaseBrowser';
import type {
  CaseBrowserListParams,
  CaseBrowserItem,
  CaseBrowserSortField,
} from '@/types';

interface DateRange {
  startDate: Date;
  endDate: Date;
}

function formatDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const initialFilters: CaseBrowserFiltersState = {
  search: '',
  status: null,
  outcome: null,
  decision: null,
  riskLevel: null,
  hasAssessment: null,
  trigger: null,
};

export function CaseBrowser() {
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    return { startDate, endDate };
  });

  const [filters, setFilters] = useState<CaseBrowserFiltersState>(initialFilters);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [sortBy, setSortBy] = useState<CaseBrowserSortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const startDateStr = formatDateString(dateRange.startDate);
  const endDateStr = formatDateString(dateRange.endDate);

  const listParams: CaseBrowserListParams = useMemo(
    () => ({
      startDate: startDateStr,
      endDate: endDateStr,
      page,
      pageSize,
      search: filters.search || undefined,
      status: filters.status || undefined,
      outcome: filters.outcome || undefined,
      decision: filters.decision || undefined,
      riskLevel: filters.riskLevel || undefined,
      hasAssessment: filters.hasAssessment || undefined,
      trigger: filters.trigger || undefined,
      sortBy,
      sortOrder,
    }),
    [startDateStr, endDateStr, page, pageSize, filters, sortBy, sortOrder]
  );

  const { data: listResponse, isLoading, isFetching } = useCaseBrowserList(listParams);
  const tableLoading = isLoading || isFetching;
  const bulkExport = useBulkExportCaseBrowser();
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectAllNotice, setSelectAllNotice] = useState<{ added: number; total: number; capped: boolean; limit: number } | null>(null);

  const handleFiltersChange = (next: CaseBrowserFiltersState) => {
    setFilters(next);
    setPage(1);
    setSelectAllNotice(null);
  };

  const handleDateRangeChange = (next: DateRange) => {
    setDateRange(next);
    setPage(1);
    setSelectAllNotice(null);
  };

  const handleSortChange = (field: CaseBrowserSortField) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
    setPage(1);
  };

  const handleRowClick = (item: CaseBrowserItem) => {
    setActiveCaseId(item.id);
  };

  const handleToggleSelect = useCallback((id: string) => {
    setSelectAllNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const pageIds = (listResponse?.data ?? []).map((d) => d.id);
      const allSelected = pageIds.length > 0 && pageIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }, [listResponse?.data]);

  const handleBulkExport = async () => {
    const ids = Array.from(selected).map((id) => Number(id)).filter(Number.isFinite);
    if (ids.length === 0) return;
    const blob = await bulkExport.mutateAsync(ids);
    downloadBlob(blob, `case-bundles-${formatDateString(new Date())}.json`);
  };

  const handleSelectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const response = await api.getCaseBrowserIds(listParams);
      const { ids, totalMatching, capped, limit } = response.data;
      setSelected(new Set(ids.map(String)));
      setSelectAllNotice({ added: ids.length, total: totalMatching, capped, limit });
    } finally {
      setSelectingAll(false);
    }
  };

  const handleClearSelection = () => {
    setSelected(new Set());
    setSelectAllNotice(null);
  };

  const pageData = listResponse?.data ?? [];
  const allOnPageSelected = pageData.length > 0 && pageData.every((d) => selected.has(d.id));
  const totalMatching = listResponse?.totalCount ?? 0;
  const showSelectAllOffer =
    allOnPageSelected && selected.size < totalMatching && !selectAllNotice;

  return (
    <div className="flex-1 overflow-auto bg-gray-50 p-6">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Case Browser</h1>
            <p className="text-sm text-muted-foreground">
              Drill-down investigation: filter cases, open one, inspect dialogues + messages + assessment + comments + artifacts.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <DateRangePicker value={dateRange} onChange={handleDateRangeChange} />
            {selected.size > 0 && (
              <span className="text-sm text-muted-foreground">{selected.size} selected</span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={selected.size === 0 || bulkExport.isPending}
              onClick={handleBulkExport}
            >
              <Download className="mr-2 h-4 w-4" />
              {bulkExport.isPending ? 'Exporting…' : `Bulk export (${selected.size})`}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">Cases</h2>
              <Badge variant="gray">{listResponse?.totalCount ?? 0}</Badge>
            </div>
          </div>

          <div className="mb-4">
            <CaseBrowserFilters filters={filters} onChange={handleFiltersChange} />
          </div>

          {(showSelectAllOffer || selectAllNotice || selected.size > 0) && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900">
              {showSelectAllOffer ? (
                <>
                  <span>
                    All <strong>{selected.size}</strong> on this page selected.
                  </span>
                  <button
                    type="button"
                    onClick={handleSelectAllMatching}
                    disabled={selectingAll}
                    className="font-medium text-blue-700 underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    {selectingAll ? 'Selecting…' : `Select all ${totalMatching.toLocaleString()} matching cases`}
                  </button>
                </>
              ) : selectAllNotice ? (
                <span>
                  Selected <strong>{selectAllNotice.added.toLocaleString()}</strong> cases
                  {selectAllNotice.capped && (
                    <>
                      {' '}— capped at {selectAllNotice.limit.toLocaleString()} of{' '}
                      {selectAllNotice.total.toLocaleString()} matching (bulk-export limit).
                    </>
                  )}
                </span>
              ) : (
                <span>
                  <strong>{selected.size}</strong> case{selected.size === 1 ? '' : 's'} selected.
                </span>
              )}
              <button
                type="button"
                onClick={handleClearSelection}
                className="ml-auto inline-flex items-center gap-1 text-blue-700 hover:text-blue-900"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            </div>
          )}

          <CaseBrowserTable
            data={listResponse?.data ?? []}
            loading={tableLoading}
            sortField={sortBy}
            sortOrder={sortOrder}
            onSort={handleSortChange}
            onRowClick={handleRowClick}
            selected={selected}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
          />

          {listResponse && listResponse.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Showing {listResponse.data.length} of {listResponse.totalCount} cases
              </p>
              <Pagination page={page} totalPages={listResponse.totalPages} onPageChange={setPage} />
            </div>
          )}
        </div>

        <CaseDetailDrawer caseId={activeCaseId} onClose={() => setActiveCaseId(null)} />
      </div>
    </div>
  );
}
