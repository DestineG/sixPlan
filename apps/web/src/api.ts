import type { ApiError } from '@sixplan/shared';

export class ApiClientError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ code: 'REQUEST_FAILED', message: '请求失败' })) as ApiError;
    throw new ApiClientError(response.status, error.code, error.message, error.details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function downloadFile(path: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ code: 'DOWNLOAD_FAILED', message: '下载失败' })) as ApiError;
    throw new ApiClientError(response.status, error.code, error.message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const basicMatch = disposition.match(/filename="?([^";]+)"?/i);
  const filename = utf8Match ? decodeURIComponent(utf8Match[1]!) : (basicMatch?.[1] ?? 'download');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

export async function uploadBackup(path: string, file: File, password?: string): Promise<void> {
  const form = new FormData();
  if (password) form.append('password', password);
  form.append('file', file);
  await api(path, { method: 'POST', body: form });
}
