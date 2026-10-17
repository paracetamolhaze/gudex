import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { botDescriptions } from '../src/telegram/bot-service';
import { TEST_BOT_TOKEN } from './helpers';

describe('bot descriptions', () => {
  it('keeps bot descriptions within Telegram limits even with long usernames', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x',
      TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
      SUPPORT_USERNAME: '@a_very_long_support_username_32',
      CHANNEL_USERNAME: 'a_very_long_channel_username_032',
    });
    for (const texts of Object.values(botDescriptions(config))) {
      expect(texts.description.length).toBeLessThanOrEqual(512);
      expect(texts.short.length).toBeLessThanOrEqual(120);
    }
    expect(botDescriptions(config).ru!.description).toContain('🆘 Поддержка: @a_very_long_support_username_32');

    // С обычными никами помещается и предупреждение о мошенниках.
    const usual = loadConfig({ DATABASE_URL: 'postgres://x', TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN, SUPPORT_USERNAME: 'gudex_support', CHANNEL_USERNAME: 'gudex_news' });
    expect(botDescriptions(usual).ru!.description).toContain('никогда не пишет первой');
    expect(botDescriptions(usual).default!.description).toContain('never messages first');
  });
});
