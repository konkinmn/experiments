import { useState, useMemo, ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileJson,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  SearchX,
  ShieldAlert,
  ServerCrash,
  Clock,
  Bookmark,
  ExternalLink,
  Check,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { exportToJson, exportToExcel } from '@/lib/export';
import type { AnalysisResult } from '@/types';

type ErrorCategory = 'not_found' | 'auth' | 'server' | 'timeout' | 'unknown';

interface CategorizedError {
  category: ErrorCategory;
  title: string;
  description: string;
}

function categorizeError(error: string): CategorizedError {
  if (error.includes('LLM API error')) {
    return {
      category: 'unknown',
      title: 'LLM analysis failed',
      description: 'The AI service could not process this request',
    };
  }
  if (error.includes('404')) {
    return {
      category: 'not_found',
      title: 'Case not found',
      description: 'This case ID does not exist in the system',
    };
  }
  if (error.includes('401') || error.includes('403')) {
    return {
      category: 'auth',
      title: 'Authentication failed',
      description: 'API access denied - check configuration',
    };
  }
  if (error.includes('500') || error.includes('502') || error.includes('503')) {
    return {
      category: 'server',
      title: 'Server error',
      description: 'The case API is experiencing issues - try again later',
    };
  }
  if (error.toLowerCase().includes('timeout')) {
    return {
      category: 'timeout',
      title: 'Request timed out',
      description: 'The request took too long - try again',
    };
  }
  return {
    category: 'unknown',
    title: 'Analysis failed',
    description: error,
  };
}

const errorStyles: Record<
  ErrorCategory,
  { icon: typeof AlertCircle; colorClass: string }
> = {
  not_found: { icon: SearchX, colorClass: 'text-gray-500' },
  auth: { icon: ShieldAlert, colorClass: 'text-yellow-600' },
  server: { icon: ServerCrash, colorClass: 'text-red-600' },
  timeout: { icon: Clock, colorClass: 'text-orange-500' },
  unknown: { icon: AlertCircle, colorClass: 'text-red-600' },
};

interface ColumnDef {
  key: string;
  label: string;
}

interface SortConfig {
  key: string;
  direction: 'asc' | 'desc';
}

// Helper: Check if value is a URL
function isUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^https?:\/\//.test(value);
}

// Helper: Check if value is an ISO date
function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}/.test(value);
}

// Helper: Resolve dot-notation path against an object
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc != null && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

// Helper: Check if value is a plain object (not array, not null)
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Helper: Format column key to readable label
function formatColumnLabel(key: string): string {
  return key
    .replace(/\./g, ' > ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Helper: Render cell value based on type
function renderCell(value: unknown): ReactNode {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>;
  }

  // URL - clickable link
  if (isUrl(value)) {
    return (
      <a
        href={String(value)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-blue-600 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="h-3 w-3" />
        Open
      </a>
    );
  }

  // Date - formatted
  if (isIsoDate(value)) {
    return new Date(String(value)).toLocaleDateString();
  }

  // Boolean - icon
  if (typeof value === 'boolean') {
    return value ? (
      <Check className="h-4 w-4 text-green-600" />
    ) : (
      <X className="h-4 w-4 text-gray-400" />
    );
  }

  // Object/Array - show indicator
  if (typeof value === 'object') {
    return <span className="text-muted-foreground text-xs">[object]</span>;
  }

  // String/Number - truncate if long
  const str = String(value);
  return str.length > 50 ? str.slice(0, 47) + '...' : str;
}

/**
 * Extracts the first top-level JSON object from a string that may contain
 * trailing text after the closing brace. Uses brace counting that respects
 * JSON string literals and escape sequences.
 */
function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.substring(start, i + 1));
      }
    }
  }

  return null;
}

function normalizeResults(results: AnalysisResult[]): AnalysisResult[] {
  return results.map((r) => {
    if (typeof r.analysis !== 'string') return r;
    try {
      return { ...r, analysis: JSON.parse(r.analysis) };
    } catch {
      /* not plain JSON */
    }
    try {
      const obj = extractJsonObject(r.analysis);
      if (obj !== null) return { ...r, analysis: obj };
    } catch {
      /* extraction failed */
    }
    return r;
  });
}

// Extract unique columns from all analysis results, flattening nested objects
function extractColumns(results: AnalysisResult[]): ColumnDef[] {
  const keys = new Set<string>();

  results.forEach((r) => {
    if (r.analysis && typeof r.analysis === 'object' && !Array.isArray(r.analysis)) {
      const analysis = r.analysis as Record<string, unknown>;
      for (const k of Object.keys(analysis)) {
        const val = analysis[k];
        if (isPlainObject(val)) {
          for (const subKey of Object.keys(val)) {
            keys.add(`${k}.${subKey}`);
          }
        } else {
          keys.add(k);
        }
      }
    }
  });

  return Array.from(keys).map((key) => ({
    key,
    label: formatColumnLabel(key),
  }));
}

// Sort results by a column
function sortResults(
  results: AnalysisResult[],
  sortConfig: SortConfig | null
): AnalysisResult[] {
  if (!sortConfig) return results;

  return [...results].sort((a, b) => {
    const aVal = a.analysis ? getNestedValue(a.analysis as Record<string, unknown>, sortConfig.key) : undefined;
    const bVal = b.analysis ? getNestedValue(b.analysis as Record<string, unknown>, sortConfig.key) : undefined;

    // Handle nulls - push to end
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    // Compare using localeCompare with numeric option
    const cmp = String(aVal).localeCompare(String(bVal), undefined, {
      numeric: true,
    });
    return sortConfig.direction === 'asc' ? cmp : -cmp;
  });
}

interface SortableHeaderProps {
  column: ColumnDef;
  sortConfig: SortConfig | null;
  onSort: (key: string) => void;
}

function SortableHeader({ column, sortConfig, onSort }: SortableHeaderProps) {
  const isActive = sortConfig?.key === column.key;
  const direction = isActive ? sortConfig.direction : null;

  return (
    <TableHead
      className="cursor-pointer select-none hover:bg-muted/50"
      onClick={() => onSort(column.key)}
    >
      <div className="flex items-center gap-1">
        {column.label}
        {direction === 'asc' && <ChevronUp className="h-3 w-3" />}
        {direction === 'desc' && <ChevronDown className="h-3 w-3" />}
      </div>
    </TableHead>
  );
}

interface AnalysisResultsProps {
  results: AnalysisResult[];
  onReset: () => void;
  onSave?: () => void;
  isSaved?: boolean;
}

export function AnalysisResults({
  results,
  onReset,
  onSave,
  isSaved,
}: AnalysisResultsProps) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);

  const toggleRow = (caseId: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(caseId)) {
        next.delete(caseId);
      } else {
        next.add(caseId);
      }
      return next;
    });
  };

  const handleSort = (key: string) => {
    setSortConfig((prev) => {
      if (prev?.key === key) {
        // Toggle direction or clear
        if (prev.direction === 'asc') {
          return { key, direction: 'desc' };
        }
        return null; // Clear sort
      }
      return { key, direction: 'asc' };
    });
  };

  // Normalize string-typed analysis results into parsed objects
  const normalized = useMemo(() => normalizeResults(results), [results]);

  // Extract columns from all results
  const columns = useMemo(() => extractColumns(normalized), [normalized]);

  // Sort results
  const sortedResults = useMemo(
    () => sortResults(normalized, sortConfig),
    [normalized, sortConfig]
  );

  const successCount = normalized.filter((r) => !r.error).length;
  const errorCount = normalized.filter((r) => r.error).length;

  // Total columns: expand icon + case ID + status + dynamic columns
  const totalColumns = 3 + columns.length;

  const handleExportJson = () => {
    exportToJson(normalized, 'timeline-analysis');
  };

  const handleExportExcel = () => {
    exportToExcel(normalized, 'timeline-analysis');
  };

  return (
    <div className="w-full space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1 text-green-600">
            <CheckCircle2 className="h-4 w-4" />
            {successCount} successful
          </span>
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-red-600">
              <AlertCircle className="h-4 w-4" />
              {errorCount} failed
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onSave && (
            <Button
              variant="outline"
              size="sm"
              onClick={onSave}
              disabled={isSaved}
            >
              <Bookmark className="mr-2 h-4 w-4" />
              {isSaved ? 'Saved' : 'Save'}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleExportJson}>
            <FileJson className="mr-2 h-4 w-4" />
            JSON
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportExcel}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Excel
          </Button>
        </div>
      </div>

      {/* Results table - full width with horizontal scroll */}
      <div className="w-full overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Case ID</TableHead>
              <TableHead>Status</TableHead>
              {columns.map((col) => (
                <SortableHeader
                  key={col.key}
                  column={col}
                  sortConfig={sortConfig}
                  onSort={handleSort}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedResults.map((result) => {
              const analysis = result.analysis as Record<string, unknown> | null;
              return (
                <>
                  <TableRow
                    key={result.caseId}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => toggleRow(result.caseId)}
                  >
                    <TableCell className="w-8">
                      {expandedRows.has(result.caseId) ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{result.caseId}</TableCell>
                    <TableCell>
                      {result.error ? (
                        (() => {
                          const { category, title } = categorizeError(
                            result.error
                          );
                          const { icon: Icon, colorClass } =
                            errorStyles[category];
                          return (
                            <span
                              className={`flex items-center gap-1 ${colorClass}`}
                            >
                              <Icon className="h-4 w-4" />
                              {title}
                            </span>
                          );
                        })()
                      ) : (
                        <span className="flex items-center gap-1 text-green-600">
                          <CheckCircle2 className="h-4 w-4" />
                          Success
                        </span>
                      )}
                    </TableCell>
                    {columns.map((col) => (
                      <TableCell key={col.key} className="max-w-[200px]">
                        {result.error ? (
                          col.key === columns[0]?.key ? (
                            <span className="text-muted-foreground text-xs">
                              {categorizeError(result.error).description}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )
                        ) : (
                          renderCell(analysis ? getNestedValue(analysis, col.key) : undefined)
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                  {expandedRows.has(result.caseId) && (
                    <TableRow key={`${result.caseId}-expanded`}>
                      <TableCell colSpan={totalColumns} className="bg-muted/30 p-4">
                        {result.error ? (
                          <div className="space-y-2">
                            <p className="text-sm text-muted-foreground">
                              {categorizeError(result.error).description}
                            </p>
                            <details className="text-xs">
                              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                                Technical details
                              </summary>
                              <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-muted p-3">
                                {result.error}
                              </pre>
                            </details>
                          </div>
                        ) : (
                          <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                            {JSON.stringify(result.analysis, null, 2)}
                          </pre>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Actions */}
      <div className="flex justify-end">
        <Button onClick={onReset}>Run Another Analysis</Button>
      </div>
    </div>
  );
}
