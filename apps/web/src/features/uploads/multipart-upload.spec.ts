import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveCheckpoint, uploadCheckpointKey, type UploadCheckpoint } from './checkpoint-store';
import { uploadMovie } from './multipart-upload';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class SuccessfulXMLHttpRequest extends EventTarget {
  readonly upload = new EventTarget();
  status = 0;
  private url = '';

  abort(): void {
    this.dispatchEvent(new Event('abort'));
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'etag' ? `etag-${this.url.split('/').at(-1)}` : null;
  }

  open(_method: string, url: string): void {
    this.url = url;
  }

  send(blob: Blob): void {
    queueMicrotask(() => {
      const progress = new Event('progress');
      Object.defineProperty(progress, 'loaded', { value: blob.size });
      this.upload.dispatchEvent(progress);
      this.status = 200;
      this.dispatchEvent(new Event('load'));
    });
  }
}

const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6])], 'feature.mp4', {
  lastModified: 1_700_000_000_000,
  type: 'video/mp4',
});
const input = {
  file,
  projectName: 'Feature',
  sourceLanguageId: 'language-en',
  targetLanguageIds: ['language-hi'],
};

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('XMLHttpRequest', SuccessfulXMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createApi(status: 'INITIATED' | 'COMPLETED' | 'FAILED' = 'INITIATED') {
  const calls: string[] = [];
  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    calls.push(path);
    let response: unknown;
    if (path === '/projects') response = { id: 'project-1' };
    else if (path === '/projects/project-1/videos/multipart-uploads') {
      response = {
        id: 'upload-1',
        partSize: 4,
        status: 'INITIATED',
        totalParts: 2,
        video: { id: 'video-1' },
      };
    } else if (path === '/multipart-uploads/upload-1/parts/sign') {
      const body = JSON.parse(String(init?.body)) as { partNumbers: number[] };
      response = {
        parts: body.partNumbers.map((partNumber) => ({
          contentLength: partNumber === 1 ? 4 : 2,
          partNumber,
          url: `https://storage.test/${partNumber}`,
        })),
      };
    } else if (path === '/multipart-uploads/upload-1/complete') {
      response = {
        id: 'upload-1',
        partSize: 4,
        status: 'COMPLETED',
        totalParts: 2,
        video: { id: 'video-1' },
      };
    } else {
      response = {
        id: 'upload-1',
        partSize: 4,
        status,
        totalParts: 2,
        video: { id: 'video-1' },
      };
    }
    return response as T;
  }
  return { api, calls };
}

describe('uploadMovie', () => {
  it('creates a project, uploads parts concurrently, and finalizes the manifest', async () => {
    const harness = createApi();
    const progress = vi.fn();

    await expect(
      uploadMovie({
        api: harness.api,
        input,
        onProgress: progress,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ projectId: 'project-1', uploadId: 'upload-1', videoId: 'video-1' });

    expect(harness.calls).toContain('/multipart-uploads/upload-1/parts/sign');
    expect(harness.calls.at(-1)).toBe('/multipart-uploads/upload-1/complete');
    expect(progress).toHaveBeenLastCalledWith({
      completedBytes: file.size,
      percentage: 100,
      totalBytes: file.size,
    });
  });

  it('resumes from completed parts without creating duplicate records', async () => {
    const harness = createApi();
    const key = await uploadCheckpointKey(input);
    const checkpoint: UploadCheckpoint = {
      completedParts: [{ byteSize: 4, etag: 'etag-1', partNumber: 1 }],
      idempotencyKey: 'upload-key-0001',
      projectId: 'project-1',
      updatedAt: new Date().toISOString(),
      uploadId: 'upload-1',
      version: 1,
    };
    saveCheckpoint(key, checkpoint);

    await uploadMovie({
      api: harness.api,
      input,
      onProgress: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(harness.calls).not.toContain('/projects');
    expect(harness.calls).not.toContain('/projects/project-1/videos/multipart-uploads');
  });

  it('short-circuits a server-confirmed completion', async () => {
    const harness = createApi('COMPLETED');
    const key = await uploadCheckpointKey(input);
    saveCheckpoint(key, {
      completedParts: [],
      idempotencyKey: 'upload-key-0001',
      projectId: 'project-1',
      updatedAt: new Date().toISOString(),
      uploadId: 'upload-1',
      version: 1,
    });

    await expect(
      uploadMovie({
        api: harness.api,
        input,
        onProgress: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ videoId: 'video-1' });
    expect(harness.calls).toEqual(['/multipart-uploads/upload-1']);
  });

  it('rejects a checkpoint whose server-side upload is no longer resumable', async () => {
    const harness = createApi('FAILED');
    const key = await uploadCheckpointKey(input);
    saveCheckpoint(key, {
      completedParts: [],
      idempotencyKey: 'upload-key-0001',
      projectId: 'project-1',
      updatedAt: new Date().toISOString(),
      uploadId: 'upload-1',
      version: 1,
    });

    await expect(
      uploadMovie({
        api: harness.api,
        input,
        onProgress: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/no longer resumable/);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('honors cancellation before requesting signed part URLs', async () => {
    const harness = createApi();
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadMovie({
        api: harness.api,
        input,
        onProgress: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.calls).not.toContain('/multipart-uploads/upload-1/parts/sign');
  });
});
