import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadCheckpoint,
  removeCheckpoint,
  saveCheckpoint,
  uploadCheckpointKey,
  type UploadCheckpoint,
} from './checkpoint-store';

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

const checkpoint: UploadCheckpoint = {
  completedParts: [{ byteSize: 10, etag: 'etag-1', partNumber: 1 }],
  idempotencyKey: 'upload-key-0001',
  projectId: 'project-1',
  updatedAt: '2026-07-16T00:00:00.000Z',
  version: 1,
};

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('multipart checkpoint store', () => {
  it('derives a stable key independent of target-language order and whitespace', async () => {
    const file = new File(['movie'], 'feature.mp4', {
      lastModified: 1_700_000_000_000,
      type: 'video/mp4',
    });
    const first = await uploadCheckpointKey({
      file,
      projectName: '  Film  ',
      sourceLanguageId: 'en',
      targetLanguageIds: ['ta', 'hi'],
    });
    const second = await uploadCheckpointKey({
      file,
      projectName: 'Film',
      sourceLanguageId: 'en',
      targetLanguageIds: ['hi', 'ta'],
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^voiceverse:multipart:v1:[0-9a-f]{64}$/);
  });

  it('persists, loads, and removes a valid checkpoint', () => {
    saveCheckpoint('upload', checkpoint);

    expect(loadCheckpoint('upload')).toMatchObject({
      ...checkpoint,
      updatedAt: expect.any(String),
    });
    removeCheckpoint('upload');
    expect(loadCheckpoint('upload')).toBeNull();
  });

  it('deletes structurally invalid checkpoint data', () => {
    localStorage.setItem('invalid', JSON.stringify({ version: 2 }));

    expect(loadCheckpoint('invalid')).toBeNull();
    expect(localStorage.getItem('invalid')).toBeNull();
  });

  it('keeps the active upload functional when browser storage is unavailable', () => {
    const unavailable = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
    };
    vi.stubGlobal('localStorage', unavailable);

    expect(() => saveCheckpoint('upload', checkpoint)).not.toThrow();
    expect(loadCheckpoint('upload')).toBeNull();
    expect(() => removeCheckpoint('upload')).not.toThrow();
  });
});
