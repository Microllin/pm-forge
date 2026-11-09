/**
 * 对外的错误形状：`{ error: { code, message } }`。message 给人看（中文），
 * code 给前端分支用。
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function notFound(message: string): HttpError {
  return new HttpError(404, "NOT_FOUND", message);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, "BAD_REQUEST", message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, "CONFLICT", message);
}
