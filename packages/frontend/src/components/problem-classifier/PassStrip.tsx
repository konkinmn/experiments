import type { ReactNode } from 'react';
import { Calculator, Loader2, ScanSearch, BookOpen, Layers } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import type { Job, Pass3Mode, PassKind, PassRequest, RunSummary } from '@/types';
import { progressLabel } from './format';

interface PassStripProps {
  run: RunSummary | null;
  measureJob: Job | null;
  onPlan: (request: PassRequest) => void;
  planningPass: PassKind | null;
  disabled: boolean;
  disabledReason: string | null;
  planError: string | null;
  measureN: string;
  onMeasureN: (v: string) => void;
  pass1N: string;
  onPass1N: (v: string) => void;
  pass1Force: boolean;
  onPass1Force: (v: boolean) => void;
  pass3Mode: Pass3Mode;
  onPass3Mode: (v: Pass3Mode) => void;
  label: string;
  onLabel: (v: string) => void;
}

interface PassCardProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  status: string;
  controls?: ReactNode;
  onPlan: () => void;
  planning: boolean;
  disabled: boolean;
}

function PassCard({
  icon,
  title,
  subtitle,
  status,
  controls,
  onPlan,
  planning,
  disabled,
}: PassCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-white p-4">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{title}</p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <p className="text-sm text-gray-700">{status}</p>
      {controls && <div className="space-y-2">{controls}</div>}
      <Button
        variant="outline"
        size="sm"
        className="mt-auto self-start"
        onClick={onPlan}
        disabled={disabled || planning}
      >
        {planning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calculator className="mr-2 h-4 w-4" />}
        Plan
      </Button>
    </div>
  );
}

export function PassStrip({
  run,
  measureJob,
  onPlan,
  planningPass,
  disabled,
  disabledReason,
  planError,
  measureN,
  onMeasureN,
  pass1N,
  onPass1N,
  pass1Force,
  onPass1Force,
  pass3Mode,
  onPass3Mode,
  label,
  onLabel,
}: PassStripProps) {
  const pass1 = run?.passes.pass1;
  const pass2 = run?.passes.pass2;
  const labels = run?.passes.pass3.labels ?? [];

  const measureStatus = measureJob
    ? `${measureJob.status} · ${progressLabel(measureJob.progress.done, measureJob.progress.total)}`
    : 'not started';

  const parseN = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };

  return (
    <div className="space-y-2">
      {disabledReason && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
      {planError && <p className="text-xs text-red-600">{planError}</p>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <PassCard
          icon={<Calculator className="h-3.5 w-3.5" />}
          title="Measure"
          subtitle="Optional probe on a few threads"
          status={measureStatus}
          controls={
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Threads (n)
              </label>
              <Input
                type="number"
                min={1}
                value={measureN}
                onChange={(e) => onMeasureN(e.target.value)}
                placeholder="backend default"
              />
            </div>
          }
          onPlan={() => onPlan({ pass: 'measure', n: parseN(measureN) })}
          planning={planningPass === 'measure'}
          disabled={disabled}
        />

        <PassCard
          icon={<ScanSearch className="h-3.5 w-3.5" />}
          title="Pass 1 · identify"
          subtitle="Which payment the thread was about"
          status={pass1 ? progressLabel(pass1.done, pass1.total) : 'not started'}
          controls={
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  First N threads only
                </label>
                <Input
                  type="number"
                  min={1}
                  value={pass1N}
                  onChange={(e) => onPass1N(e.target.value)}
                  placeholder="all"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={pass1Force}
                  onChange={(e) => onPass1Force(e.target.checked)}
                />
                Force (re-run threads already done)
              </label>
            </>
          }
          onPlan={() => onPlan({ pass: 'pass1', n: parseN(pass1N), force: pass1Force })}
          planning={planningPass === 'pass1'}
          disabled={disabled}
        />

        <PassCard
          icon={<BookOpen className="h-3.5 w-3.5" />}
          title="Pass 2 · read"
          subtitle="What happened, what would have removed it"
          status={pass2 ? progressLabel(pass2.done, pass2.total) : 'not started'}
          onPlan={() => onPlan({ pass: 'pass2' })}
          planning={planningPass === 'pass2'}
          disabled={disabled}
        />

        <PassCard
          icon={<Layers className="h-3.5 w-3.5" />}
          title="Pass 3 · induce"
          subtitle="Categories induced from the readings"
          status={labels.length > 0 ? `labels: ${labels.join(', ')}` : 'not started'}
          controls={
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Mode</label>
                <Select
                  value={pass3Mode}
                  onChange={(e) => onPass3Mode(e.target.value as Pass3Mode)}
                >
                  <option value="two-step">two-step</option>
                  <option value="one-call">one-call</option>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Label</label>
                <Input value={label} onChange={(e) => onLabel(e.target.value)} placeholder="a" />
              </div>
            </div>
          }
          onPlan={() =>
            onPlan({ pass: 'pass3', mode: pass3Mode, label: label.trim() || 'a' })
          }
          planning={planningPass === 'pass3'}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
