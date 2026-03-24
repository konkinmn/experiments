import { Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import type { SavedAnalysis } from '@/types';

interface SavedAnalysesListProps {
  analyses: SavedAnalysis[];
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function SavedAnalysesList({ analyses, onLoad, onDelete }: SavedAnalysesListProps) {
  if (analyses.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No saved analyses yet
      </p>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Prompt</TableHead>
            <TableHead className="text-right">Cases</TableHead>
            <TableHead>Saved</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {analyses.map((analysis) => (
            <TableRow key={analysis.id}>
              <TableCell className="font-medium">{analysis.name}</TableCell>
              <TableCell className="text-muted-foreground">{analysis.promptName}</TableCell>
              <TableCell className="text-right">
                <span className="text-green-600">{analysis.successCount}</span>
                {analysis.errorCount > 0 && (
                  <span className="text-red-600 ml-1">/ {analysis.errorCount}</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(analysis.savedAt)}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1 justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onLoad(analysis.id)}
                    title="Load analysis"
                  >
                    <Upload className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(analysis.id)}
                    title="Delete analysis"
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
