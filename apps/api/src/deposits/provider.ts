import { createHash } from 'node:crypto';
import { type Network, type WalletAsset } from '@gudex/shared';
import { AppError } from '../lib/errors';

// Кто выдаёт адреса для пополнения. Варианты на будущее: адреса UPay (Address Management),
// свой HD-кошелёк или кастоди-провайдер. Решение — после разведки админки.
export interface DepositProvider {
  readonly mode: 'demo' | 'disabled' | 'live';
  // Stable integration identity. A live provider must always supply its own identifier.
  readonly providerId?: string;
  createAddress(input: { userId: string; asset: WalletAsset; network: Network }): Promise<string>;
}

export function depositProviderId(provider: DepositProvider): string {
  if (provider.mode === 'demo') return 'mock';
  if (provider.mode === 'disabled') return 'disabled';
  const id = provider.providerId?.trim();
  if (!id || id === 'mock' || id === 'disabled') throw new AppError('provider_unavailable', 'The live deposit integration has no verified provider identity');
  return id;
}

// Demo identifiers are explicitly non-transferable on every supported network.
export class MockDepositProvider implements DepositProvider {
  readonly mode = 'demo' as const;
  readonly providerId = 'mock';
  async createAddress(input: { userId: string; asset: WalletAsset; network: Network }): Promise<string> {
    const hash = createHash('sha256').update(`${input.userId}:${input.asset}:${input.network}`).digest('hex').slice(0, 20);
    return `GUDEX-DEMO:${input.network}:${hash}`;
  }
}

export class DisabledDepositProvider implements DepositProvider {
  readonly mode = 'disabled' as const;
  readonly providerId = 'disabled';
  async createAddress(): Promise<string> { throw new AppError('provider_unavailable', 'Blockchain deposits are not connected yet'); }
}
