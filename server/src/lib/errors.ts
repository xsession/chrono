// Error model for the Chrono Next TypeScript backend.
//
// The original Rust backend used a thiserror `AppError` enum that serialized
// to a plain string. We mirror that with a single class plus a `kind` so the
// HTTP layer can map failures to sensible status codes, while the message text
// matches what the UI already displays.

export type AppErrorKind =
  | "io"
  | "json"
  | "http"
  | "command"
  | "invalid"
  | "unsupported";

export class AppError extends Error {
  readonly kind: AppErrorKind;

  constructor(kind: AppErrorKind, message: string) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
  }
}

export const ioError = (message: string): AppError => new AppError("io", message);
export const jsonError = (message: string): AppError => new AppError("json", message);
export const httpError = (message: string): AppError => new AppError("http", message);
export const commandError = (message: string): AppError => new AppError("command", message);
export const invalidError = (message: string): AppError => new AppError("invalid", message);
export const unsupportedError = (message: string): AppError => new AppError("unsupported", message);

// Map an AppError to an HTTP status code for the JSON response.
export function statusCodeFor(error: unknown): number {
  if (error instanceof AppError) {
    switch (error.kind) {
      case "invalid":
        return 400;
      case "unsupported":
        return 501;
      case "http":
        return 502;
      default:
        return 500;
    }
  }
  return 500;
}
