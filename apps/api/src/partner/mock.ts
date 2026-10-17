import { randomInt } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { mockUpayCards, mockUpayCustomers, mockUpayRecharges, mockUpayTransactions } from '../db/schema';
import {
  type CardPartner,
  type PartnerCard,
  type PartnerCustomerInput,
  PartnerError,
  type PartnerKycStatus,
  type PartnerTransaction,
} from './types';

// Заглушка UPay: хранит «партнёрские» карты в таблицах mock_upay_*.
// Номера карт — на тестовом BIN 400000, в реальной сети не работают.

const MOCK_BIN = '400000';

function luhnCheckDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let digit = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

function generatePan(): string {
  let body = MOCK_BIN;
  while (body.length < 15) body += String(randomInt(10));
  return body + luhnCheckDigit(body);
}

const toPartnerCard = (row: typeof mockUpayCards.$inferSelect): PartnerCard => ({
  partnerCardId: row.id,
  last4: row.pan.slice(-4),
  expiryMonth: row.expiryMonth,
  expiryYear: row.expiryYear,
});

export class MockUpayPartner implements CardPartner {
  constructor(
    private readonly db: Db,
    private readonly delayMs = 0,
    private readonly kycDelayMs = 0,
  ) {}

  private async latency(): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  private async card(partnerCardId: string) {
    const [row] = await this.db.select().from(mockUpayCards).where(eq(mockUpayCards.id, partnerCardId));
    if (!row) throw new PartnerError(`Card ${partnerCardId} not found`, false);
    return row;
  }

  async createCustomer(input: PartnerCustomerInput): Promise<string> {
    await this.latency();
    // Повторная подача после отказа: данные обновляются, проверка начинается заново.
    const { externalRef, ...data } = input;
    await this.db
      .insert(mockUpayCustomers)
      .values(input)
      .onConflictDoUpdate({ target: mockUpayCustomers.externalRef, set: { ...data, createdAt: new Date() } });
    const [row] = await this.db
      .select({ id: mockUpayCustomers.id })
      .from(mockUpayCustomers)
      .where(eq(mockUpayCustomers.externalRef, input.externalRef));
    return row!.id;
  }

  // KYC одобряется через kycDelayMs после создания клиента. Фамилия REJECT — отказ (для проверки сценария).
  async getKycStatus(partnerCustomerId: string): Promise<PartnerKycStatus> {
    const customer = await this.customer(partnerCustomerId);
    if (customer.lastName === 'REJECT') return { status: 'rejected', reason: 'Documents could not be verified' };
    if (Date.now() - customer.createdAt.getTime() < this.kycDelayMs) return { status: 'pending' };
    return { status: 'approved' };
  }

  private async customer(partnerCustomerId: string) {
    const [row] = await this.db.select().from(mockUpayCustomers).where(eq(mockUpayCustomers.id, partnerCustomerId));
    if (!row) throw new PartnerError(`Customer ${partnerCustomerId} not found`, false);
    return row;
  }

  async issueCard(input: { externalRef: string; partnerCustomerId: string }): Promise<PartnerCard> {
    await this.latency();
    const customer = await this.customer(input.partnerCustomerId);
    if ((await this.getKycStatus(customer.id)).status !== 'approved') throw new PartnerError('Customer KYC is not approved', false);
    const now = new Date();
    const [row] = await this.db
      .insert(mockUpayCards)
      .values({
        customerId: customer.id,
        externalRef: input.externalRef,
        holderName: `${customer.firstName} ${customer.lastName}`,
        pan: generatePan(),
        cvv: String(randomInt(1000)).padStart(3, '0'),
        expiryMonth: now.getUTCMonth() + 1,
        expiryYear: now.getUTCFullYear() + 3,
      })
      .onConflictDoNothing({ target: mockUpayCards.externalRef })
      .returning();
    if (row) return toPartnerCard(row);
    const existing = await this.findCardByExternalRef(input.externalRef);
    return existing!;
  }

  async findCardByExternalRef(externalRef: string): Promise<PartnerCard | null> {
    const [row] = await this.db.select().from(mockUpayCards).where(eq(mockUpayCards.externalRef, externalRef));
    return row ? toPartnerCard(row) : null;
  }

  async rechargeCard(input: { partnerCardId: string; amountUsd: bigint; externalRef: string }): Promise<void> {
    await this.latency();
    const card = await this.card(input.partnerCardId);
    if (card.status !== 'active') throw new PartnerError('Card is not active', false);
    await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(mockUpayRecharges)
        .values({ externalRef: input.externalRef, cardId: card.id, amount: input.amountUsd })
        .onConflictDoNothing({ target: mockUpayRecharges.externalRef })
        .returning({ id: mockUpayRecharges.id });
      if (!inserted) return;
      await tx
        .update(mockUpayCards)
        .set({ balance: sql`${mockUpayCards.balance} + ${input.amountUsd}` })
        .where(eq(mockUpayCards.id, card.id));
    });
  }

  async isRechargeDone(externalRef: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: mockUpayRecharges.id })
      .from(mockUpayRecharges)
      .where(eq(mockUpayRecharges.externalRef, externalRef));
    return Boolean(row);
  }

  async freezeCard(partnerCardId: string): Promise<void> {
    await this.latency();
    await this.card(partnerCardId);
    await this.db.update(mockUpayCards).set({ status: 'frozen' }).where(eq(mockUpayCards.id, partnerCardId));
  }

  async unfreezeCard(partnerCardId: string): Promise<void> {
    await this.latency();
    await this.card(partnerCardId);
    await this.db.update(mockUpayCards).set({ status: 'active' }).where(eq(mockUpayCards.id, partnerCardId));
  }

  async getCardState(partnerCardId: string): Promise<'active' | 'frozen' | null> {
    const card = await this.card(partnerCardId);
    return card.status === 'active' || card.status === 'frozen' ? card.status : null;
  }

  async getCardSensitive(partnerCardId: string) {
    const card = await this.card(partnerCardId);
    return {
      pan: card.pan,
      cvv: card.cvv,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      holderName: card.holderName,
    };
  }

  async listTransactions(partnerCardId: string): Promise<PartnerTransaction[]> {
    const rows = await this.db
      .select()
      .from(mockUpayTransactions)
      .where(eq(mockUpayTransactions.cardId, partnerCardId))
      .orderBy(asc(mockUpayTransactions.createdAt));
    return rows.map((r) => ({
      partnerTxId: `mock:${r.id}`,
      kind: r.kind as 'purchase' | 'refund',
      amountUsd: r.amount,
      merchant: r.merchant,
      occurredAt: r.createdAt,
    }));
  }

  // Только для заглушки: «покупка» по карте, как будто её авторизовал Visa.
  async simulatePurchase(partnerCardId: string, amountUsd: bigint, merchant: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [card] = await tx
        .select()
        .from(mockUpayCards)
        .where(and(eq(mockUpayCards.id, partnerCardId)))
        .for('update');
      if (!card) throw new PartnerError('Card not found', false);
      if (card.status !== 'active') throw new PartnerError('Declined: card is frozen', false);
      if (card.balance < amountUsd) throw new PartnerError('Declined: insufficient card balance', false);
      await tx
        .update(mockUpayCards)
        .set({ balance: sql`${mockUpayCards.balance} - ${amountUsd}` })
        .where(eq(mockUpayCards.id, partnerCardId));
      await tx.insert(mockUpayTransactions).values({ cardId: partnerCardId, kind: 'purchase', amount: amountUsd, merchant });
    });
  }
}
