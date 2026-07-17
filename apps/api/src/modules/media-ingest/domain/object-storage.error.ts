export const OBJECT_STORAGE_UNAVAILABLE_CODE = 'OBJECT_STORAGE_UNAVAILABLE' as const;
export const OBJECT_STORAGE_UNAVAILABLE_MESSAGE =
  'Object storage is temporarily unavailable. Please retry.' as const;

export type ObjectStorageOperation =
  | 'abort-multipart-upload'
  | 'complete-multipart-upload'
  | 'create-multipart-upload'
  | 'get-object-stream'
  | 'head-object'
  | 'ping'
  | 'put-immutable-object'
  | 'sign-upload-part';

/**
 * Provider-neutral failure raised by object-storage adapters.
 *
 * The public message is intentionally stable and contains no provider details.
 * `cause` is retained only for structured server-side diagnostics and must never
 * be serialized into an HTTP response.
 */
export class ObjectStorageUnavailableError extends Error {
  readonly code = OBJECT_STORAGE_UNAVAILABLE_CODE;

  constructor(
    readonly operation: ObjectStorageOperation,
    override readonly cause?: unknown,
  ) {
    super(OBJECT_STORAGE_UNAVAILABLE_MESSAGE);
    this.name = 'ObjectStorageUnavailableError';
  }
}
