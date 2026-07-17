export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface CreateMultipartObject {
  bucket: string;
  key: string;
  mediaType: string;
  metadata: Record<string, string>;
}

export interface SignMultipartPart {
  bucket: string;
  contentLength: number;
  key: string;
  partNumber: number;
  providerUploadId: string;
}

export interface CompleteMultipartObject {
  bucket: string;
  key: string;
  parts: Array<{ etag: string; partNumber: number }>;
  providerUploadId: string;
}

export interface StoredObjectMetadata {
  byteSize: number;
  etag?: string;
  mediaType?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface PutImmutableObject {
  body: Uint8Array;
  bucket: string;
  key: string;
  mediaType: string;
  metadata: Record<string, string>;
  sha256: string;
}

/**
 * Provider implementations must normalize provider/transport failures as
 * ObjectStorageUnavailableError so HTTP and worker callers can apply their own
 * retry and presentation policies without depending on an SDK error model.
 */
export interface ObjectStoragePort {
  ping(bucket: string): Promise<void>;
  createMultipartUpload(input: CreateMultipartObject): Promise<string>;
  signUploadPart(input: SignMultipartPart): Promise<string>;
  completeMultipartUpload(input: CompleteMultipartObject): Promise<{ etag?: string }>;
  abortMultipartUpload(input: {
    bucket: string;
    key: string;
    providerUploadId: string;
  }): Promise<void>;
  headObject(input: { bucket: string; key: string }): Promise<StoredObjectMetadata>;
  getObjectStream(input: { bucket: string; key: string }): Promise<AsyncIterable<Uint8Array>>;
  putImmutableObject(input: PutImmutableObject): Promise<void>;
}
