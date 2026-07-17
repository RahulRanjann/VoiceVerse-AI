import { Clock3Icon, MessageSquareTextIcon, UsersIcon } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import type {
  AnalysisResultPage,
  CharacterSummary as Character,
  ResultAvailability,
} from '@/features/studio/types';
import { formatDuration, formatTimecode } from './speech-analysis-presentation';

interface CharacterSummaryProps {
  availability?: ResultAvailability;
  error?: Error;
  isLoading: boolean;
  page?: AnalysisResultPage<Character>;
}

export function CharacterSummary({ availability, error, isLoading, page }: CharacterSummaryProps) {
  const currentAvailability = page?.availability ?? availability;

  return (
    <section
      aria-labelledby="character-summary-title"
      className="rounded-2xl border bg-card p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="character-summary-title" className="text-lg font-semibold">
            Characters
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Stable identities found across the source.
          </p>
        </div>
        {page?.availability === 'AVAILABLE' && (
          <span className="text-2xl font-semibold tabular-nums">{page.totalCount}</span>
        )}
      </div>

      {isLoading || currentAvailability === 'PENDING' ? (
        <div className="mt-5 space-y-3" aria-label="Loading characters">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : error && !page ? (
        <p className="mt-5 text-sm text-muted-foreground">
          Character results are temporarily unavailable.
        </p>
      ) : currentAvailability === 'UNAVAILABLE' ? (
        <p className="mt-5 text-sm text-muted-foreground">
          Character results are not available for this analysis.
        </p>
      ) : page?.data.length === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground">No speaking characters were found.</p>
      ) : (
        <ul className="mt-5 space-y-3">
          {page?.data.map((character) => (
            <li key={character.id} className="rounded-xl border bg-background/45 p-4">
              <p className="font-medium">{character.displayName}</p>
              <dl className="mt-3 grid grid-cols-3 gap-3 text-xs text-muted-foreground">
                <div>
                  <dt className="flex items-center gap-1">
                    <MessageSquareTextIcon aria-hidden="true" className="size-3.5" /> Lines
                  </dt>
                  <dd className="mt-1 font-medium tabular-nums text-foreground">
                    {character.segmentCount}
                  </dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1">
                    <Clock3Icon aria-hidden="true" className="size-3.5" /> Speaking
                  </dt>
                  <dd className="mt-1 font-medium tabular-nums text-foreground">
                    {formatDuration(character.speakingDurationMs)}
                  </dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1">
                    <UsersIcon aria-hidden="true" className="size-3.5" /> First seen
                  </dt>
                  <dd className="mt-1 font-medium tabular-nums text-foreground">
                    {formatTimecode(character.firstAppearanceMs)}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
