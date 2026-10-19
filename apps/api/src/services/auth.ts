import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { type BiometricTokenDto, type ConfirmationDto, type Locale, type SessionDto, TERMS_VERSION } from '@gudex/shared';
import type { Config } from '../config';
import type { Db, Tx } from '../db/client';
import { biometricTokens, kycProfiles, users } from '../db/schema';
import { AppError } from '../lib/errors';
import { enqueue } from '../queue/queue';
import { InitDataError, type TelegramUser, verifyInitData } from '../telegram/init-data';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const CONFIRMATION_TTL_SECONDS = 2 * 60;
export const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

// Для языков СНГ по умолчанию русский, для остальных — английский.
const RU_LANGUAGES = ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'az', 'hy'];
const localeFor = (languageCode?: string): Locale => (languageCode && RU_LANGUAGES.includes(languageCode) ? 'ru' : 'en');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type UserRow = typeof users.$inferSelect;
type AuthOutcome<T> = { value: T } | { error: AppError };

export interface Credential {
  pin?: string;
  biometricToken?: string;
}

// Все секреты выводятся из одного корневого (токена бота), чтобы на Vercel хватало одной переменной.
export function deriveSecret(appSecret: string, label: string): Buffer {
  return createHmac('sha256', appSecret).update(label).digest();
}

export class AuthService {
  private readonly sessionKey: Uint8Array;
  private readonly pepper: Buffer;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    this.sessionKey = deriveSecret(config.appSecret, 'gudex:session');
    this.pepper = deriveSecret(config.appSecret, 'gudex:pin');
  }

  /** Documents and payments are taken only from a client who accepted the current Terms and Privacy Policy. */
  async assertTermsAccepted(userId: string): Promise<void> {
    const [user] = await this.db.select({ termsVersion: users.termsVersion }).from(users).where(eq(users.id, userId));
    if (user?.termsVersion !== TERMS_VERSION) throw new AppError('validation', 'Accept the Terms of Use and the Privacy Policy first');
  }

  // ─── Вход ──────────────────────────────────────────────────────────────

  async loginWithTelegram(initData: string): Promise<SessionDto> {
    const token = this.config.TELEGRAM_BOT_TOKEN;
    if (!token) throw new AppError('telegram_auth_failed', 'Telegram bot is not configured');
    let tgUser: TelegramUser;
    try {
      tgUser = verifyInitData(initData, token);
    } catch (err) {
      if (err instanceof InitDataError) throw new AppError('telegram_auth_failed', err.message);
      throw err;
    }
    // Ссылка-приглашение, открывшая Mini App напрямую (t.me/бот?startapp=ref_код).
    const startParam = new URLSearchParams(initData).get('start_param');
    return this.session(await this.upsertTelegramUser(tgUser, await this.referrerFor(startParam)), false);
  }

  // Пользователь нажал «Старт» в боте (возможно, по ссылке-приглашению t.me/бот?start=ref_код).
  // Регистрируем его сразу: запомнить пригласившего и напомнить о карте, даже если приложение он ещё не открыл.
  async registerFromBot(tg: TelegramUser, startPayload: string | undefined): Promise<void> {
    await this.upsertTelegramUser(tg, await this.referrerFor(startPayload));
  }

  private async referrerFor(startParam: string | null | undefined): Promise<string | null> {
    const code = startParam?.startsWith('ref_') ? startParam.slice(4) : null;
    if (!code) return null;
    const [row] = await this.db.select({ id: users.id }).from(users).where(eq(users.referralCode, code));
    return row?.id ?? null;
  }

  // Только локально: вход «как пользователь Telegram» без самого Telegram.
  async devLogin(telegramId: number, firstName: string): Promise<SessionDto> {
    if (!this.config.devLogin) throw new AppError('not_found', 'Not found');
    return this.session(await this.upsertTelegramUser({ id: telegramId, first_name: firstName, language_code: 'ru' }), false);
  }

  // Пригласивший записывается только при создании пользователя — уже зарегистрированного не «переманить».
  private async upsertTelegramUser(tg: TelegramUser, referredBy: string | null = null): Promise<UserRow> {
    const profile = {
      username: tg.username ?? null,
      firstName: tg.first_name ?? null,
      lastName: tg.last_name ?? null,
      // Фото приходит только из Mini App; сообщение боту его не содержит — тогда не затираем.
      ...(tg.photo_url !== undefined ? { photoUrl: tg.photo_url } : {}),
      lastSeenAt: new Date(),
    };
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ telegramId: BigInt(tg.id), locale: localeFor(tg.language_code), referredBy, ...profile })
        .onConflictDoUpdate({ target: users.telegramId, set: profile })
        // xmax = 0 только у только что вставленной строки: так отличаем регистрацию от повторного входа.
        .returning({ ...getTableColumns(users), created: sql<boolean>`(xmax = 0)` });
      const { created, ...user } = row!;
      // Пустая анкета помечается текущим партнёром: запечатанная live-БД триггером отвергает строки с пометкой mock.
      await tx.insert(kycProfiles).values({ userId: user.id, partnerProvider: this.config.CARD_PARTNER }).onConflictDoNothing();
      // Новичку — одно напоминание о карте, если он её так и не выпустит.
      if (created && this.config.CARD_REMINDER_MINUTES > 0) {
        await enqueue(
          tx,
          'reminder.card',
          { userId: user.id },
          { runAt: new Date(Date.now() + this.config.CARD_REMINDER_MINUTES * 60_000), dedupeKey: `reminder.card:${user.id}`, maxAttempts: 3 },
        );
      }
      return user;
    });
  }

  // ─── Сессии ────────────────────────────────────────────────────────────
  // Сессия выдаётся «заблокированной» и разблокируется кодом-паролем или биометрией.

  private async session(user: UserRow, unlocked: boolean): Promise<SessionDto> {
    const accessToken = await new SignJWT({ lvl: unlocked ? 'unlocked' : 'locked', av: user.authVersion })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
      .sign(this.sessionKey);
    return { accessToken, expiresIn: SESSION_TTL_SECONDS, unlocked, hasPin: user.pinHash !== null };
  }

  async verifySession(token: string): Promise<{ userId: string; unlocked: boolean }> {
    try {
      const { payload } = await jwtVerify(token, this.sessionKey, { algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || (payload.lvl !== 'locked' && payload.lvl !== 'unlocked')) throw new Error('bad token');
      if (payload.av !== (await this.user(payload.sub)).authVersion) throw new Error('revoked session');
      return { userId: payload.sub, unlocked: payload.lvl === 'unlocked' };
    } catch {
      throw new AppError('unauthorized', 'Invalid or expired session');
    }
  }

  // ─── Код-пароль ────────────────────────────────────────────────────────

  async setPin(userId: string, pin: string, currentPin?: string): Promise<SessionDto> {
    return this.withLockedUser<SessionDto>(userId, async (tx, user) => {
      if (user.pinHash) {
        if (!currentPin) return { error: new AppError('pin_required', 'Current passcode is required') };
        const error = await this.checkPin(tx, user, currentPin);
        if (error) return { error };
      }
      const [updated] = await tx
        .update(users)
        .set({ pinHash: await this.hashPin(pin), pinFailedAttempts: 0, pinLockedUntil: null, authVersion: user.authVersion + 1 })
        .where(eq(users.id, userId))
        .returning();
      // Новый код отзывает старые сессии, подтверждения и биометрические токены.
      await tx.update(biometricTokens).set({ revokedAt: new Date() }).where(and(eq(biometricTokens.userId, userId), isNull(biometricTokens.revokedAt)));
      return { value: await this.session(updated!, true) };
    });
  }

  async unlock(userId: string, credential: Credential): Promise<SessionDto> {
    return this.withCredential(userId, credential, (_tx, user) => this.session(user, true));
  }

  // Подтверждение перед показом реквизитов: отдельный токен на 2 минуты.
  async confirm(userId: string, credential: Credential): Promise<ConfirmationDto> {
    return this.withCredential(userId, credential, async (_tx, user) => {
      const confirmationToken = await new SignJWT({ scope: 'confirm', av: user.authVersion })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime(`${CONFIRMATION_TTL_SECONDS}s`)
        .sign(this.sessionKey);
      return { confirmationToken, expiresIn: CONFIRMATION_TTL_SECONDS };
    });
  }

  async verifyConfirmation(token: string | undefined, userId: string): Promise<void> {
    if (!token) throw new AppError('unlock_required', 'Confirmation is required');
    try {
      const { payload } = await jwtVerify(token, this.sessionKey, { algorithms: ['HS256'] });
      if (payload.scope !== 'confirm' || payload.sub !== userId) throw new Error('bad scope');
      if (payload.av !== (await this.user(userId)).authVersion) throw new Error('revoked confirmation');
    } catch {
      throw new AppError('unlock_required', 'Confirmation is required');
    }
  }

  async createBiometricToken(userId: string, credential: Credential): Promise<BiometricTokenDto> {
    return this.withCredential(userId, credential, async (tx) => {
      const biometricToken = randomBytes(32).toString('base64url');
      await tx.insert(biometricTokens).values({ userId, tokenHash: sha256(biometricToken) });
      return { biometricToken };
    });
  }

  async revokeBiometricTokens(userId: string): Promise<void> {
    await this.db
      .update(biometricTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(biometricTokens.userId, userId), isNull(biometricTokens.revokedAt)));
  }

  private async user(userId: string): Promise<UserRow> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new AppError('unauthorized', 'User not found');
    return user;
  }

  // Ошибки PIN возвращаются из транзакции значением: счётчик ошибок должен сохраниться,
  // хотя HTTP-запрос завершится отказом. Блокировка строки сериализует параллельные попытки.
  private async withLockedUser<T>(userId: string, action: (tx: Tx, user: UserRow) => Promise<AuthOutcome<T>>): Promise<T> {
    const result = await this.db.transaction(async (tx): Promise<AuthOutcome<T>> => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!user) return { error: new AppError('unauthorized', 'User not found') };
      return action(tx, user);
    });
    if ('error' in result) throw result.error;
    return result.value;
  }

  private async withCredential<T>(userId: string, credential: Credential, action: (tx: Tx, user: UserRow) => Promise<T>): Promise<T> {
    return this.withLockedUser<T>(userId, async (tx, user) => {
      const error = await this.verifyCredential(tx, user, credential);
      if (error) return { error };
      return { value: await action(tx, user) };
    });
  }

  private async verifyCredential(tx: Tx, user: UserRow, credential: Credential): Promise<AppError | null> {
    if (credential.biometricToken) {
      const [row] = await tx
        .select({ id: biometricTokens.id })
        .from(biometricTokens)
        .where(
          and(
            eq(biometricTokens.userId, user.id),
            eq(biometricTokens.tokenHash, sha256(credential.biometricToken)),
            isNull(biometricTokens.revokedAt),
          ),
        );
      if (!row) return new AppError('pin_invalid', 'Biometric token is not valid');
      return null;
    }
    if (!credential.pin) return new AppError('validation', 'pin or biometricToken is required');
    return this.checkPin(tx, user, credential.pin);
  }

  // 5 ошибок подряд — код блокируется на 15 минут.
  private async checkPin(tx: Tx, user: UserRow, pin: string): Promise<AppError | null> {
    if (!user.pinHash) return new AppError('pin_required', 'Passcode is not set');
    if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
      return new AppError('pin_locked', 'Too many attempts', { lockedUntil: user.pinLockedUntil.toISOString() });
    }
    if (await this.pinMatches(pin, user.pinHash)) {
      if (user.pinFailedAttempts > 0) {
        await tx.update(users).set({ pinFailedAttempts: 0, pinLockedUntil: null }).where(eq(users.id, user.id));
      }
      return null;
    }
    const attempts = user.pinFailedAttempts + 1;
    if (attempts >= MAX_PIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + PIN_LOCK_MINUTES * 60_000);
      await tx.update(users).set({ pinFailedAttempts: 0, pinLockedUntil: lockedUntil }).where(eq(users.id, user.id));
      return new AppError('pin_locked', 'Too many attempts', { lockedUntil: lockedUntil.toISOString() });
    }
    await tx.update(users).set({ pinFailedAttempts: attempts }).where(eq(users.id, user.id));
    return new AppError('pin_invalid', 'Wrong passcode', { attemptsLeft: MAX_PIN_ATTEMPTS - attempts });
  }

  private async hashPin(pin: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await scrypt(pin, Buffer.concat([salt, this.pepper]), 32);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
  }

  private async pinMatches(pin: string, stored: string): Promise<boolean> {
    const [saltHex, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex!, 'hex');
    const actual = await scrypt(pin, Buffer.concat([Buffer.from(saltHex!, 'hex'), this.pepper]), expected.length);
    return timingSafeEqual(actual, expected);
  }
}
