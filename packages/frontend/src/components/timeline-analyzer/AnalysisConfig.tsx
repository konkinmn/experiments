import { Select } from '@/components/ui/select';
import { usePrompts } from '@/hooks/useTimelineAnalyzer';
import type { AnalyzerConfig, CaseSource } from '@/types';

interface AnalysisConfigProps {
  config: AnalyzerConfig;
  onChange: (config: AnalyzerConfig) => void;
  visibleCasesCount: number;
}

export function AnalysisConfig({ config, onChange, visibleCasesCount }: AnalysisConfigProps) {
  const { data: prompts, isLoading: promptsLoading } = usePrompts();

  const handlePromptChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChange({ ...config, promptId: e.target.value });
  };

  const handleCaseSourceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChange({ ...config, caseSource: e.target.value as CaseSource });
  };

  const handleManualIdsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange({ ...config, manualCaseIds: e.target.value });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Analysis Prompt</label>
        <Select
          value={config.promptId}
          onChange={handlePromptChange}
          disabled={promptsLoading}
        >
          <option value="">Select a prompt...</option>
          {prompts?.map((prompt) => (
            <option key={prompt.id} value={prompt.id}>
              {prompt.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Case Source</label>
        <Select value={config.caseSource} onChange={handleCaseSourceChange}>
          <option value="visible">
            Visible Cases ({visibleCasesCount} cases)
          </option>
          <option value="manual">Manual Case IDs</option>
        </Select>
      </div>

      {config.caseSource === 'manual' && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Case IDs</label>
          <textarea
            className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="Enter case IDs (one per line or comma-separated)"
            value={config.manualCaseIds}
            onChange={handleManualIdsChange}
          />
          <p className="text-xs text-muted-foreground">
            Enter numeric case IDs, one per line or separated by commas.
          </p>
        </div>
      )}
    </div>
  );
}
