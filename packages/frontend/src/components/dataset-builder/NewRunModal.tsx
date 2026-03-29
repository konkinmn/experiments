import { useState, useEffect } from 'react';
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
import { useRunOptions, useCreateRun } from '@/hooks/useDatasetBuilder';
import type { PipelineConfig } from '@/types';

interface NewRunModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: number;
}

export function NewRunModal({ open, onOpenChange, datasetId }: NewRunModalProps) {
  const { data: runOptions, isLoading: optionsLoading } = useRunOptions();
  const createRun = useCreateRun();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [promptContent, setPromptContent] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [config, setConfig] = useState<PipelineConfig | null>(null);

  // Pre-fill defaults when options load
  useEffect(() => {
    if (runOptions && !model) setModel(runOptions.default_model);
    if (runOptions && !promptContent) setPromptContent(runOptions.default_prompt.content);
    if (runOptions && !config) setConfig(structuredClone(runOptions.default_pipeline_config));
  }, [runOptions, model, promptContent, config]);

  const currentConfig: PipelineConfig = config ?? runOptions?.default_pipeline_config ?? {
    hard_gates: { cifas: true, confirmed_scammer: true, account_not_active: true, railsr_dispute_last_6_months: true },
    rubric_weights: { account_trust_max: 58, dispute_history_max: 30, transaction_risk_max: 20, green_threshold: 70, amber_threshold: 40 },
    scoring_rules: {
      account_age: [{ min_days: 365, points: 20 }, { min_days: 180, points: 12 }, { min_days: 90, points: 5 }],
      tier: { E: 10, D: 8, C: 5 },
      money_maker_points: 15,
      trust_score: { GREEN: 8, AMBER: 4 },
      tx_activity: { min_count: 5, points: 5 },
      dispute_history: [{ max_disputes: 0, points: 30 }, { max_disputes: 2, points: 15 }, { max_disputes: 4, points: 5 }],
      recent_dispute_penalty: -5,
      scam_victim_penalty: -5,
      amount_brackets: [{ max_amount: 5, points: 20 }, { max_amount: 10, points: 14 }, { max_amount: 15, points: 9 }, { max_amount: 25, points: 5 }],
    },
  };

  const isDefaultPrompt = promptContent === runOptions?.default_prompt.content;
  const promptVersion = isDefaultPrompt ? (runOptions?.default_prompt.id ?? 'custom') : 'custom';

  const canSubmit = name.trim() && model.trim() && promptContent.trim() && !createRun.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    createRun.mutate(
      {
        datasetId,
        name: name.trim(),
        description: description.trim() || undefined,
        model: model.trim(),
        prompt_version: promptVersion,
        prompt_content: promptContent,
        pipeline_config: currentConfig,
      },
      {
        onSuccess: () => {
          setName('');
          setDescription('');
          setModel('');
          setPromptContent('');
          setConfig(null);
          setShowAdvanced(false);
          onOpenChange(false);
        },
      }
    );
  };

  const updateConfig = (updater: (c: PipelineConfig) => PipelineConfig) => {
    setConfig(updater(structuredClone(currentConfig)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
              <label className="text-sm font-medium text-gray-700">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description of what this run tests"
                rows={2}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700">Model</label>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. claude-sonnet-4-6"
                className="mt-1 font-mono text-sm"
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">Prompt</label>
                {!isDefaultPrompt && (
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:text-blue-700"
                    onClick={() => setPromptContent(runOptions?.default_prompt.content ?? '')}
                  >
                    Reset to default
                  </button>
                )}
              </div>
              <textarea
                value={promptContent}
                onChange={(e) => setPromptContent(e.target.value)}
                rows={8}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
              />
              {!isDefaultPrompt && (
                <p className="mt-1 text-xs text-amber-600">Modified from default</p>
              )}
            </div>

            <div>
              <button
                type="button"
                className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? 'Hide' : 'Show'} pipeline settings
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-4">
                  {/* Hard Gates */}
                  <div className="rounded-md border border-gray-200 p-3">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Hard Gates</p>
                    <div className="space-y-2">
                      {([
                        ['cifas', 'CIFAS marker'],
                        ['confirmed_scammer', 'Confirmed scammer'],
                        ['account_not_active', 'Account inactive'],
                        ['railsr_dispute_last_6_months', 'Railsr dispute (6m)'],
                      ] as const).map(([key, label]) => (
                        <label key={key} className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="checkbox"
                            checked={currentConfig.hard_gates[key]}
                            onChange={(e) => updateConfig((c) => ({ ...c, hard_gates: { ...c.hard_gates, [key]: e.target.checked } }))}
                            className="rounded border-gray-300"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Rubric Weights & Thresholds */}
                  <div className="rounded-md border border-gray-200 p-3">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Rubric Weights</p>
                    <div className="space-y-2">
                      <NumberField label="Account Trust max" value={currentConfig.rubric_weights.account_trust_max} onChange={(v) => updateConfig((c) => ({ ...c, rubric_weights: { ...c.rubric_weights, account_trust_max: v } }))} />
                      <NumberField label="Dispute History max" value={currentConfig.rubric_weights.dispute_history_max} onChange={(v) => updateConfig((c) => ({ ...c, rubric_weights: { ...c.rubric_weights, dispute_history_max: v } }))} />
                      <NumberField label="Transaction Risk max" value={currentConfig.rubric_weights.transaction_risk_max} onChange={(v) => updateConfig((c) => ({ ...c, rubric_weights: { ...c.rubric_weights, transaction_risk_max: v } }))} />
                    </div>
                    <div className="border-t border-gray-100 mt-3 pt-3">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Thresholds</p>
                      <div className="space-y-2">
                        <NumberField label="Green threshold" value={currentConfig.rubric_weights.green_threshold} onChange={(v) => updateConfig((c) => ({ ...c, rubric_weights: { ...c.rubric_weights, green_threshold: v } }))} />
                        <NumberField label="Amber threshold" value={currentConfig.rubric_weights.amber_threshold} onChange={(v) => updateConfig((c) => ({ ...c, rubric_weights: { ...c.rubric_weights, amber_threshold: v } }))} />
                      </div>
                    </div>
                  </div>

                  {/* Scoring Rules */}
                  <div className="rounded-md border border-gray-200 p-3">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Scoring Rules</p>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs text-gray-500 mb-1">Account age</p>
                        {currentConfig.scoring_rules.account_age.map((bracket, i) => (
                          <div key={i} className="flex items-center gap-2 text-sm mb-1">
                            <span className="text-gray-500 w-20 text-right shrink-0">{'>='}{bracket.min_days}d</span>
                            <span className="text-gray-400">&rarr;</span>
                            <Input type="number" value={bracket.points} className="w-16 text-right" onChange={(e) => {
                              const v = Number(e.target.value); if (isNaN(v)) return;
                              updateConfig((c) => { c.scoring_rules.account_age[i].points = v; return c; });
                            }} />
                            <span className="text-gray-400 text-xs">pts</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 mb-1">Trust score</p>
                        {Object.entries(currentConfig.scoring_rules.trust_score).map(([level, pts]) => (
                          <div key={level} className="flex items-center gap-2 text-sm mb-1">
                            <span className="text-gray-500 w-20 text-right shrink-0">{level}</span>
                            <span className="text-gray-400">&rarr;</span>
                            <Input type="number" value={pts} className="w-16 text-right" onChange={(e) => {
                              const v = Number(e.target.value); if (isNaN(v)) return;
                              updateConfig((c) => { c.scoring_rules.trust_score[level] = v; return c; });
                            }} />
                            <span className="text-gray-400 text-xs">pts</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 mb-1">Amount brackets</p>
                        {currentConfig.scoring_rules.amount_brackets.map((bracket, i) => (
                          <div key={i} className="flex items-center gap-2 text-sm mb-1">
                            <span className="text-gray-500 w-20 text-right shrink-0">{'<'}£{bracket.max_amount}</span>
                            <span className="text-gray-400">&rarr;</span>
                            <Input type="number" value={bracket.points} className="w-16 text-right" onChange={(e) => {
                              const v = Number(e.target.value); if (isNaN(v)) return;
                              updateConfig((c) => { c.scoring_rules.amount_brackets[i].points = v; return c; });
                            }} />
                            <span className="text-gray-400 text-xs">pts</span>
                          </div>
                        ))}
                      </div>
                      <NumberField label="Money maker bonus" value={currentConfig.scoring_rules.money_maker_points} onChange={(v) => updateConfig((c) => ({ ...c, scoring_rules: { ...c.scoring_rules, money_maker_points: v } }))} />
                      <NumberField label="Recent dispute penalty" value={currentConfig.scoring_rules.recent_dispute_penalty} onChange={(v) => updateConfig((c) => ({ ...c, scoring_rules: { ...c.scoring_rules, recent_dispute_penalty: v } }))} />
                      <NumberField label="Scam victim penalty" value={currentConfig.scoring_rules.scam_victim_penalty} onChange={(v) => updateConfig((c) => ({ ...c, scoring_rules: { ...c.scoring_rules, scam_victim_penalty: v } }))} />
                    </div>
                  </div>

                  {/* Dynamic Score Summary */}
                  <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
                    <ScoreSummary config={currentConfig} />
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

function ScoreSummary({ config }: { config: PipelineConfig }) {
  const { scoring_rules: r, rubric_weights: w } = config;
  const maxAccountTrust = Math.min(
    Math.max(...r.account_age.map((b) => b.points), 0) +
    Math.max(...Object.values(r.tier), 0) +
    r.money_maker_points +
    Math.max(...Object.values(r.trust_score), 0) +
    r.tx_activity.points,
    w.account_trust_max,
  );
  const maxDisputeHistory = Math.min(
    Math.max(...r.dispute_history.map((b) => b.points), 0),
    w.dispute_history_max,
  );
  const maxTransactionRisk = Math.min(
    Math.max(...r.amount_brackets.map((b) => b.points), 0),
    w.transaction_risk_max,
  );
  const maxTotal = maxAccountTrust + maxDisputeHistory + maxTransactionRisk;

  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-gray-700">Max possible score</span>
        <span className="text-lg font-bold text-blue-700">{maxTotal} pts</span>
      </div>
      <div className="flex gap-4 mt-1 text-xs text-gray-500">
        <span>Trust: {maxAccountTrust}</span>
        <span>History: {maxDisputeHistory}</span>
        <span>Risk: {maxTransactionRisk}</span>
      </div>
      <div className="border-t border-blue-200 mt-2 pt-2 flex gap-4 text-xs">
        <span className="text-green-700 font-medium">Green: &ge;{w.green_threshold}</span>
        <span className="text-amber-600 font-medium">Amber: &ge;{w.amber_threshold}</span>
        <span className="text-red-600 font-medium">Red: &lt;{w.amber_threshold}</span>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-gray-600 whitespace-nowrap">{label}</label>
      <Input
        type="number"
        value={value}
        onChange={(e) => { const v = Number(e.target.value); if (!isNaN(v)) onChange(v); }}
        className="w-24 text-right"
      />
    </div>
  );
}
