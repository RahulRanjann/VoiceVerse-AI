import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { DialogueSegment, ResultAvailability } from '@/features/studio/types';
import { formatTimecode } from './speech-analysis-presentation';

interface DialogueSegmentPreviewProps {
  availability?: ResultAvailability;
  error?: Error;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  loadMore(): void;
  segments: DialogueSegment[];
  totalCount: number;
}

export function DialogueSegmentPreview({
  availability,
  error,
  hasMore,
  isLoading,
  isLoadingMore,
  loadMore,
  segments,
  totalCount,
}: DialogueSegmentPreviewProps) {
  return (
    <section aria-labelledby="dialogue-preview-title" className="rounded-2xl border bg-card">
      <div className="flex items-start justify-between gap-4 p-5 sm:p-6">
        <div>
          <h2 id="dialogue-preview-title" className="text-lg font-semibold">
            Dialogue preview
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Source transcript aligned to its detected character and timeline.
          </p>
        </div>
        {availability === 'AVAILABLE' && (
          <span className="text-sm tabular-nums text-muted-foreground">{totalCount} lines</span>
        )}
      </div>

      {isLoading || availability === 'PENDING' || (!availability && !error) ? (
        <div className="space-y-3 border-t p-5" aria-label="Loading dialogue">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : error && segments.length === 0 ? (
        <p className="border-t p-5 text-sm text-muted-foreground">
          Dialogue results are temporarily unavailable.
        </p>
      ) : availability === 'UNAVAILABLE' ? (
        <p className="border-t p-5 text-sm text-muted-foreground">
          A transcript is not available for this analysis.
        </p>
      ) : segments.length === 0 ? (
        <p className="border-t p-5 text-sm text-muted-foreground">No spoken dialogue was found.</p>
      ) : (
        <>
          <div className="hidden border-t px-4 pb-2 md:block">
            <Table>
              <TableCaption className="sr-only">
                Detected source-language dialogue in timeline order.
              </TableCaption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">Time</TableHead>
                  <TableHead scope="col">Character</TableHead>
                  <TableHead scope="col">Source dialogue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {segments.map((segment) => (
                  <TableRow key={segment.id}>
                    <TableCell className="align-top font-mono text-xs text-muted-foreground">
                      {formatTimecode(segment.startMs)}
                    </TableCell>
                    <TableCell className="align-top font-medium">
                      {segment.character?.displayName ?? 'Unassigned'}
                    </TableCell>
                    <TableCell className="max-w-2xl whitespace-normal align-top leading-relaxed">
                      {segment.sourceText}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ol className="divide-y border-t md:hidden">
            {segments.map((segment) => (
              <li key={segment.id} className="p-5">
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {segment.character?.displayName ?? 'Unassigned'}
                  </span>
                  <time className="font-mono tabular-nums">{formatTimecode(segment.startMs)}</time>
                </div>
                <p className="mt-2 text-sm leading-relaxed">{segment.sourceText}</p>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between gap-4 border-t p-4 sm:px-6">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              Showing {segments.length} of {totalCount} lines
            </p>
            {hasMore && (
              <Button variant="outline" size="sm" disabled={isLoadingMore} onClick={loadMore}>
                {isLoadingMore ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
