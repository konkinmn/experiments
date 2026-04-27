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
import { useCreateRun } from '@/hooks/useDatasetBuilder';

interface NewRunModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: number;
}

export function NewRunModal({ open, onOpenChange, datasetId }: NewRunModalProps) {
  const createRun = useCreateRun();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const canSubmit = name.trim() && !createRun.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    createRun.mutate(
      {
        datasetId,
        name: name.trim(),
        description: description.trim() || undefined,
      },
      {
        onSuccess: () => {
          setName('');
          setDescription('');
          onOpenChange(false);
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New Run</DialogTitle>
          <DialogDescription>
            Run anna-case's dispute pipeline against all cases in this dataset.
            Model, prompt, hard gates, and scoring are all owned by anna-case — to
            test variations, edit them in anna-case directly and note what changed
            in the description.
          </DialogDescription>
        </DialogHeader>

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
              placeholder="What anna-case config you changed for this run — e.g. 'patched prompt to drop sub-£25 short-circuit', 'switched DISPUTE_PIPELINE_LLM_MODEL to claude-sonnet-4-6'"
              rows={3}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
            />
          </div>

          {createRun.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {createRun.error?.message ?? 'Failed to create run'}
            </div>
          )}
        </div>

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
