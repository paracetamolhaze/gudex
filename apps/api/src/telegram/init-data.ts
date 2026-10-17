import { createHmac, timingSafeEqual } from 'node:crypto';

// Проверка initData, которую Telegram передаёт в Mini App.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export class InitDataError extends Error {}

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function signInitData(params: URLSearchParams, botToken: string): string {
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString(params)).digest('hex');
}

export function verifyInitData(
  initData: string,
  botToken: string,
  options: { maxAgeSeconds?: number; now?: Date } = {},
): TelegramUser {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new InitDataError('hash is missing');

  const expected = Buffer.from(signInitData(params, botToken), 'hex');
  const received = Buffer.from(hash, 'hex');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new InitDataError('signature mismatch');
  }

  const authDate = Number(params.get('auth_date'));
  const now = (options.now ?? new Date()).getTime() / 1000;
  if (!Number.isFinite(authDate) || now - authDate > (options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS)) {
    throw new InitDataError('init data expired');
  }

  const rawUser = params.get('user');
  if (!rawUser) throw new InitDataError('user is missing');
  const user = JSON.parse(rawUser) as TelegramUser;
  if (typeof user.id !== 'number') throw new InitDataError('user id is missing');
  return user;
}
