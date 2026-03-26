import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Database, Plus, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useDatasets, useCreateDataset, useDeleteDataset, useDatasetPresets } from '@/hooks/useDatasetBuilder';
import type { Dataset, DatasetSourceType, PresetInfo } from '@/types';

const SOURCE_TYPE_LABELS: Record<DatasetSourceType, string> = {
  preset: 'Preset',
  case_ids: 'Case IDs',
  custom_sql: 'Custom SQL',
};

const SOURCE_TYPE_VARIANT: Record<DatasetSourceType, 'blue' | 'green' | 'amber'> = {
  preset: 'blue',
  case_ids: 'green',
  custom_sql: 'amber',
};

export function DatasetBuilder() {
  const navigate = useNavigate();
  const { data: datasets = [], isLoading } = useDatasets();
  const deleteDataset = useDeleteDataset();
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const handleDelete = (id: number) => {
    deleteDataset.mutate(id, {
      onSuccess: () => setDeleteConfirmId(null),
    });
  };

  return (
    <div className="flex-1 p-6 bg-gray-50 overflow-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
              <Database className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Dataset Builder</h1>
              <p className="text-sm text-gray-500">
                Build ground-truth eval datasets — label pipeline decisions
              </p>
            </div>
          </div>
          <Button onClick={() => setModalOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New dataset
          </Button>
        </div>
      </div>

      {/* Dataset List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : datasets.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
          <Database className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No datasets yet. Create one to start labeling.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {datasets.map((dataset) => (
            <DatasetCard
              key={dataset.id}
              dataset={dataset}
              onClick={() => navigate(`/dataset/${dataset.id}`)}
              onDeleteClick={() => setDeleteConfirmId(dataset.id)}
            />
          ))}
        </div>
      )}

      {/* New Dataset Modal */}
      <NewDatasetModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onCreated={(id) => {
          setModalOpen(false);
          navigate(`/dataset/${id}`);
        }}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmId !== null} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete dataset</DialogTitle>
            <DialogDescription>
              This will permanently delete the dataset and all its cases. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}
              disabled={deleteDataset.isPending}
            >
              {deleteDataset.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DatasetCard({
  dataset,
  onClick,
  onDeleteClick,
}: {
  dataset: Dataset;
  onClick: () => void;
  onDeleteClick: () => void;
}) {
  const progress = dataset.totalCases > 0 ? (dataset.labeledCases / dataset.totalCases) * 100 : 0;

  return (
    <div
      className="rounded-lg border border-gray-200 bg-white px-5 py-4 hover:border-gray-300 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-gray-900 truncate">{dataset.name}</h3>
            <Badge variant={SOURCE_TYPE_VARIANT[dataset.sourceType]}>
              {SOURCE_TYPE_LABELS[dataset.sourceType]}
            </Badge>
          </div>
          {dataset.description && (
            <p className="text-sm text-muted-foreground truncate mb-2">{dataset.description}</p>
          )}
          <div className="flex items-center gap-3">
            <div className="flex-1 max-w-xs">
              <div className="flex h-2 rounded-full overflow-hidden bg-gray-100">
                <div
                  className="bg-blue-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {dataset.labeledCases} / {dataset.totalCases} labeled
            </span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-muted-foreground">
            {new Date(dataset.createdAt).toLocaleDateString()}
          </p>
        </div>
        <button
          className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-red-500 transition-colors shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteClick();
          }}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function NewDatasetModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: number) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceType, setSourceType] = useState<DatasetSourceType>('preset');
  const [presetKey, setPresetKey] = useState('');
  const [caseIdsText, setCaseIdsText] = useState('');
  const [customSql, setCustomSql] = useState('');
  const { data: presets = [] } = useDatasetPresets();
  const createDataset = useCreateDataset();

  const resetForm = () => {
    setName('');
    setDescription('');
    setSourceType('preset');
    setPresetKey('');
    setCaseIdsText('');
    setCustomSql('');
  };

  const handleCreate = () => {
    let sourceConfig: Record<string, unknown>;
    if (sourceType === 'preset') {
      sourceConfig = { preset_key: presetKey };
    } else if (sourceType === 'case_ids') {
      const ids = caseIdsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      sourceConfig = { ids };
    } else {
      sourceConfig = { sql: customSql };
    }

    createDataset.mutate(
      { name, description: description || null, sourceType, sourceConfig },
      {
        onSuccess: (data) => {
          resetForm();
          onCreated(data.id);
        },
      },
    );
  };

  const isValid =
    name.trim().length > 0 &&
    ((sourceType === 'preset' && presetKey.length > 0) ||
      (sourceType === 'case_ids' && caseIdsText.trim().length > 0) ||
      (sourceType === 'custom_sql' && customSql.trim().length > 0));

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        if (!val) resetForm();
        onOpenChange(val);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New dataset</DialogTitle>
          <DialogDescription>
            Create a dataset to populate with cases and label pipeline decisions.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Name</label>
            <Input
              placeholder="e.g. Clear credit Q1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Description</label>
            <textarea
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="Optional description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Source Type */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-2 block">Source</label>
            <div className="flex gap-2">
              {(['preset', 'case_ids', 'custom_sql'] as const).map((type) => (
                <button
                  key={type}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors border ${
                    sourceType === type
                      ? 'bg-blue-50 border-blue-300 text-blue-700'
                      : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                  onClick={() => setSourceType(type)}
                >
                  {SOURCE_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          </div>

          {/* Source Config */}
          {sourceType === 'preset' && (
            <PresetSelector presets={presets} value={presetKey} onChange={setPresetKey} />
          )}

          {sourceType === 'case_ids' && (
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Case IDs</label>
              <textarea
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="Enter case IDs, one per line or comma-separated"
                rows={4}
                value={caseIdsText}
                onChange={(e) => setCaseIdsText(e.target.value)}
              />
            </div>
          )}

          {sourceType === 'custom_sql' && (
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">BigQuery SQL</label>
              <textarea
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="SELECT DISTINCT c.id AS case_id FROM ..."
                rows={6}
                value={customSql}
                onChange={(e) => setCustomSql(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Query must return a <code className="bg-gray-100 px-1 rounded">case_id</code> column. Max 100 rows.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!isValid || createDataset.isPending}
          >
            {createDataset.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create
          </Button>
        </DialogFooter>

        {createDataset.isError && (
          <p className="text-sm text-red-600 mt-2">
            Error: {createDataset.error?.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PresetSelector({
  presets,
  value,
  onChange,
}: {
  presets: PresetInfo[];
  value: string;
  onChange: (key: string) => void;
}) {
  const selected = presets.find((p) => p.key === value);

  return (
    <div>
      <label className="text-sm font-medium text-gray-700 mb-1 block">Preset segment</label>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select a preset...</option>
        {presets.map((preset) => (
          <option key={preset.key} value={preset.key}>
            {preset.label}
          </option>
        ))}
      </Select>
      {selected && (
        <p className="text-xs text-muted-foreground mt-1">{selected.description}</p>
      )}
    </div>
  );
}
