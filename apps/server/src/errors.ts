export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function assertFound<T>(value: T | undefined | null, message = '资源不存在'): T {
  if (value === undefined || value === null) throw new AppError(404, 'NOT_FOUND', message);
  return value;
}
