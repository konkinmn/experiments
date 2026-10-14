import { useState, type ReactNode } from 'react';
import { Boxes, ChevronDown, ChevronRight, Loader2, Play, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { CreateSnapshotRequest, RunSummary, SnapshotSummary } from '@/types';
import { NewRunDialog, NewSnapshotDialog } from './AdvancedDialogs';
import { formatCost, formatInt, formatTime } from './format';

interface AdvancedPanelProps {
  snapshots: SnapshotSummary[];
  snapshotName: string | null;
  onSelectSnapshot: (name: string) => void;
  snapshot: SnapshotSummary | null;
  onCreateSnapshot: (body: CreateSnapshotRequest) => void;
  creatingSnapshot: boolean;
  onBuildBundles: () => void;
  building: boolean;
  runs: RunSummary[];
  runName: string | null;
  onSelectRun: (run: string) => void;
  onCreateRun: (run: string) => void;
  creatingRun: boolean;
  run: RunSummary | null;
  labels: string[];
  readLabel: string;
  onReadLabel: (v: string) => void;
  newLabel: string;
  onNewLabel: (v: string) => void;
  onRunPipeline: () => void;
  runPipelinePlanning: boolean;
  error: string | null;
  /** The four per-pass cards, tucked away behind a disclosure. */
  passStrip: ReactNode;
  /** The live job panel — rendered only while a job exists. */
  job: ReactNode | null;
  runDetails: ReactNode;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-900 hover:bg-gray-50"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {title}
      </button>
      {open && <div className="border-t border-gray-200 p-3">{children}</div>}
    </div>
  );
}

/**
 * Everything that costs money or changes what the page is reading. Collapsed by
 * default: this is a page for reading results, and running the pipeline is rare.
 */
export function AdvancedPanel({
  snapshots,
  snapshotName,
  onSelectSnapshot,
  snapshot,
  onCreateSnapshot,
  creatingSnapshot,
  onBuildBundles,
  building,
  runs,
  runName,
  onSelectRun,
  onCreateRun,
  creatingRun,
  run,
  labels,
  readLabel,
  onReadLabel,
  newLabel,
  onNewLabel,
  onRunPipeline,
  runPipelinePlanning,
  error,
  passStrip,
  job,
  runDetails,
}: AdvancedPanelProps) {
  const [snapshotDialog, setSnapshotDialog] = useState(false);
  const [runDialog, setRunDialog] = useState(false);

  const counts = snapshot?.counts;
  const usage = run?.usage;

  return (
    <div className="space-y-4 rounded-lg border bg-white p-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <Field label="Population snapshot">
          <div className="flex items-center gap-2">
            <Select
              className="h-9"
              value={snapshotName ?? ''}
              onChange={(e) => onSelectSnapshot(e.target.value)}
              disabled={snapshots.length === 0}
            >
              {snapshots.length === 0 && <option value="">No snapshots yet</option>}
              {snapshots.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} · {s.dateFrom} → {s.dateTo}
                </option>
              ))}
            </Select>
            <Button variant="outline" size="sm" onClick={() => setSnapshotDialog(true)}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </Field>

        <Field label="Run">
          <div className="flex items-center gap-2">
            <Select
              className="h-9"
              value={runName ?? ''}
              onChange={(e) => onSelectRun(e.target.value)}
              disabled={runs.length === 0}
            >
              {runs.length === 0 && <option value="">No runs yet</option>}
              {runs.map((r) => (
                <option key={r.run} value={r.run}>
                  {r.run} · {formatTime(r.createdAt)}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRunDialog(true)}
              disabled={!snapshotName}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </Field>

        <Field label="Category set (pass-3 label)">
          {labels.length > 0 ? (
            <Select
              className="h-9"
              value={readLabel}
              onChange={(e) => onReadLabel(e.target.value)}
            >
              {labels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          ) : (
            <p className="pt-2 text-xs text-muted-foreground">No induction in this run yet.</p>
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {counts && (
          <span className="tabular-nums">
            {formatInt(counts.totalThreads)} threads · {formatInt(counts.totalDialogues)} dialogues ·{' '}
            {formatInt(counts.totalCustomers)} customers · seed {snapshot?.seed}
          </span>
        )}
        {snapshot && (
          <span>
            bundles {snapshot.bundlesBuilt ? `built ${formatTime(snapshot.bundlesBuiltAt)}` : 'not built'}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onBuildBundles}
          disabled={building || !snapshot}
        >
          {building ? (
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
          ) : (
            <Boxes className="mr-1.5 h-3 w-3" />
          )}
          {snapshot?.bundlesBuilt ? 'Rebuild bundles' : 'Build bundles'}
        </Button>
        {usage && (
          <span className="tabular-nums">
            run spend {formatInt(usage.calls)} calls · {formatCost(usage.costUsd)} ·{' '}
            {formatInt(usage.errors)} errors
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t border-gray-200 pt-4">
        <div className="w-40">
          <Field label="New label for this run">
            <Input
              className="h-9"
              value={newLabel}
              onChange={(e) => onNewLabel(e.target.value)}
              placeholder="a"
            />
          </Field>
        </div>
        <Button onClick={onRunPipeline} disabled={!snapshotName || !runName || runPipelinePlanning}>
          {runPipelinePlanning ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          Run pipeline
        </Button>
        <p className="text-xs text-muted-foreground">
          All three passes over the whole snapshot. The plan shows the cost before anything runs.
        </p>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <Disclosure title="Run a single pass">{passStrip}</Disclosure>

      {job}

      <Disclosure title="Run details">{runDetails}</Disclosure>

      <NewSnapshotDialog
        open={snapshotDialog}
        onOpenChange={setSnapshotDialog}
        onCreate={onCreateSnapshot}
        creating={creatingSnapshot}
      />
      <NewRunDialog
        open={runDialog}
        onOpenChange={setRunDialog}
        onCreate={onCreateRun}
        creating={creatingRun}
      />
    </div>
  );
}
