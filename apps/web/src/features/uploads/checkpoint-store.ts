export interface CompletedUploadPart {
  byteSize: number;
  etag: string;
  partNumber: number;
}

export interface UploadCheckpoint {
  version: 1;
  idempotencyKey: string;
  projectId?: string;
  uploadId?: string;
  completedParts: CompletedUploadPart[];
  updatedAt: string;
}

const prefix = 'voiceverse:multipart:v1:';

export async function uploadCheckpointKey(input: {
  file: File;
  projectName: string;
  sourceLanguageId: string;
  targetLanguageIds: string[];
}): Promise<string> {
  const identity = JSON.stringify({
    file: {
      lastModified: input.file.lastModified,
      name: input.file.name,
      size: input.file.size,
      type: input.file.type,
    },
    projectName: input.projectName.trim(),
    sourceLanguageId: input.sourceLanguageId,
    targetLanguageIds: [...input.targetLanguageIds].sort(),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `${prefix}${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function loadCheckpoint(key: string): UploadCheckpoint | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<UploadCheckpoint>;
    if (
      value.version !== 1 ||
      typeof value.idempotencyKey !== 'string' ||
      !Array.isArray(value.completedParts)
    ) {
      localStorage.removeItem(key);
      return null;
    }
    return value as UploadCheckpoint;
  } catch {
    return null;
  }
}

export function saveCheckpoint(key: string, checkpoint: UploadCheckpoint): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The active
    // upload remains functional; only cross-refresh resume is unavailable.
  }
}

export function removeCheckpoint(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // The server-side multipart lifecycle still expires abandoned uploads.
  }
}
