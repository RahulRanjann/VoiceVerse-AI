import { Badge } from '@/components/ui/badge';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import type { WorkflowStage } from '@/features/studio/types';
import { cn } from '@/lib/utils';
import { stagePresentation } from './speech-analysis-presentation';

export function WorkflowStageList({ stages }: { stages: WorkflowStage[] }) {
  const orderedStages = [...stages].sort(
    (left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0),
  );

  return (
    <section
      aria-labelledby="workflow-stages-title"
      className="rounded-2xl border bg-card p-5 sm:p-6"
    >
      <h2 id="workflow-stages-title" className="text-lg font-semibold">
        Analysis stages
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Each stage produces durable, reviewable movie context.
      </p>
      <ol className="mt-5 space-y-5">
        {orderedStages.map((stage) => {
          const presentation = stagePresentation(stage.key, stage.status);
          const percent = Math.round(
            Math.min(10_000, Math.max(0, stage.progressBasisPoints)) / 100,
          );
          const variant = {
            destructive: 'destructive' as const,
            muted: 'outline' as const,
            success: 'success' as const,
            warning: 'warning' as const,
          }[presentation.tone];
          const toneClass = {
            destructive: '[&_[data-slot=progress-indicator]]:bg-destructive',
            muted: '[&_[data-slot=progress-indicator]]:bg-muted-foreground',
            success: '[&_[data-slot=progress-indicator]]:bg-success',
            warning: '[&_[data-slot=progress-indicator]]:bg-warning',
          }[presentation.tone];

          return (
            <li key={stage.id}>
              <Progress
                value={percent}
                className={cn('gap-x-3 gap-y-2', toneClass)}
                aria-label={`${presentation.label}: ${presentation.statusLabel}, ${percent}%`}
              >
                <ProgressLabel>{presentation.label}</ProgressLabel>
                <Badge variant={variant}>{presentation.statusLabel}</Badge>
                <ProgressValue>{(_formattedValue, value) => `${value ?? percent}%`}</ProgressValue>
              </Progress>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
