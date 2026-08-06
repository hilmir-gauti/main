/**
 * Application error types.
 *
 * `AppError` carries an HTTP status and a message that is safe to show a
 * customer — messages are written in Icelandic because they surface on public
 * booking pages and in phone/SMS replies.
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  /** Safe to display to an end user (not just the operator). */
  readonly publicMessage: string;

  constructor(
    status: number,
    code: string,
    publicMessage: string,
    options: { details?: Record<string, unknown>; internalMessage?: string; cause?: unknown } = {},
  ) {
    super(options.internalMessage ?? publicMessage, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.details = options.details;
  }
}

export const badRequest = (msg: string, details?: Record<string, unknown>) =>
  new AppError(400, 'ogild_beidni', msg, { details });

export const unauthorized = (msg = 'Innskráning nauðsynleg.') =>
  new AppError(401, 'oheimilt', msg);

export const forbidden = (msg = 'Aðgangur ekki heimilaður.') =>
  new AppError(403, 'bannad', msg);

export const notFound = (msg = 'Fannst ekki.') =>
  new AppError(404, 'fannst_ekki', msg);

export const conflict = (msg: string, details?: Record<string, unknown>) =>
  new AppError(409, 'arekstur', msg, { details });

export const tooManyRequests = (msg = 'Of margar beiðnir. Reyndu aftur eftir smástund.') =>
  new AppError(429, 'of_margar_beidnir', msg);

export const internal = (internalMessage: string, cause?: unknown) =>
  new AppError(500, 'villa', 'Óvænt villa kom upp. Reyndu aftur síðar.', { internalMessage, cause });

/** Raised when an external provider (Google, Twilio, SMTP…) misbehaves. */
export class IntegrationError extends AppError {
  readonly provider: string;
  constructor(provider: string, internalMessage: string, options: { status?: number; cause?: unknown; details?: Record<string, unknown> } = {}) {
    super(options.status ?? 502, 'ytri_thjonusta', `Ytri þjónusta (${provider}) svaraði ekki rétt.`, {
      internalMessage: `[${provider}] ${internalMessage}`,
      cause: options.cause,
      details: options.details,
    });
    this.name = 'IntegrationError';
    this.provider = provider;
  }
}

/** Field-level validation failure, aggregated so forms can show every problem at once. */
export class ValidationError extends AppError {
  readonly fieldErrors: Record<string, string>;
  constructor(fieldErrors: Record<string, string>, msg = 'Sumar upplýsingar vantar eða eru rangar.') {
    super(422, 'ogild_gogn', msg, { details: fieldErrors });
    this.name = 'ValidationError';
    this.fieldErrors = fieldErrors;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Normalises anything thrown into an AppError so handlers stay simple. */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (err instanceof Error) return internal(err.message, err);
  return internal(String(err));
}
