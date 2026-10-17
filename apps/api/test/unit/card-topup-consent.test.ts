import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config';
import type { Db } from '../../src/db/client';
import type { CardPartner } from '../../src/partner/types';
import { CardService } from '../../src/services/cards';

function setup() {
  const service = new CardService({} as Db, {
    CARD_ISSUE_FEE_USD: '10', CARD_MIN_TOPUP_USD: '10', CARD_TOPUP_FEE_BPS: 150,
  } as Config, {} as CardPartner);
  const internals = service as unknown as {
    findByKey: (...args: unknown[]) => Promise<unknown>;
    ownedCard: (...args: unknown[]) => Promise<unknown>;
    effectiveTopupMinimum: (...args: unknown[]) => Promise<bigint>;
    createOperation: (...args: unknown[]) => Promise<unknown>;
  };
  vi.spyOn(internals, 'findByKey').mockResolvedValue(undefined);
  vi.spyOn(internals, 'ownedCard').mockResolvedValue({ id: 'card', status: 'active' });
  vi.spyOn(internals, 'effectiveTopupMinimum').mockResolvedValue(1000n);
  const reserve = vi.spyOn(internals, 'createOperation').mockResolvedValue({ id: 'operation', status: 'pending' });
  return { service, reserve };
}

describe('top-up quote consent before reserving funds', () => {
  it.each([
    { expectedFee: '0.50', expectedNetUsd: '49.50' },
    { expectedFee: '0.75', expectedNetUsd: '49.24' },
    { expectedFee: '0.74', expectedNetUsd: '49.25' },
    { expectedFee: '0.75' },
    { expectedNetUsd: '49.25' },
  ])('rejects a changed or incomplete accepted quote: %j', async consent => {
    const { service, reserve } = setup();
    await expect(service.topup('user', 'card', {
      asset: 'USDT', amount: '50', idempotencyKey: 'new-topup', ...consent,
    })).rejects.toMatchObject({ code: 'quote_changed' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('accepts the displayed fee and net amount, including equivalent decimals', async () => {
    const { service, reserve } = setup();
    await expect(service.topup('user', 'card', {
      asset: 'USDT', amount: '50', idempotencyKey: 'new-topup',
      expectedFee: '0.750000', expectedNetUsd: '49.25',
    })).resolves.toMatchObject({ id: 'operation' });
    expect(reserve).toHaveBeenCalledOnce();
  });
});
