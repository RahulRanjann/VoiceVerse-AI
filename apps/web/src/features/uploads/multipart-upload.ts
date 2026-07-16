import {
  loadCheckpoint,
  removeCheckpoint,
  saveCheckpoint,
  uploadCheckpointKey,
  type UploadCheckpoint,
} from './checkpoint-store';

interface ProjectResponse {
  id: string;
}

interface MultipartUploadResponse {
  id: string;
  partSize: number;
  status: 'INITIATED' | 'COMPLETING' | 'COMPLETED' | 'ABORTED' | 'EXPIRED' | 'FAILED';
  totalParts: number;
  video: { id: string };
}

interface SignedPartsResponse {
  parts: Array<{ contentLength: number; partNumber: number; url: string }>;
}

export interface UploadMovieInput {
  file: File;
  projectName: string;
  sourceLanguageId: string;
  targetLanguageIds: string[];
}

export interface UploadProgressSnapshot {
  completedBytes: number;
  percentage: number;
  totalBytes: number;
}

export interface UploadMovieResult {
  projectId: string;
  uploadId: string;
  videoId: string;
}

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export async function uploadMovie(options: {
  api: ApiRequest;
  input: UploadMovieInput;
  signal: AbortSignal;
  onProgress(snapshot: UploadProgressSnapshot): void;
}): Promise<UploadMovieResult> {
  const { api, input, signal, onProgress } = options;
  const checkpointKey = await uploadCheckpointKey(input);
  let checkpoint = loadCheckpoint(checkpointKey) ?? newCheckpoint();
  checkpoint = await ensureProject(api, input, checkpointKey, checkpoint);
  checkpoint = await ensureMultipartUpload(api, input.file, checkpointKey, checkpoint);

  if (!checkpoint.projectId || !checkpoint.uploadId) {
    throw new Error('Upload checkpoint could not be initialized.');
  }
  let upload = await api<MultipartUploadResponse>(`/multipart-uploads/${checkpoint.uploadId}`);
  if (upload.status === 'COMPLETED') {
    removeCheckpoint(checkpointKey);
    return { projectId: checkpoint.projectId, uploadId: upload.id, videoId: upload.video.id };
  }
  if (!['INITIATED', 'COMPLETING'].includes(upload.status)) {
    removeCheckpoint(checkpointKey);
    throw new Error('The previous upload is no longer resumable. Start the transfer again.');
  }

  const completed = new Map(
    checkpoint.completedParts.map((part) => [part.partNumber, part] as const),
  );
  const missingPartNumbers = Array.from(
    { length: upload.totalParts },
    (_, index) => index + 1,
  ).filter((partNumber) => !completed.has(partNumber));
  const completedBytes = () =>
    Array.from(completed.values()).reduce((sum, part) => sum + part.byteSize, 0);
  onProgress({
    completedBytes: completedBytes(),
    percentage: Math.round((completedBytes() / input.file.size) * 100),
    totalBytes: input.file.size,
  });

  for (let offset = 0; offset < missingPartNumbers.length; offset += 12) {
    throwIfAborted(signal);
    const partNumbers = missingPartNumbers.slice(offset, offset + 12);
    const signed = await api<SignedPartsResponse>(`/multipart-uploads/${upload.id}/parts/sign`, {
      body: JSON.stringify({ partNumbers }),
      method: 'POST',
    });
    const inFlight = new Map<number, number>();
    await runConcurrent(signed.parts, 4, async (part) => {
      const start = (part.partNumber - 1) * upload.partSize;
      const blob = input.file.slice(start, start + part.contentLength);
      const etag = await uploadPartWithRetry(part.url, blob, signal, (loaded) => {
        inFlight.set(part.partNumber, loaded);
        const transferred =
          completedBytes() + Array.from(inFlight.values()).reduce((sum, value) => sum + value, 0);
        onProgress({
          completedBytes: transferred,
          percentage: Math.min(99, Math.round((transferred / input.file.size) * 100)),
          totalBytes: input.file.size,
        });
      });
      inFlight.delete(part.partNumber);
      completed.set(part.partNumber, {
        byteSize: part.contentLength,
        etag,
        partNumber: part.partNumber,
      });
      checkpoint = { ...checkpoint, completedParts: Array.from(completed.values()) };
      saveCheckpoint(checkpointKey, checkpoint);
    });
  }

  upload = await api<MultipartUploadResponse>(`/multipart-uploads/${upload.id}/complete`, {
    body: JSON.stringify({
      parts: Array.from(completed.values()).sort(
        (left, right) => left.partNumber - right.partNumber,
      ),
    }),
    method: 'POST',
  });
  removeCheckpoint(checkpointKey);
  onProgress({ completedBytes: input.file.size, percentage: 100, totalBytes: input.file.size });
  return { projectId: checkpoint.projectId, uploadId: upload.id, videoId: upload.video.id };
}

function newCheckpoint(): UploadCheckpoint {
  return {
    completedParts: [],
    idempotencyKey: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
}

async function ensureProject(
  api: ApiRequest,
  input: UploadMovieInput,
  key: string,
  checkpoint: UploadCheckpoint,
): Promise<UploadCheckpoint> {
  if (checkpoint.projectId) return checkpoint;
  const project = await api<ProjectResponse>('/projects', {
    body: JSON.stringify({
      name: input.projectName.trim(),
      sourceLanguageId: input.sourceLanguageId,
      targetLanguageIds: input.targetLanguageIds,
    }),
    method: 'POST',
  });
  const next = { ...checkpoint, projectId: project.id };
  saveCheckpoint(key, next);
  return next;
}

async function ensureMultipartUpload(
  api: ApiRequest,
  file: File,
  key: string,
  checkpoint: UploadCheckpoint,
): Promise<UploadCheckpoint> {
  if (checkpoint.uploadId) return checkpoint;
  if (!checkpoint.projectId) throw new Error('Project must exist before upload creation.');
  const upload = await api<MultipartUploadResponse>(
    `/projects/${checkpoint.projectId}/videos/multipart-uploads`,
    {
      body: JSON.stringify({
        byteSize: file.size,
        filename: file.name,
        mediaType: file.type || 'video/mp4',
      }),
      headers: { 'Idempotency-Key': checkpoint.idempotencyKey },
      method: 'POST',
    },
  );
  const next = { ...checkpoint, uploadId: upload.id };
  saveCheckpoint(key, next);
  return next;
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const item = items[index++];
      if (item) await task(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

async function uploadPartWithRetry(
  url: string,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await uploadPart(url, blob, signal, onProgress);
    } catch (error) {
      lastError = error;
      if (signal.aborted || attempt === 3 || !(error instanceof RetryableUploadError)) throw error;
      await wait(400 * 2 ** (attempt - 1) + Math.random() * 250, signal);
    }
  }
  throw lastError;
}

function uploadPart(
  url: string,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    request.open('PUT', url);
    request.upload.addEventListener('progress', (event) => onProgress(event.loaded));
    request.addEventListener('load', () => {
      cleanup();
      if (request.status < 200 || request.status >= 300) {
        const error = new Error(`Part upload failed with status ${request.status}.`);
        reject(request.status >= 500 ? new RetryableUploadError(error.message) : error);
        return;
      }
      const etag = request.getResponseHeader('ETag');
      if (!etag) {
        reject(new Error('Object storage did not expose the uploaded part ETag.'));
        return;
      }
      resolve(etag);
    });
    request.addEventListener('error', () => {
      cleanup();
      reject(new RetryableUploadError('The part upload encountered a network error.'));
    });
    request.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Upload paused.', 'AbortError'));
    });
    signal.addEventListener('abort', abort, { once: true });
    request.send(blob);
  });
}

class RetryableUploadError extends Error {}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Upload paused.', 'AbortError');
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException('Upload paused.', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
