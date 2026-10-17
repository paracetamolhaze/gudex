import type { ErrorCode } from '@gudex/shared';
import type { ZodType } from 'zod';

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  not_found: 404,
  telegram_auth_failed: 401,
  pin_required: 403,
  pin_invalid: 403,
  pin_locked: 423,
  unlock_required: 403,
  kyc_required: 403,
  kyc_already_submitted: 409,
  insufficient_funds: 422,
  card_limit: 422,
  card_not_active: 422,
  billing_address_required: 422,
  card_region_restricted: 422,
  quote_changed: 409,
  amount_too_small: 422,
  invalid_address: 400,
  recipient_not_found: 404,
  self_transfer: 422,
  provider_unavailable: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string = code,
    // Доп. поля для клиента, например attemptsLeft при неверном коде.
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AppError('validation', issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid request');
  }
  return result.data;
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
