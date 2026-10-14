import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { CreateSnapshotRequest } from '@/types';

interface NewSnapshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: CreateSnapshotRequest) => void;
  creating: boolean;
}

/** Freezes a thread population for a date range. No LLM calls. */
export function NewSnapshotDialog({
  open,
  onOpenChange,
  onCreate,
  creating,
}: NewSnapshotDialogProps) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [name, setName] = useState('');
  const [seed, setSeed] = useState('');

  const canCreate = dateFrom.trim() !== '' && dateTo.trim() !== '' && name.trim() !== '';

  const handleCreate = () => {
    if (!canCreate) return;
    const body: CreateSnapshotRequest = {
      dateFrom: dateFrom.trim(),
      dateTo: dateTo.trim(),
      name: name.trim(),
    };
    if (seed.trim() !== '' && Number.isFinite(Number(seed))) body.seed = Number(seed);
    onCreate(body);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New snapshot</DialogTitle>
          <DialogDescription>
            Freezes the thread population for a date range. No LLM calls.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">To</label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. pilot-2026-08-19"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Seed (optional)
            </label>
            <Input
              type="number"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="backend default"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canCreate || creating}>
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create snapshot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface NewRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (run: string) => void;
  creating: boolean;
}

/** A run is a fresh set of passes over the same snapshot. Nothing is called yet. */
export function NewRunDialog({ open, onOpenChange, onCreate, creating }: NewRunDialogProps) {
  const [name, setName] = useState('');

  const handleCreate = () => {
    if (name.trim() === '') return;
    onCreate(name.trim());
    setName('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New run</DialogTitle>
          <DialogDescription>
            A run is a fresh set of passes over the same snapshot. Nothing is called yet.
          </DialogDescription>
        </DialogHeader>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Run name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. r2" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={name.trim() === '' || creating}>
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
