import { isWalletAsset, type ApiErrorBody, type ErrorCode, type WalletAsset } from '@gudex/shared';

// API на том же домене, что и Mini App (на Vercel), локально — через прокси Vite.

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'network',
    message: string,
    readonly status: number,
    readonly attemptsLeft?: number,
    readonly lockedUntil?: string,
    readonly minAmount?: string,
    readonly asset?: WalletAsset,
  ) {
    super(message);
  }
}

export function minimumAmountDetails(error: unknown): { minAmount: string; asset: WalletAsset } | null {
  if (!(error instanceof ApiError) || error.code !== 'amount_too_small' || !isWalletAsset(error.asset) ||
    !error.minAmount || !/^\d{1,24}(?:\.\d{1,6})?$/.test(error.minAmount) || Number(error.minAmount) <= 0) return null;
  return { minAmount: error.minAmount, asset: error.asset };
}

let accessToken: string | null = null;
let authGeneration = 0;
let onSessionLost: (code: 'unauthorized' | 'unlock_required') => void = () => {};

export const session = {
  set(token: string | null) {
    accessToken = token;
    authGeneration++;
  },
  onLost(handler: typeof onSessionLost) {
    onSessionLost = handler;
  },
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: object;
  headers?: Record<string, string>;
  cache?: 'no-store';
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body } = options;
  const requestGeneration = authGeneration;
  const requestToken = accessToken;
  const headers: Record<string, string> = { ...options.headers };
  if (body) headers['Content-Type'] = 'application/json';
  if (requestToken) headers.Authorization = `Bearer ${requestToken}`;

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: options.cache, signal: options.signal });
  } catch {
    throw new ApiError('network', 'Network error', 0);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (data as ApiErrorBody | null)?.error;
    const code = error?.code ?? 'internal';
    // Ответ старого запроса не должен сбрасывать сессию, уже обновлённую сменой PIN/входом.
    if (requestGeneration === authGeneration && (code === 'unauthorized' || code === 'unlock_required')) onSessionLost(code);
    throw new ApiError(code, error?.message ?? `HTTP ${res.status}`, res.status, error?.attemptsLeft, error?.lockedUntil, error?.minAmount, error?.asset);
  }
  return data as T;
}
