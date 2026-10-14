import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import type { ComparePass3Result, Report } from '@/types';
import { formatCost, formatInt, formatLatency } from './format';

interface RunDetailsProps {
  report: Report | null;
  loading: boolean;
  error: string | null;
  labels: string[];
  compareA: string;
  compareB: string;
  onCompareA: (v: string) => void;
  onCompareB: (v: string) => void;
  compare: ComparePass3Result | undefined;
  compareLoading: boolean;
  compareError: string | null;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-700">{children}</h4>;
}

/**
 * The machinery behind the categories: spend, the label guard, and how stable
 * two inductions of the same readings are. Counts come from the report only,
 * and only when the report says the pass is complete.
 */
export function RunDetails({
  report,
  loading,
  error,
  labels,
  compareA,
  compareB,
  onCompareA,
  onCompareB,
  compare,
  compareLoading,
  compareError,
}: RunDetailsProps) {
  if (loading) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) return <p className="text-sm text-muted-foreground">{error}</p>;
  if (!report) return <p className="text-sm text-muted-foreground">Nothing has run in this run yet.</p>;

  const states = report.pass1.states;
  const flagged = report.pass2.flagged ?? [];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionTitle>Pass 1 · identify</SectionTitle>
        {report.pass1.complete && states ? (
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            {Object.entries(states).map(([state, n]) => (
              <span key={state}>
                <span className="font-medium tabular-nums">{formatInt(n)}</span>{' '}
                <span className="text-muted-foreground">{state.toLowerCase().replace(/_/g, ' ')}</span>
              </span>
            ))}
            <span>
              <span className="font-medium tabular-nums">
                {formatInt(report.pass1.distinctPayments)}
              </span>{' '}
              <span className="text-muted-foreground">distinct payments</span>
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Counts appear when the pass completes.</p>
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle>Pass 2 · label guard</SectionTitle>
        {!report.pass2.complete ? (
          <p className="text-sm text-muted-foreground">Counts appear when the pass completes.</p>
        ) : flagged.length === 0 ? (
          <p className="text-sm text-muted-foreground">No readings were flagged.</p>
        ) : (
          <ul className="space-y-0.5">
            {flagged.map((f) => (
              <li key={f.threadId} className="flex items-baseline gap-2 text-xs">
                <span className="font-mono text-muted-foreground">{f.threadId}</span>
                <span className="text-gray-700">{f.flags.join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {labels.length >= 2 && (
        <section className="space-y-2">
          <SectionTitle>Compare inductions</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-28">
              <Select className="h-9" value={compareA} onChange={(e) => onCompareA(e.target.value)}>
                <option value="">label a</option>
                {labels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-28">
              <Select className="h-9" value={compareB} onChange={(e) => onCompareB(e.target.value)}>
                <option value="">label b</option>
                {labels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
            {compareLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          {compareError && <p className="text-xs text-muted-foreground">{compareError}</p>}
          {compare && (
            <div className="space-y-2">
              <p className="text-sm">
                <span className="text-muted-foreground">Assignment agreement </span>
                <span className="font-medium tabular-nums">
                  {(compare.assignmentAgreement * 100).toFixed(1)}%
                </span>
              </p>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-9 px-3">{compareA || 'a'}</TableHead>
                      <TableHead className="h-9 px-3">{compareB || 'b'}</TableHead>
                      <TableHead className="h-9 px-3 text-right">Jaccard</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {compare.pairs.map((p, i) => (
                      <TableRow key={`${p.a}-${p.b}-${i}`}>
                        <TableCell className="p-3 text-xs">{p.a}</TableCell>
                        <TableCell className="p-3 text-xs">{p.b}</TableCell>
                        <TableCell className="p-3 text-right text-xs tabular-nums">
                          {p.jaccard.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground">
                Unmatched in {compareA || 'a'}:{' '}
                {compare.unmatchedA.length > 0 ? compare.unmatchedA.join(', ') : 'none'} · unmatched
                in {compareB || 'b'}:{' '}
                {compare.unmatchedB.length > 0 ? compare.unmatchedB.join(', ') : 'none'}
              </p>
            </div>
          )}
        </section>
      )}

      <section className="space-y-2">
        <SectionTitle>Usage per stage</SectionTitle>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-9 px-3">Stage</TableHead>
                <TableHead className="h-9 px-3 text-right">Calls</TableHead>
                <TableHead className="h-9 px-3 text-right">Tokens in</TableHead>
                <TableHead className="h-9 px-3 text-right">Tokens out</TableHead>
                <TableHead className="h-9 px-3 text-right">Cost</TableHead>
                <TableHead className="h-9 px-3 text-right">p50</TableHead>
                <TableHead className="h-9 px-3 text-right">Max</TableHead>
                <TableHead className="h-9 px-3 text-right">Errors</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.usage.perStage.map((u) => (
                <TableRow key={u.stage}>
                  <TableCell className="p-3 text-xs font-medium">{u.stage}</TableCell>
                  <TableCell className="p-3 text-right text-xs tabular-nums">
                    {formatInt(u.calls)}
                  </TableCell>
                  <TableCell className="p-3 text-right text-xs tabular-nums">
                    {formatInt(u.inputTokens)}
                  </TableCell>
                  <TableCell className="p-3 text-right text-xs tabular-nums">
                    {formatInt(u.outputTokens)}
                  </TableCell>
                  <TableCell className="p-3 text-right text-xs tabular-nums">
                    {formatCost(u.costUsd)}
                  </TableCell>
                  <TableCell className="p-3 text-right text-xs tabular-nums">
                    {formatLatency(u.latencyP50Ms)}
                  </TableCell>
                  <TableCell className="p-3 text-right text-xs tabular-nums">
                    {formatLatency(u.latencyMaxMs)}
                  </TableCell>
                  <TableCell className="p-3 text-right text-xs tabular-nums">
                    {formatInt(u.errors)}
                  </TableCell>
                </TableRow>
              ))}
              {report.usage.perStage.length === 0 && (
                <TableRow>
                  <TableCell className="p-3 text-xs text-muted-foreground" colSpan={8}>
                    Nothing has run in this run yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
