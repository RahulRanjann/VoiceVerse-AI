'use client';

import { BookOpenIcon, HistoryIcon, PencilIcon, PlusIcon, SaveIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/features/auth/auth-provider';
import { ApiError } from '@/lib/api';
import { createGlossaryEntry, updateGlossaryEntry } from './api';
import { RevisionHistoryDialog } from './history-dialog';
import { validateOptionalText, validateRequiredText } from './presentation';
import type { GlossaryRevision, GlossaryRevisionInput } from './types';
import { useLocalizationGlossary, type HistoryResource } from './use-localization';

interface GlossarySheetProps {
  canWrite: boolean;
  onOpenChange(open: boolean): void;
  open: boolean;
  projectId: string;
  trackId: string;
}

export function GlossarySheet({
  canWrite,
  onOpenChange,
  open,
  projectId,
  trackId,
}: GlossarySheetProps) {
  const glossary = useLocalizationGlossary(projectId, trackId, open);
  const [editingEntryId, setEditingEntryId] = useState<string | 'new' | null>(null);
  const [historyResource, setHistoryResource] = useState<HistoryResource | null>(null);
  const editingEntry =
    editingEntryId && editingEntryId !== 'new'
      ? glossary.data?.data.find((entry) => entry.entryId === editingEntryId)
      : undefined;

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          if (!nextOpen) setEditingEntryId(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Track glossary</SheetTitle>
            <SheetDescription>
              Keep names, phrases, and do-not-translate terms consistent for this target language.
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-4 px-4 pb-6">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {glossary.data?.data.length ?? 0}{' '}
                {(glossary.data?.data.length ?? 0) === 1 ? 'term' : 'terms'}
              </p>
              <Button size="sm" disabled={!canWrite} onClick={() => setEditingEntryId('new')}>
                <PlusIcon data-icon="inline-start" />
                Add term
              </Button>
            </div>

            {!canWrite ? (
              <Alert>
                <AlertTitle>Read-only glossary</AlertTitle>
                <AlertDescription>
                  Viewers can inspect glossary entries and history, but cannot revise terms.
                </AlertDescription>
              </Alert>
            ) : null}

            {editingEntryId ? (
              <GlossaryForm
                key={editingEntry ? editingEntry.id : 'new'}
                entry={editingEntry}
                onCancel={() => setEditingEntryId(null)}
                onReload={async () => {
                  await glossary.mutate();
                  setEditingEntryId(null);
                }}
                onSaved={async () => {
                  await glossary.mutate();
                  setEditingEntryId(null);
                }}
                projectId={projectId}
                trackId={trackId}
              />
            ) : null}

            {glossary.isLoading && !glossary.data ? (
              <div className="flex flex-col gap-3" aria-label="Loading glossary">
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-28 w-full" />
              </div>
            ) : glossary.error && !glossary.data ? (
              <Alert variant="destructive">
                <AlertTitle>Glossary is unavailable</AlertTitle>
                <AlertDescription>
                  Try loading the glossary again.
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={() => void glossary.mutate()}
                  >
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            ) : glossary.data?.data.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BookOpenIcon />
                  </EmptyMedia>
                  <EmptyTitle>No glossary terms</EmptyTitle>
                  <EmptyDescription>
                    Add important names and phrases before generating a scene.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {glossary.data?.data.map((entry) => (
                  <Card key={entry.entryId} size="sm">
                    <CardHeader>
                      <CardTitle>{entry.sourceTerm}</CardTitle>
                      <CardDescription>
                        {entry.doNotTranslate ? 'Keep the source term unchanged' : entry.targetTerm}
                      </CardDescription>
                      <CardAction className="flex gap-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={!canWrite}
                          aria-label={`Edit ${entry.sourceTerm}`}
                          onClick={() => setEditingEntryId(entry.entryId)}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`View history for ${entry.sourceTerm}`}
                          onClick={() =>
                            setHistoryResource({ id: entry.entryId, kind: 'glossary' })
                          }
                        >
                          <HistoryIcon />
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      <div className="flex flex-wrap gap-1.5">
                        {entry.doNotTranslate ? (
                          <Badge variant="secondary">Do not translate</Badge>
                        ) : null}
                        {entry.caseSensitive ? (
                          <Badge variant="outline">Case sensitive</Badge>
                        ) : null}
                      </div>
                      {entry.notes ? (
                        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                          {entry.notes}
                        </p>
                      ) : null}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <RevisionHistoryDialog
        key={historyResource ? `${historyResource.kind}:${historyResource.id}` : 'closed'}
        canWrite={canWrite}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setHistoryResource(null);
        }}
        onRestored={() => glossary.mutate()}
        open={historyResource !== null}
        projectId={projectId}
        resource={historyResource}
        trackId={trackId}
      />
    </>
  );
}

function GlossaryForm({
  entry,
  onCancel,
  onReload,
  onSaved,
  projectId,
  trackId,
}: {
  entry?: GlossaryRevision;
  onCancel(): void;
  onReload(): Promise<unknown>;
  onSaved(): Promise<unknown>;
  projectId: string;
  trackId: string;
}) {
  const { request } = useAuth();
  const [form, setForm] = useState<GlossaryRevisionInput>(() => ({
    caseSensitive: entry?.caseSensitive ?? false,
    doNotTranslate: entry?.doNotTranslate ?? false,
    notes: entry?.notes ?? '',
    sourceTerm: entry?.sourceTerm ?? '',
    targetTerm: entry?.targetTerm ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const sourceError = validateRequiredText(form.sourceTerm, 'Source term', 200);
  const targetError = form.doNotTranslate
    ? validateOptionalText(form.targetTerm ?? '', 'Target term', 200)
    : validateRequiredText(form.targetTerm ?? '', 'Target term', 200);
  const notesError = validateOptionalText(form.notes ?? '', 'Notes', 1_000);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (sourceError || targetError || notesError) return;
    setSaving(true);
    setConflict(false);
    setErrorMessage(null);
    const input = {
      ...form,
      notes: normalizeOptional(form.notes),
      sourceTerm: form.sourceTerm.normalize('NFC').trim(),
      targetTerm: form.doNotTranslate ? null : normalizeOptional(form.targetTerm),
    };
    try {
      if (entry) {
        await updateGlossaryEntry(request, projectId, trackId, entry.entryId, {
          ...input,
          expectedRevision: entry.selectionRevision!,
        });
      } else {
        await createGlossaryEntry(request, projectId, trackId, input);
      }
      await onSaved();
      toast.success(entry ? 'Glossary term updated.' : 'Glossary term added.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else
        setErrorMessage(error instanceof Error ? error.message : 'Could not save glossary term.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{entry ? 'Edit glossary term' : 'Add glossary term'}</CardTitle>
        <CardDescription>Changes create an immutable revision.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          <FieldGroup>
            <Field data-invalid={Boolean(sourceError)}>
              <FieldLabel htmlFor="glossary-source">Source term</FieldLabel>
              <Input
                id="glossary-source"
                maxLength={201}
                aria-invalid={Boolean(sourceError)}
                disabled={saving}
                value={form.sourceTerm}
                onChange={(event) =>
                  setForm((current) => ({ ...current, sourceTerm: event.target.value }))
                }
              />
              <FieldError>{sourceError}</FieldError>
            </Field>
            <Field data-invalid={Boolean(targetError)} data-disabled={form.doNotTranslate}>
              <FieldLabel htmlFor="glossary-target">Target term</FieldLabel>
              <Input
                id="glossary-target"
                maxLength={201}
                aria-invalid={Boolean(targetError)}
                disabled={saving || form.doNotTranslate}
                value={form.targetTerm ?? ''}
                onChange={(event) =>
                  setForm((current) => ({ ...current, targetTerm: event.target.value }))
                }
              />
              <FieldError>{targetError}</FieldError>
            </Field>
            <Field data-invalid={Boolean(notesError)}>
              <FieldLabel htmlFor="glossary-notes">Notes</FieldLabel>
              <Textarea
                id="glossary-notes"
                maxLength={1_001}
                rows={3}
                aria-invalid={Boolean(notesError)}
                disabled={saving}
                value={form.notes ?? ''}
                onChange={(event) =>
                  setForm((current) => ({ ...current, notes: event.target.value }))
                }
              />
              <FieldError>{notesError}</FieldError>
            </Field>
          </FieldGroup>

          <FieldSet>
            <FieldLegend variant="label">Term behavior</FieldLegend>
            <FieldGroup className="gap-3">
              <Field orientation="horizontal" data-disabled={saving}>
                <Checkbox
                  id="glossary-case-sensitive"
                  checked={form.caseSensitive}
                  disabled={saving}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({ ...current, caseSensitive: checked }))
                  }
                />
                <FieldLabel htmlFor="glossary-case-sensitive" className="font-normal">
                  Case sensitive
                </FieldLabel>
              </Field>
              <Field orientation="horizontal" data-disabled={saving}>
                <Checkbox
                  id="glossary-do-not-translate"
                  checked={form.doNotTranslate}
                  disabled={saving}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({ ...current, doNotTranslate: checked }))
                  }
                />
                <div className="flex flex-col gap-0.5">
                  <FieldLabel htmlFor="glossary-do-not-translate" className="font-normal">
                    Do not translate
                  </FieldLabel>
                  <FieldDescription>
                    Keep the source term unchanged in generated text.
                  </FieldDescription>
                </div>
              </Field>
            </FieldGroup>
          </FieldSet>

          {conflict ? (
            <Alert variant="destructive">
              <AlertTitle>The glossary changed</AlertTitle>
              <AlertDescription>
                Reload the latest glossary entry before editing it again.
                <Button
                  className="mt-3"
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void onReload()}
                >
                  Reload latest
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {errorMessage ? (
            <Alert variant="destructive">
              <AlertTitle>Glossary term was not saved</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || Boolean(sourceError || targetError || notesError)}
            >
              {saving ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              Save term
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function normalizeOptional(value: string | null): string | null {
  const normalized = value?.normalize('NFC').trim() ?? '';
  return normalized || null;
}
