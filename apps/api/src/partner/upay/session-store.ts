import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { appSettings } from '../../db/schema';

export interface UpaySession { token: string; expiresAt: number; fingerprint: string; }
// This record contains no session or credential material and deliberately survives
// encryption-key / credential rotation so a cold instance cannot bypass cooldown.
export interface UpayAuthAttempt {
  fingerprint: string;
  retryAfter: number;
  attemptId?: string;
  state?: 'started' | 'succeeded' | 'failed';
}
export interface SessionAccess {
  get(): Promise<UpaySession | null>;
  set(session: UpaySession | null): Promise<void>;
  getAuthAttempt?(): Promise<UpayAuthAttempt | null>;
  setAuthAttempt?(attempt: UpayAuthAttempt | null): Promise<void>;
}
export interface UpaySessionStore { withLock<T>(fn: (access: SessionAccess) => Promise<T>): Promise<T>; }

function authAttempt(value: unknown): UpayAuthAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid UPay authentication cooldown state');
  const input = value as Record<string, unknown>;
  if (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
      !Number.isSafeInteger(input.retryAfter) || (input.retryAfter as number) <= 0 ||
      !Number.isFinite(new Date(input.retryAfter as number).getTime()) ||
      (input.attemptId !== undefined && (typeof input.attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.attemptId))) ||
      (input.state !== undefined && !['started', 'succeeded', 'failed'].includes(String(input.state)))) {
    // A corrupt cooldown must fail closed instead of triggering another login.
    throw new Error('Invalid UPay authentication cooldown state');
  }
  return { fingerprint: input.fingerprint, retryAfter: input.retryAfter as number,
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId as string } : {}),
    ...(input.state !== undefined ? { state: input.state as UpayAuthAttempt['state'] } : {}) };
}

// Session material is encrypted; durable authentication claims contain only closed metadata.
export class DbUpaySessionStore implements UpaySessionStore {
  private readonly key: Buffer;
  private readonly setting = 'upay:session:v1';
  private readonly attemptSetting = 'upay:auth-attempt:v1';
  constructor(private readonly db: Db, appSecret: string) {
    this.key = createHmac('sha256', appSecret).update('gudex:upay:session:v1').digest();
  }
  async withLock<T>(fn: (access: SessionAccess) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(727275)`);
      const access: SessionAccess = {
        get: async () => {
          const [row] = await tx.select().from(appSettings).where(eq(appSettings.key, this.setting));
          if (!row) return null;
          try {
            const data = row.value as { iv: string; tag: string; ciphertext: string };
            const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(data.iv, 'base64'));
            cipher.setAuthTag(Buffer.from(data.tag, 'base64'));
            return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data.ciphertext, 'base64')), cipher.final()]).toString('utf8')) as UpaySession;
          } catch { return null; }
        },
        set: async session => {
          if (!session) { await tx.delete(appSettings).where(eq(appSettings.key, this.setting)); return; }
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', this.key, iv);
          const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
          const value = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
          await tx.insert(appSettings).values({ key: this.setting, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
        },
        getAuthAttempt: async () => {
          const [row] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, this.attemptSetting));
          return row ? authAttempt(row.value) : null;
        },
        setAuthAttempt: async attempt => {
          if (!attempt) { await tx.delete(appSettings).where(eq(appSettings.key, this.attemptSetting)); return; }
          const value = authAttempt(attempt);
          await tx.insert(appSettings).values({ key: this.attemptSetting, value })
            .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
        },
      };
      return fn(access);
    });
  }
}
