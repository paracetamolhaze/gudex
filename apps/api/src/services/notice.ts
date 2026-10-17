import { eq } from 'drizzle-orm';
import type { ServiceNoticeDto } from '@gudex/shared';
import type { Db } from '../db/client';
import { appSettings } from '../db/schema';

const KEY = 'service_notice';

// Объявление о сбоях и технических работах: показывается плашкой в приложении.
// Включает и выключает администратор командой боту /notice.
export class NoticeService {
  constructor(private readonly db: Db) {}

  async get(): Promise<ServiceNoticeDto> {
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, KEY));
    const message = (row?.value as { message?: string } | undefined)?.message ?? null;
    return { message, updatedAt: message && row ? row.updatedAt.toISOString() : null };
  }

  async set(message: string | null): Promise<void> {
    const value = { message: message?.trim() || null };
    await this.db
      .insert(appSettings)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  }
}
