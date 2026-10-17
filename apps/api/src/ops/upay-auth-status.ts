import type { Config } from '../config';
import type { Db } from '../db/client';
import { UPAY_LOGIN_MIN_INTERVAL_MS } from '../partner/upay/client';
import { DbUpaySessionStore } from '../partner/upay/session-store';

// Local database observation only. Never authenticate, touch UPay or return a
// token, fingerprint, login, device identifier, claim ID or credential.
export async function inspectUpayAuthStatus(db: Db, config: Config) {
  const policy = { sessionStorage: 'database' as const, sessionTtlSeconds: config.UPAY_SESSION_TTL_SECONDS,
    minimumLoginIntervalSeconds: UPAY_LOGIN_MIN_INTERVAL_MS / 1000 };
  try {
    return await new DbUpaySessionStore(db, config.appSecret).withLock(async access => {
      const session = await access.get();
      const attempt = await access.getAuthAttempt!();
      const now = Date.now();
      const retryAfter = attempt && Number.isSafeInteger(attempt.retryAfter) ? attempt.retryAfter : null;
      return { ...policy, available: true, hasCachedSession: Boolean(session),
        cachedSessionLocalTtlValid: Boolean(session && Number.isFinite(session.expiresAt) && session.expiresAt > now),
        hasAuthAttempt: Boolean(attempt),
        lastAttemptState: attempt?.state === 'started' || attempt?.state === 'succeeded' || attempt?.state === 'failed' ? attempt.state : null,
        cooldownActive: retryAfter !== null && retryAfter > now,
        cooldownSecondsRemaining: retryAfter === null ? 0 : Math.max(0, Math.ceil((retryAfter - now) / 1000)),
        nextLoginAllowedAt: retryAfter !== null && retryAfter > 0 && retryAfter <= 8640000000000000 ? new Date(retryAfter).toISOString() : null,
      };
    });
  } catch { return { ...policy, available: false }; }
}
