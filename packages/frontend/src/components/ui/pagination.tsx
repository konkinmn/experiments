import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}

function Pagination({ page, totalPages, onPageChange, className }: PaginationProps) {
  const canGoPrevious = page > 1;
  const canGoNext = page < totalPages;

  const getVisiblePages = () => {
    const pages: (number | 'ellipsis')[] = [];
    const showEllipsisStart = page > 3;
    const showEllipsisEnd = page < totalPages - 2;

    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    pages.push(1);

    if (showEllipsisStart) {
      pages.push('ellipsis');
    }

    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);

    for (let i = start; i <= end; i++) {
      if (!pages.includes(i)) {
        pages.push(i);
      }
    }

    if (showEllipsisEnd) {
      pages.push('ellipsis');
    }

    if (!pages.includes(totalPages)) {
      pages.push(totalPages);
    }

    return pages;
  };

  if (totalPages <= 1) return null;

  return (
    <nav
      className={cn('flex items-center justify-center gap-1', className)}
      aria-label="Pagination"
    >
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={!canGoPrevious}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        aria-label="Go to previous page"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      {getVisiblePages().map((pageNum, idx) =>
        pageNum === 'ellipsis' ? (
          <span key={`ellipsis-${idx}`} className="px-2 text-muted-foreground">
            ...
          </span>
        ) : (
          <button
            key={pageNum}
            onClick={() => onPageChange(pageNum)}
            className={cn(
              'inline-flex h-9 w-9 items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              page === pageNum
                ? 'border border-input bg-primary text-primary-foreground'
                : 'border border-input bg-background hover:bg-accent hover:text-accent-foreground'
            )}
            aria-label={`Go to page ${pageNum}`}
            aria-current={page === pageNum ? 'page' : undefined}
          >
            {pageNum}
          </button>
        )
      )}

      <button
        onClick={() => onPageChange(page + 1)}
        disabled={!canGoNext}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        aria-label="Go to next page"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
  );
}

export { Pagination };
