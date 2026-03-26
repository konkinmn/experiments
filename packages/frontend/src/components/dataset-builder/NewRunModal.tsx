import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useRunOptions, useCreateRun } from '@/hooks/useDatasetBuilder';
import type { RubricWeights } from '@/types';

interface NewRunModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: number;
}

export function NewRunModal({ open, onOpenChange, datasetId }: NewRunModalProps) {
  const { data: runOptions, isLoading: optionsLoading } = useRunOptions();
  const createRun = useCreateRun();

  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [promptVersion, setPromptVersion] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [weights, setWeights] = useState<RubricWeights | null>(null);

  const currentWeights: RubricWeights = weights ?? runOptions?.default_rubric ?? {
    account_trust_max: 58,
    dispute_history_max: 30,
    transaction_risk_max: 20,
    green_threshold: 70,
    amber_threshold: 40,
  };

  const selectedModel = model || (runOptions?.models[0] ?? '');
  const selectedPrompt = promptVersion || (runOptions?.prompts[0] ?? '');

  const canSubmit = name.trim() && selectedModel && selectedPrompt && !createRun.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    createRun.mutate(
      {
        datasetId,
        name: name.trim(),
        model: selectedModel,
        prompt_version: selectedPrompt,
        rubric_weights: currentWeights,
      },
      {
        onSuccess: () => {
          setName('');
          setModel('');
          setPromptVersion('');
          setWeights(null);
          setShowAdvanced(false);
          onOpenChange(false);
        },
      }
    );
  };

  const updateWeight = (key: keyof RubricWeights, value: string) => {
    const num = Number(value);
    if (isNaN(num)) return;
    setWeights({ ...currentWeights, [key]: num });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Run</DialogTitle>
          <DialogDescription>
            Configure and run the pipeline against all cases in this dataset.
          </DialogDescription>
        </DialogHeader>

        {optionsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700">Run name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sonnet v2 test"
                className="mt-1"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700">Model</label>
              <Select
                value={selectedModel}
                onChange={(e) => setModel(e.target.value)}
                className="mt-1"
              >
                {runOptions?.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700">Prompt version</label>
              <Select
                value={selectedPrompt}
                onChange={(e) => setPromptVersion(e.target.value)}
                className="mt-1"
              >
                {runOptions?.prompts.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </Select>
            </div>

            <div>
              <button
                type="button"
                className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? 'Hide' : 'Show'} advanced settings
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-3 rounded-md border border-gray-200 p-3">
                  <p className="text-xs text-muted-foreground mb-2">Rubric weights</p>
                  <WeightField
                    label="Account Trust max"
                    value={currentWeights.account_trust_max}
                    onChange={(v) => updateWeight('account_trust_max', v)}
                  />
                  <WeightField
                    label="Dispute History max"
                    value={currentWeights.dispute_history_max}
                    onChange={(v) => updateWeight('dispute_history_max', v)}
                  />
                  <WeightField
                    label="Transaction Risk max"
                    value={currentWeights.transaction_risk_max}
                    onChange={(v) => updateWeight('transaction_risk_max', v)}
                  />
                  <div className="border-t border-gray-100 pt-3">
                    <p className="text-xs text-muted-foreground mb-2">Thresholds</p>
                    <WeightField
                      label="Green threshold"
                      value={currentWeights.green_threshold}
                      onChange={(v) => updateWeight('green_threshold', v)}
                    />
                    <WeightField
                      label="Amber threshold"
                      value={currentWeights.amber_threshold}
                      onChange={(v) => updateWeight('amber_threshold', v)}
                    />
                  </div>
                </div>
              )}
            </div>

            {createRun.isError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {createRun.error?.message ?? 'Failed to create run'}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {createRun.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WeightField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-gray-600 whitespace-nowrap">{label}</label>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 text-right"
      />
    </div>
  );
}
