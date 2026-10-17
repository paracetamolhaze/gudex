import { describe, expect, it } from 'vitest';
import { cronReadiness } from '../../src/routes/telegram';

const now = Date.parse('2026-10-16T12:00:00.000Z');
const tick = (secondsAgo: number) => ({ lastTickAt: new Date(now - secondsAgo * 1000).toISOString() });

describe('cron liveness diagnostics', () => {
  it('uses a strict three minute silence limit for live minute ticks', () => {
    expect(cronReadiness(tick(180), now, '* * * * *')).toMatchObject({ healthy: true, status: 'healthy', maxAgeSeconds: 180, ageSeconds: 180 });
    expect(cronReadiness(tick(181), now, '* * * * *')).toMatchObject({ healthy: false, status: 'stale' });
  });
  it('allows the daily staging interval and classifies periodic minute schedules', () => {
    expect(cronReadiness(tick(86400), now, '0 4 * * *')).toMatchObject({ healthy: true, maxAgeSeconds: 93600 });
    expect(cronReadiness(tick(93601), now, '0 4 * * *').status).toBe('stale');
    expect(cronReadiness(tick(420), now, '*/5 * * * *')).toMatchObject({ healthy: true, maxAgeSeconds: 420 });
    expect(cronReadiness(tick(500), now, '*/5 * * * *').status).toBe('stale');
  });
  it('never exposes settings content or treats missing, malformed or future ticks as proof of liveness', () => {
    for (const value of [null, {}, { lastTickAt: 'PRIVATE-UNTRUSTED-CONTENT', token: 'PRIVATE-TOKEN' }, tick(-61)]) {
      const result = cronReadiness(value, now, '* * * * *');
      expect(result).toMatchObject({ healthy: false, status: 'never_seen', lastTickAt: null, ageSeconds: null });
      expect(JSON.stringify(result)).not.toContain('PRIVATE-');
    }
    expect(cronReadiness(tick(10), now, '0 4 * * 1')).toMatchObject({ healthy: false, status: 'unclassified_schedule' });
  });
});
