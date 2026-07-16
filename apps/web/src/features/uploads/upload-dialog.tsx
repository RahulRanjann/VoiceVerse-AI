'use client';

import { FileVideoIcon, PauseIcon, ShieldCheckIcon, UploadCloudIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/features/auth/auth-provider';
import type { LanguageOption } from '@/features/studio/types';
import { uploadMovie, type UploadProgressSnapshot } from './multipart-upload';

interface UploadDialogProps {
  languages: LanguageOption[];
  onCompleted(): void | Promise<void>;
  onOpenChange(open: boolean): void;
  open: boolean;
}

type UploadPhase = 'idle' | 'uploading' | 'paused' | 'failed' | 'complete';

export function UploadDialog({ languages, onCompleted, onOpenChange, open }: UploadDialogProps) {
  const { request } = useAuth();
  const [projectName, setProjectName] = useState('');
  const [sourceLanguageId, setSourceLanguageId] = useState('');
  const [targetLanguageIds, setTargetLanguageIds] = useState<string[]>([]);
  const [file, setFile] = useState<File>();
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [progress, setProgress] = useState<UploadProgressSnapshot>({
    completedBytes: 0,
    percentage: 0,
    totalBytes: 0,
  });
  const controller = useRef<AbortController | null>(null);

  const defaultSourceLanguageId =
    languages.find((language) => language.bcp47Tag === 'en')?.id ?? languages[0]?.id ?? '';
  const effectiveSourceLanguageId = sourceLanguageId || defaultSourceLanguageId;

  const selectItems = useMemo(
    () => languages.map((language) => ({ label: language.englishName, value: language.id })),
    [languages],
  );
  const targetItems = useMemo(
    () => selectItems.filter((language) => language.value !== effectiveSourceLanguageId),
    [effectiveSourceLanguageId, selectItems],
  );
  const selectedTargets = targetLanguageIds
    .map((id) => languages.find((language) => language.id === id))
    .filter((language): language is LanguageOption => Boolean(language));

  async function beginUpload() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!file) return;

    const nextController = new AbortController();
    controller.current = nextController;
    setError(undefined);
    setPhase('uploading');
    try {
      await uploadMovie({
        api: request,
        input: {
          file,
          projectName,
          sourceLanguageId: effectiveSourceLanguageId,
          targetLanguageIds,
        },
        onProgress: (snapshot) => {
          setProgress(snapshot);
        },
        signal: nextController.signal,
      });
      setPhase('complete');
      toast.success('Upload complete. Malware scanning has started.');
      await onCompleted();
      onOpenChange(false);
      reset();
    } catch (uploadError) {
      if (uploadError instanceof DOMException && uploadError.name === 'AbortError') {
        setPhase('paused');
        toast('Upload paused. Choose Continue upload to resume.');
      } else {
        setPhase('failed');
        setError(
          uploadError instanceof Error ? uploadError.message : 'The upload could not continue.',
        );
      }
    } finally {
      controller.current = null;
    }
  }

  function validate(): string | undefined {
    if (!projectName.trim()) return 'Enter a project name.';
    if (!effectiveSourceLanguageId) return 'Choose the source language.';
    if (targetLanguageIds.length === 0) return 'Choose at least one target language.';
    if (!file) return 'Choose an MP4 file.';
    if (file.type && file.type !== 'video/mp4')
      return 'VoiceVerse currently accepts MP4 files only.';
    if (!file.name.toLowerCase().endsWith('.mp4'))
      return 'The source file must use the .mp4 extension.';
    if (file.size > 21_474_836_480) return 'The source file exceeds the current 20 GB limit.';
    return undefined;
  }

  function chooseFile(nextFile: File | undefined) {
    if (!nextFile) return;
    setFile(nextFile);
    setProgress({ completedBytes: 0, percentage: 0, totalBytes: nextFile.size });
    setError(undefined);
    if (phase !== 'idle') setPhase('idle');
  }

  function reset() {
    setProjectName('');
    setTargetLanguageIds([]);
    setFile(undefined);
    setError(undefined);
    setPhase('idle');
    setProgress({ completedBytes: 0, percentage: 0, totalBytes: 0 });
  }
  const uploading = phase === 'uploading';

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !uploading && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Upload movie</DialogTitle>
          <DialogDescription>
            Create a project and transfer the original file directly to secure storage.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field data-invalid={Boolean(error && !projectName.trim())}>
            <FieldLabel htmlFor="project-name">Project name</FieldLabel>
            <Input
              id="project-name"
              value={projectName}
              maxLength={160}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="Monsoon Letters"
              disabled={uploading}
            />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="source-language">Source language</FieldLabel>
              <Select
                items={selectItems}
                value={effectiveSourceLanguageId || null}
                onValueChange={(value) => {
                  const nextValue = value ?? '';
                  setSourceLanguageId(nextValue);
                  setTargetLanguageIds((current) => current.filter((id) => id !== nextValue));
                }}
                disabled={uploading}
              >
                <SelectTrigger id="source-language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {languages.map((language) => (
                      <SelectItem key={language.id} value={language.id}>
                        {language.englishName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="target-languages">Target languages</FieldLabel>
              <Select
                items={targetItems}
                multiple
                value={targetLanguageIds}
                onValueChange={(value) => setTargetLanguageIds(value)}
                disabled={uploading}
              >
                <SelectTrigger id="target-languages" className="w-full">
                  <SelectValue>
                    {(value: string[]) =>
                      value.length === 0 ? 'Choose languages' : `${value.length} selected`
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {targetItems.map((language) => (
                      <SelectItem key={language.value} value={language.value}>
                        {language.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {selectedTargets.length > 0 && (
                <div className="flex flex-wrap gap-1.5" aria-label="Selected target languages">
                  {selectedTargets.map((language) => (
                    <Badge key={language.id} variant="secondary">
                      {language.englishName}
                    </Badge>
                  ))}
                </div>
              )}
            </Field>
          </div>

          <Field data-invalid={Boolean(error && !file)}>
            <FieldLabel htmlFor="movie-file">MP4 file</FieldLabel>
            <label
              htmlFor="movie-file"
              className="flex min-h-32 w-full items-center gap-4 rounded-xl border border-dashed border-input bg-muted/25 p-4 transition-colors hover:border-primary/60 hover:bg-primary/5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                chooseFile(event.dataTransfer.files[0]);
              }}
            >
              <Input
                id="movie-file"
                className="sr-only"
                type="file"
                accept="video/mp4,.mp4"
                disabled={uploading}
                onChange={(event) => chooseFile(event.target.files?.[0])}
              />
              <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
                {file ? (
                  <FileVideoIcon aria-hidden="true" className="size-6" />
                ) : (
                  <UploadCloudIcon aria-hidden="true" className="size-6" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {file?.name ?? 'Drop an MP4 here or choose a file'}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {file ? formatBytes(file.size) : 'Secure, resumable transfer · up to 20 GB'}
                </span>
              </span>
            </label>
            <FieldDescription>
              File bytes go directly to private object storage and never pass through the web
              server.
            </FieldDescription>
          </Field>

          {(uploading || phase === 'paused' || phase === 'failed') && file && (
            <Progress value={progress.percentage} aria-label="Upload progress">
              <ProgressLabel>
                {phase === 'paused' ? 'Upload paused' : 'Secure upload'}
              </ProgressLabel>
              <ProgressValue>{() => `${progress.percentage}%`}</ProgressValue>
              <p className="w-full text-xs text-muted-foreground">
                {formatBytes(progress.completedBytes)} of {formatBytes(progress.totalBytes)}
              </p>
            </Progress>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Alert>
            <ShieldCheckIcon aria-hidden="true" />
            <AlertDescription>
              Files stay quarantined until malware scanning is complete.
            </AlertDescription>
          </Alert>
        </FieldGroup>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (uploading) {
                controller.current?.abort();
              } else {
                onOpenChange(false);
              }
            }}
          >
            {uploading && <PauseIcon data-icon="inline-start" />}
            {uploading ? 'Pause upload' : 'Cancel'}
          </Button>
          <Button onClick={() => void beginUpload()} disabled={uploading || phase === 'complete'}>
            <UploadCloudIcon data-icon="inline-start" />
            Continue upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
