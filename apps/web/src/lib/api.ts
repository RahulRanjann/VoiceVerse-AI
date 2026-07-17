export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3001/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiResponse<T> {
  data: T | null;
  etag: string | null;
  notModified: boolean;
  status: number;
}

export async function apiRequestResult<T>(
  path: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<ApiResponse<T>> {
  const response = await executeRequest(path, init, accessToken);
  if (response.status === 304) {
    return {
      data: null,
      etag: response.headers.get('etag'),
      notModified: true,
      status: response.status,
    };
  }
  await assertSuccessful(response);
  return {
    data: response.status === 204 ? null : ((await response.json()) as T),
    etag: response.headers.get('etag'),
    notModified: false,
    status: response.status,
  };
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const result = await apiRequestResult<T>(path, init, accessToken);
  if (result.notModified) {
    throw new ApiError(304, 'The requested resource has not changed.');
  }
  if (result.status === 204) return undefined as T;
  return result.data as T;
}

async function executeRequest(
  path: string,
  init: RequestInit,
  accessToken?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    // Authentication is an explicit bearer token. Never attach ambient
    // browser cookies to the cross-origin business API.
    credentials: 'omit',
    headers,
  });
}

async function assertSuccessful(response: Response): Promise<void> {
  if (!response.ok) {
    let message = `Request failed with status ${response.status}.`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (typeof body.message === 'string') message = body.message;
      if (Array.isArray(body.message)) message = body.message.join(' ');
    } catch {
      // A non-JSON upstream error still receives a stable, non-sensitive message.
    }
    throw new ApiError(response.status, message);
  }
}
