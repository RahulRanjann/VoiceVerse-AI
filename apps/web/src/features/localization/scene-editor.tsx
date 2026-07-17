'use client';

import { HistoryIcon, SaveIcon } from 'lucide-react';
import { memo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { formatTimecode } from '@/features/studio/speech-analysis-presentation';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/features/auth/auth-provider';
import {
  updateDialogueTranslation,
  updateLocalizationScene,
  updateSourceDialogue,
  updateTranslationState,
} from './api';
import { RevisionHistoryDialog } from './history-dialog';
import { validateOptionalText, validateRequiredText } from './presentation';
import type {
  LocalizationDialogue,
  LocalizationScene,
  LocalizationTrack,
  TranslationEditorState,
} from './types';
import type { HistoryResource } from './use-localization';

interface SceneEditorProps {
  canWrite: boolean;
  onRefresh(): Promise<unknown>;
  projectId: string;
  scene: LocalizationScene;
  track: LocalizationTrack;
}

export function SceneEditor({ canWrite, onRefresh, projectId, scene, track }: SceneEditorProps) {
  const [historyResource, setHistoryResource] = useState<HistoryResource | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {!canWrite ? (
        <Alert>
          <AlertTitle>Read-only editor</AlertTitle>
          <AlertDescription>
            You can review scenes, dialogue, glossary terms, and revision history. An editor role is
            required to save or restore content.
          </AlertDescription>
        </Alert>
      ) : null}

      <SceneMetadataForm
        key={scene.revision.id}
        canWrite={canWrite}
        onHistory={() => setHistoryResource({ id: scene.id, kind: 'scene' })}
        onRefresh={onRefresh}
        projectId={projectId}
        scene={scene}
        trackId={track.id}
      />

      <Card>
        <CardHeader>
          <CardTitle>Scene dialogue</CardTitle>
          <CardDescription>
            Timings and character assignments stay fixed while source and target text are revised.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="hidden grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)] gap-3 px-4 text-xs font-medium text-muted-foreground lg:grid">
            <span>Timeline</span>
            <span>{track.sourceLanguage.englishName} source</span>
            <span>{track.targetLanguage.englishName} target</span>
          </div>
          {scene.dialogues.map((dialogue) => (
            <DialogueEditorRow
              key={`${dialogue.id}:${dialogue.source.revisionId}:${dialogue.translation?.revisionId ?? 'empty'}`}
              canWrite={canWrite}
              dialogue={dialogue}
              onHistory={setHistoryResource}
              onRefresh={onRefresh}
              projectId={projectId}
              sourceLanguage={track.sourceLanguage.englishName}
              targetLanguage={track.targetLanguage.englishName}
              targetLanguageTag={track.targetLanguage.bcp47Tag}
              trackId={track.id}
            />
          ))}
        </CardContent>
      </Card>

      <RevisionHistoryDialog
        key={historyResource ? `${historyResource.kind}:${historyResource.id}` : 'closed'}
        canWrite={canWrite}
        onOpenChange={(open) => {
          if (!open) setHistoryResource(null);
        }}
        onRestored={onRefresh}
        open={historyResource !== null}
        projectId={projectId}
        resource={historyResource}
        trackId={track.id}
      />
    </div>
  );
}

function SceneMetadataForm({
  canWrite,
  onHistory,
  onRefresh,
  projectId,
  scene,
  trackId,
}: {
  canWrite: boolean;
  onHistory(): void;
  onRefresh(): Promise<unknown>;
  projectId: string;
  scene: LocalizationScene;
  trackId: string;
}) {
  const { request } = useAuth();
  const [form, setForm] = useState(() => ({
    culturalNotes: scene.revision.culturalNotes ?? '',
    narrative: scene.revision.narrative ?? '',
    title: scene.revision.title ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const titleError = validateOptionalText(form.title, 'Title', 200);
  const narrativeError = validateOptionalText(form.narrative, 'Narrative', 4_000);
  const culturalNotesError = validateOptionalText(form.culturalNotes, 'Cultural notes', 8_000);
  const changed =
    normalizeOptional(form.title) !== scene.revision.title ||
    normalizeOptional(form.narrative) !== scene.revision.narrative ||
    normalizeOptional(form.culturalNotes) !== scene.revision.culturalNotes;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || !changed || titleError || narrativeError || culturalNotesError) return;
    setSaving(true);
    setConflict(false);
    setErrorMessage(null);
    try {
      await updateLocalizationScene(request, projectId, trackId, scene.id, {
        culturalNotes: normalizeOptional(form.culturalNotes),
        expectedRevision: scene.selectionRevision,
        narrative: normalizeOptional(form.narrative),
        title: normalizeOptional(form.title),
      });
      await onRefresh();
      toast.success('Scene context saved.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else
        setErrorMessage(error instanceof Error ? error.message : 'Could not save scene context.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{scene.revision.title || `Scene ${scene.ordinal}`}</CardTitle>
        <CardDescription>
          {formatTimecode(scene.revision.startMs)}–{formatTimecode(scene.revision.endMs)} ·{' '}
          {scene.dialogues.length} {scene.dialogues.length === 1 ? 'line' : 'lines'}
        </CardDescription>
        <CardAction>
          <Button type="button" size="sm" variant="outline" onClick={onHistory}>
            <HistoryIcon data-icon="inline-start" />
            History
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          <FieldGroup>
            <Field data-invalid={Boolean(titleError)} data-disabled={!canWrite}>
              <FieldLabel htmlFor={`scene-title-${scene.id}`}>Scene title</FieldLabel>
              <Input
                id={`scene-title-${scene.id}`}
                maxLength={201}
                value={form.title}
                disabled={!canWrite || saving}
                aria-invalid={Boolean(titleError)}
                onChange={(event) =>
                  setForm((current) => ({ ...current, title: event.target.value }))
                }
              />
              <FieldError>{titleError}</FieldError>
            </Field>
            <Field data-invalid={Boolean(narrativeError)} data-disabled={!canWrite}>
              <FieldLabel htmlFor={`scene-narrative-${scene.id}`}>Narrative context</FieldLabel>
              <Textarea
                id={`scene-narrative-${scene.id}`}
                maxLength={4_001}
                rows={3}
                value={form.narrative}
                disabled={!canWrite || saving}
                aria-invalid={Boolean(narrativeError)}
                onChange={(event) =>
                  setForm((current) => ({ ...current, narrative: event.target.value }))
                }
              />
              <FieldError>{narrativeError}</FieldError>
            </Field>
            <Field data-invalid={Boolean(culturalNotesError)} data-disabled={!canWrite}>
              <FieldLabel htmlFor={`scene-cultural-${scene.id}`}>Cultural notes</FieldLabel>
              <Textarea
                id={`scene-cultural-${scene.id}`}
                maxLength={8_001}
                rows={3}
                value={form.culturalNotes}
                disabled={!canWrite || saving}
                aria-invalid={Boolean(culturalNotesError)}
                onChange={(event) =>
                  setForm((current) => ({ ...current, culturalNotes: event.target.value }))
                }
              />
              <FieldError>{culturalNotesError}</FieldError>
            </Field>
          </FieldGroup>

          {conflict ? (
            <ConflictAlert
              onReload={() => {
                setConflict(false);
                void onRefresh();
              }}
            />
          ) : null}
          {errorMessage ? <MutationError message={errorMessage} /> : null}

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={
                !canWrite ||
                saving ||
                !changed ||
                Boolean(titleError || narrativeError || culturalNotesError)
              }
            >
              {saving ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              Save scene context
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const DialogueEditorRow = memo(function DialogueEditorRow({
  canWrite,
  dialogue,
  onHistory,
  onRefresh,
  projectId,
  sourceLanguage,
  targetLanguage,
  targetLanguageTag,
  trackId,
}: {
  canWrite: boolean;
  dialogue: LocalizationDialogue;
  onHistory(resource: HistoryResource): void;
  onRefresh(): Promise<unknown>;
  projectId: string;
  sourceLanguage: string;
  targetLanguage: string;
  targetLanguageTag: string;
  trackId: string;
}) {
  const { request } = useAuth();
  const [sourceText, setSourceText] = useState(dialogue.source.text);
  const [targetText, setTargetText] = useState(dialogue.translation?.text ?? '');
  const [pending, setPending] = useState<'source' | 'target' | 'state' | null>(null);
  const [conflict, setConflict] = useState<'source' | 'target' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const sourceError = validateRequiredText(sourceText, 'Source text');
  const targetError = validateRequiredText(targetText, 'Target text');
  const sourceChanged = normalizeRequired(sourceText) !== dialogue.source.text;
  const targetChanged = normalizeRequired(targetText) !== (dialogue.translation?.text ?? '');
  const targetUsesOlderSource =
    dialogue.translation !== null &&
    dialogue.translation.sourceRevisionId !== dialogue.source.revisionId;
  const reviewBlocked = sourceChanged || targetChanged || targetUsesOlderSource;
  const reviewGuidanceId = `review-guidance-${dialogue.id}`;
  const reviewGuidance = sourceChanged
    ? targetChanged
      ? 'Save or discard the source and target edits before changing review status.'
      : 'Save or discard the source edit before changing review status.'
    : targetChanged
      ? 'Save or discard the target edit before changing review status.'
      : 'Save or regenerate the target against the latest source before review.';
  const identity = dialogue.character?.name ?? 'Unassigned character';
  const timing = `${formatTimecode(dialogue.startMs)}–${formatTimecode(dialogue.endMs)}`;

  async function save(kind: 'source' | 'target') {
    const error = kind === 'source' ? sourceError : targetError;
    const changed = kind === 'source' ? sourceChanged : targetChanged;
    if (!canWrite || error || !changed) return;
    setPending(kind);
    setConflict(null);
    setErrorMessage(null);
    setSavedMessage(null);
    try {
      if (kind === 'source') {
        await updateSourceDialogue(request, projectId, trackId, dialogue.id, {
          expectedRevision: dialogue.source.selectionRevision,
          sourceText,
        });
      } else {
        await updateDialogueTranslation(request, projectId, trackId, dialogue.id, {
          expectedRevision: dialogue.translation?.selectionRevision ?? 0,
          targetText,
        });
      }
      await onRefresh();
      setSavedMessage(kind === 'source' ? 'Source saved.' : 'Translation saved.');
      toast.success(kind === 'source' ? 'Source dialogue saved.' : 'Translation saved.');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setConflict(kind);
      else setErrorMessage(caught instanceof Error ? caught.message : 'Could not save this line.');
    } finally {
      setPending(null);
    }
  }

  async function changeTranslationState(state: TranslationEditorState) {
    if (!canWrite || !dialogue.translation || pending !== null || reviewBlocked) return;
    setPending('state');
    setConflict(null);
    setErrorMessage(null);
    setSavedMessage(null);
    try {
      await updateTranslationState(request, projectId, trackId, dialogue.id, {
        expectedRevision: dialogue.translation.selectionRevision,
        state,
      });
      await onRefresh();
      const status = translationStateLabel(state).toLowerCase();
      setSavedMessage(`Translation marked ${status}.`);
      toast.success(`Translation marked ${status}.`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setConflict('target');
      else {
        setErrorMessage(
          caught instanceof Error ? caught.message : 'Could not change the review status.',
        );
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <article
      className="grid gap-4 rounded-xl border bg-surface p-4 lg:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]"
      style={{ containIntrinsicSize: '0 300px', contentVisibility: 'auto' }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Line {dialogue.ordinal}</span>
        <span className="truncate font-medium" title={identity}>
          {identity}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{timing}</span>
      </div>

      <Field data-invalid={Boolean(sourceError)} data-disabled={!canWrite}>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`source-${dialogue.id}`}>{sourceLanguage} source</FieldLabel>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onHistory({ id: dialogue.id, kind: 'source' })}
          >
            <HistoryIcon data-icon="inline-start" />
            History
          </Button>
        </div>
        <Textarea
          id={`source-${dialogue.id}`}
          aria-label={`${sourceLanguage} source for ${identity} at ${timing}`}
          aria-invalid={Boolean(sourceError)}
          disabled={!canWrite || pending !== null}
          maxLength={10_001}
          rows={4}
          value={sourceText}
          onChange={(event) => setSourceText(event.target.value)}
        />
        <FieldError>{sourceError}</FieldError>
        {conflict === 'source' ? (
          <ConflictAlert
            onReload={() => {
              setConflict(null);
              void onRefresh();
            }}
          />
        ) : null}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canWrite || pending !== null || Boolean(sourceError) || !sourceChanged}
            onClick={() => void save('source')}
          >
            {pending === 'source' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SaveIcon data-icon="inline-start" />
            )}
            Save source
          </Button>
        </div>
      </Field>

      <Field data-invalid={Boolean(targetError)} data-disabled={!canWrite}>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`target-${dialogue.id}`}>{targetLanguage} target</FieldLabel>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onHistory({ id: dialogue.id, kind: 'translation' })}
          >
            <HistoryIcon data-icon="inline-start" />
            History
          </Button>
        </div>
        {targetUsesOlderSource ? (
          <Badge variant="warning">Source changed since translation</Badge>
        ) : null}
        {dialogue.translation ? (
          <Badge variant={dialogue.translation.editorState === 'APPROVED' ? 'success' : 'outline'}>
            {translationStateLabel(dialogue.translation.editorState)}
          </Badge>
        ) : null}
        <Textarea
          id={`target-${dialogue.id}`}
          lang={targetLanguageTag}
          dir="auto"
          aria-label={`${targetLanguage} target for ${identity} at ${timing}`}
          aria-invalid={Boolean(targetError)}
          disabled={!canWrite || pending !== null}
          maxLength={10_001}
          placeholder="Translation not written yet"
          rows={4}
          value={targetText}
          onChange={(event) => setTargetText(event.target.value)}
        />
        <FieldError>{targetError}</FieldError>
        {conflict === 'target' ? (
          <ConflictAlert
            onReload={() => {
              setConflict(null);
              void onRefresh();
            }}
          />
        ) : null}
        {dialogue.translation && reviewBlocked ? (
          <p id={reviewGuidanceId} className="text-xs text-muted-foreground">
            {reviewGuidance}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {dialogue.translation?.editorState === 'DRAFT' ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-describedby={reviewBlocked ? reviewGuidanceId : undefined}
              disabled={!canWrite || pending !== null || reviewBlocked}
              onClick={() => void changeTranslationState('IN_REVIEW')}
            >
              {pending === 'state' ? <Spinner data-icon="inline-start" /> : null}
              Send to review
            </Button>
          ) : null}
          {dialogue.translation?.editorState === 'IN_REVIEW' ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-describedby={reviewBlocked ? reviewGuidanceId : undefined}
                disabled={!canWrite || pending !== null || reviewBlocked}
                onClick={() => void changeTranslationState('DRAFT')}
              >
                Return to draft
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-describedby={reviewBlocked ? reviewGuidanceId : undefined}
                disabled={!canWrite || pending !== null || reviewBlocked}
                onClick={() => void changeTranslationState('APPROVED')}
              >
                {pending === 'state' ? <Spinner data-icon="inline-start" /> : null}
                Approve
              </Button>
            </>
          ) : null}
          {dialogue.translation?.editorState === 'APPROVED' ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-describedby={reviewBlocked ? reviewGuidanceId : undefined}
              disabled={!canWrite || pending !== null || reviewBlocked}
              onClick={() => void changeTranslationState('DRAFT')}
            >
              {pending === 'state' ? <Spinner data-icon="inline-start" /> : null}
              Reopen
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canWrite || pending !== null || Boolean(targetError) || !targetChanged}
            onClick={() => void save('target')}
          >
            {pending === 'target' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SaveIcon data-icon="inline-start" />
            )}
            Save target
          </Button>
        </div>
      </Field>

      {errorMessage ? (
        <div className="lg:col-start-2 lg:col-end-4">
          <MutationError message={errorMessage} />
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {savedMessage}
      </p>
    </article>
  );
});

function ConflictAlert({ onReload }: { onReload(): void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Someone else changed this content</AlertTitle>
      <AlertDescription>
        Reload the latest revision, then apply your edit again.
        <Button className="mt-3" type="button" size="sm" variant="outline" onClick={onReload}>
          Reload latest
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function MutationError({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Changes were not saved</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function normalizeOptional(value: string): string | null {
  const normalized = value.normalize('NFC').trim();
  return normalized || null;
}

function normalizeRequired(value: string): string {
  return value.normalize('NFC').trim();
}

function translationStateLabel(state: TranslationEditorState): string {
  return {
    APPROVED: 'Approved',
    DRAFT: 'Draft',
    IN_REVIEW: 'In review',
  }[state];
}
