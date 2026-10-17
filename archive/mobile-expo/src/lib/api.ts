import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { ApiErrorBody, AuthTokens, ErrorCode } from '@gudex/shared';
import { storage } from './storage';

const API_PORT = 4100;

// Телефон с Expo Go ходит на компьютер разработчика по адресу, с которого загрузился бандл.
function resolveApiUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${API_PORT}`;
  }
  const host = Constants.expoConfig?.hostUri?.split(':')[0] ?? 'localhost';
  return `http://${host}:${API_PORT}`;
}

export const API_URL = resolveApiUrl();

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'network',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const TOKENS_KEY = 'gudex.tokens';

let tokens: AuthTokens | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: () => void = () => {};

export const session = {
  async load(): Promise<boolean> {
    const raw = await storage.get(TOKENS_KEY);
    tokens = raw ? (JSON.parse(raw) as AuthTokens) : null;
    return tokens !== null;
  },
  async save(next: AuthTokens): Promise<void> {
    tokens = next;
    await storage.set(TOKENS_KEY, JSON.stringify(next));
  },
  async clear(): Promise<void> {
    tokens = null;
    await storage.remove(TOKENS_KEY);
  },
  refreshToken: () => tokens?.refreshToken ?? null,
  setSignedOutHandler(handler: () => void) {
    onSignedOut = handler;
  },
};

async function refreshTokens(): Promise<boolean> {
  const refreshToken = tokens?.refreshToken;
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    await session.save((await res.json()) as AuthTokens);
    return true;
  } catch {
    return false;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: object;
  auth?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}, retried = false): Promise<T> {
  const { method = 'GET', body, auth = true } = options;
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth && tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('network', 'Network error', 0);
  }

  if (res.status === 401 && auth && !retried) {
    // Один общий refresh на все параллельные запросы.
    refreshing ??= refreshTokens().finally(() => {
      refreshing = null;
    });
    if (await refreshing) return request<T>(path, options, true);
    await session.clear();
    onSignedOut();
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (data as ApiErrorBody | null)?.error;
    throw new ApiError(error?.code ?? 'internal', error?.message ?? `HTTP ${res.status}`, res.status);
  }
  return data as T;
}
