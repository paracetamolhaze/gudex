import { createHash } from 'node:crypto';
import type { Network, WalletAsset } from '@gudex/shared';

// Кто отправляет крипту на внешний адрес. Варианты те же, что и для депозитов:
// UPay (Fund Control), свой горячий кошелёк или кастоди-провайдер.
export interface WithdrawalProvider {
  // An absent identity is a legacy/mock test provider, never a live integration.
  readonly providerId?: string;
  assertAvailable?(): void;
  // reference — id вывода: повторный вызов с тем же reference не должен отправить деньги второй раз.
  send(input: { reference: string; asset: WalletAsset; network: Network; address: string; amount: bigint }): Promise<{ txHash: string }>;
  // Только чтение: null означает «не удалось подтвердить», а не разрешение отправить повторно.
  findByReference?(reference: string): Promise<{ txHash: string } | null>;
}

// Заглушка: ничего не отправляет, возвращает правдоподобный хэш транзакции.
export class MockWithdrawalProvider implements WithdrawalProvider {
  readonly providerId = 'mock';
  private readonly sent = new Map<string, { txHash: string }>();
  constructor(private readonly delayMs = 0) {}

  async send(input: { reference: string; network: Network }): Promise<{ txHash: string }> {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const hash = createHash('sha256').update(`withdrawal:${input.reference}`).digest('hex');
    const result = { txHash: input.network === 'TON' || input.network === 'TRC20' ? hash : `0x${hash}` };
    this.sent.set(input.reference, result);
    return result;
  }

  async findByReference(reference: string): Promise<{ txHash: string } | null> {
    return this.sent.get(reference) ?? null;
  }
}
