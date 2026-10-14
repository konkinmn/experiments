import { Loader2, Play, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import type { PassKind, Plan } from '@/types';
import { formatCostPrecise, formatInt } from './format';

interface PlanDialogProps {
  open: boolean;
  pass: PassKind | null;
  plan: Plan | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRun: () => void;
  starting: boolean;
  startError: string | null;
  jobRunning: boolean;
}

const PASS_TITLES: Record<PassKind, string> = {
  measure: 'Measure',
  pass1: 'Pass 1 · identify',
  pass2: 'Pass 2 · read',
  pass3: 'Pass 3 · induce',
  all: 'Run pipeline · all three passes',
};

/** The estimate method is fixed and stated verbatim so it is never mistaken for the bill. */
const ESTIMATE_SENTENCE =
  'Estimates use chars ÷ 4 and list prices; the real cost comes back from the proxy after the run.';

export function PlanDialog({
  open,
  pass,
  plan,
  loading,
  error,
  onClose,
  onRun,
  starting,
  startError,
  jobRunning,
}: PlanDialogProps) {
  const blockers = plan?.blockers ?? [];
  const runDisabled = !plan || blockers.length > 0 || jobRunning || starting;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{pass ? PASS_TITLES[pass] : 'Plan'}</DialogTitle>
          <DialogDescription>{ESTIMATE_SENTENCE}</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {plan && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <span>
                <span className="text-muted-foreground">Threads selected </span>
                <span className="font-semibold tabular-nums">{formatInt(plan.threadsSelected)}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Still to do </span>
                <span className="font-semibold tabular-nums">{formatInt(plan.threadsToDo)}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Est. input cost </span>
                <span className="font-semibold tabular-nums">
                  {formatCostPrecise(plan.estInputCostUsd)}
                </span>
              </span>
            </div>

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9 px-3">Stage</TableHead>
                    <TableHead className="h-9 px-3">Model</TableHead>
                    <TableHead className="h-9 px-3 text-right">Calls</TableHead>
                    <TableHead className="h-9 px-3 text-right">Chars sum</TableHead>
                    <TableHead className="h-9 px-3 text-right">p50</TableHead>
                    <TableHead className="h-9 px-3 text-right">Max</TableHead>
                    <TableHead className="h-9 px-3 text-right">Est. in tok</TableHead>
                    <TableHead className="h-9 px-3 text-right">Est. out tok</TableHead>
                    <TableHead className="h-9 px-3 text-right">Est. cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.rows.map((r, i) => (
                    <TableRow key={`${r.stage}-${i}`}>
                      <TableCell className="p-3 font-medium">{r.stage}</TableCell>
                      <TableCell className="p-3 font-mono text-xs">{r.model}</TableCell>
                      <TableCell className="p-3 text-right tabular-nums">{formatInt(r.calls)}</TableCell>
                      <TableCell className="p-3 text-right tabular-nums">{formatInt(r.charsSum)}</TableCell>
                      <TableCell className="p-3 text-right tabular-nums">{formatInt(r.charsP50)}</TableCell>
                      <TableCell className="p-3 text-right tabular-nums">{formatInt(r.charsMax)}</TableCell>
                      <TableCell className="p-3 text-right tabular-nums">
                        {formatInt(r.estInputTokens)}
                      </TableCell>
                      <TableCell className="p-3 text-right tabular-nums">
                        {formatInt(r.estOutputTokens)}
                      </TableCell>
                      <TableCell className="p-3 text-right tabular-nums">
                        {formatCostPrecise(r.estInputCostUsd)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {plan.rows.length === 0 && (
                    <TableRow>
                      <TableCell className="p-3 text-muted-foreground" colSpan={9}>
                        No stages in this plan.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {plan.notes.length > 0 && (
              <div className="space-y-0.5 text-sm text-gray-700">
                {plan.notes.map((n, i) => (
                  <p key={i}>{n}</p>
                ))}
              </div>
            )}

            {blockers.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                  <AlertTriangle className="h-4 w-4" />
                  Blockers — nothing will run
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-900">
                  {blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}

            {jobRunning && blockers.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Another job is running — wait for it to finish before starting this pass.
              </p>
            )}

            {startError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                {startError}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onRun} disabled={runDisabled}>
            {starting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
