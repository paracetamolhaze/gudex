import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  convertMinor,
  DEPOSIT_NETWORKS,
  type DepositAddressDto,
  fromMinor,
  type Network,
  NETWORKS,
  toMinor,
  WALLET_ASSETS,
  type WalletAsset,
  type WalletDto,
} from '@gudex/shared';
import type { Db, Tx } from '../db/client';
import { depositAddresses, deposits, ledgerAccounts, users } from '../db/schema';
import { depositProviderId, type DepositProvider } from '../deposits/provider';
import { accounts, move, post } from '../ledger/ledger';
import { AppError } from '../lib/errors';
import { notify } from './notify';

export class WalletService {
  constructor(
    private readonly db: Db,
    private readonly provider: DepositProvider,
    private readonly minDeposit: string,
  ) {}

  get depositMode(): DepositProvider['mode'] { return this.provider.mode; }

  async getWallet(userId: string): Promise<WalletDto> {
    const rows = await this.db
      .select({ code: ledgerAccounts.code, kind: ledgerAccounts.kind, asset: ledgerAccounts.asset, balance: ledgerAccounts.balance })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.userId, userId));

    const balances = WALLET_ASSETS.map((asset) => {
      const row = rows.find((r) => r.code === accounts.userWallet(userId, asset).code);
      return { asset, minor: row?.balance ?? 0n };
    });
    const cardsUsd = rows.filter((r) => r.kind === 'user_card').reduce((sum, r) => sum + r.balance, 0n);
    // Стейблкоины считаются по 1:1 к USD.
    const totalUsd = balances.reduce((sum, b) => sum + convertMinor(b.minor, b.asset, 'USD'), cardsUsd);

    return {
      balances: balances.map((b) => ({ asset: b.asset, amount: fromMinor(b.minor, b.asset) })),
      cardsTotalUsd: fromMinor(cardsUsd, 'USD'),
      totalUsd: fromMinor(totalUsd, 'USD'),
    };
  }

  async getDepositAddress(userId: string, asset: WalletAsset, network: Network): Promise<DepositAddressDto> {
    if (!DEPOSIT_NETWORKS[asset].includes(network)) throw new AppError('validation', `${asset} is not supported on ${network}`);
    if (this.provider.mode === 'disabled') throw new AppError('provider_unavailable', 'Blockchain deposits are not connected yet');
    const providerId = depositProviderId(this.provider);
    const where = and(eq(depositAddresses.userId, userId), eq(depositAddresses.asset, asset), eq(depositAddresses.network, network));
    const row = await this.db.transaction(async tx => {
      // Concurrent deployments must not return an address issued by a different integration.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      let [existing] = await tx.select().from(depositAddresses).where(where);
      if (existing && existing.providerId === providerId) {
        const demoAddress = existing.address.startsWith('GUDEX-DEMO:');
        if (demoAddress === (this.provider.mode === 'demo')) return existing;
      }
      if (existing && existing.providerId !== 'mock' && existing.providerId !== providerId && this.provider.mode === 'live') {
        throw new AppError('provider_unavailable', 'A previous deposit integration requires an explicit address migration');
      }
      const address = await this.provider.createAddress({ userId, asset, network });
      if (!address || address.startsWith('GUDEX-DEMO:') !== (this.provider.mode === 'demo')) {
        throw new AppError('provider_unavailable', 'Deposit provider returned an address from the wrong financial environment');
      }
      [existing] = await tx.insert(depositAddresses).values({ userId, asset, network, address, providerId }).onConflictDoUpdate({
        target: [depositAddresses.userId, depositAddresses.asset, depositAddresses.network], set: { address, providerId },
      }).returning();
      return existing!;
    });
    return { asset, network, address: row.address, minAmount: this.minDeposit, demo: this.provider.mode === 'demo' };
  }

  // Зачисление входящего перевода. externalId (хэш транзакции) защищает от двойного зачисления.
  async recordDeposit(input: {
    userId: string;
    asset: WalletAsset;
    network: Network;
    address: string;
    externalId: string;
    amount: bigint;
  }): Promise<void> {
    if (this.provider.mode === 'disabled') throw new AppError('provider_unavailable', 'Blockchain deposits are not connected yet');
    if (input.amount <= 0n) throw new AppError('validation', 'Deposit amount must be positive');
    const providerId = depositProviderId(this.provider);
    await this.db.transaction(async (tx) => {
      const [address] = await tx.select({ id: depositAddresses.id }).from(depositAddresses).where(and(
        eq(depositAddresses.userId, input.userId), eq(depositAddresses.asset, input.asset),
        eq(depositAddresses.network, input.network), eq(depositAddresses.address, input.address),
        eq(depositAddresses.providerId, providerId),
      ));
      if (!address) throw new AppError('validation', 'Deposit address does not belong to this user and integration');
      const [created] = await tx
        .insert(deposits)
        .values({ ...input, providerId, status: 'pending' })
        .onConflictDoNothing({ target: deposits.externalId })
        .returning({ id: deposits.id });
      if (!created) return;
      const { transactionId } = await post(tx, {
        kind: 'deposit',
        reference: `deposit:${created.id}`,
        postings: move(accounts.external(input.asset), accounts.userWallet(input.userId, input.asset), input.amount),
        metadata: { network: input.network, externalId: input.externalId },
      });
      await tx
        .update(deposits)
        .set({ status: 'credited', ledgerTransactionId: transactionId, creditedAt: new Date() })
        .where(eq(deposits.id, created.id));
      await notify(tx, input.userId, {
        type: 'deposit',
        amount: fromMinor(input.amount, input.asset),
        asset: input.asset,
        network: NETWORKS[input.network].name,
      });
    });
  }

  // The invoice service calls this only inside its locked, exact-receipt transaction.
  // No address is allocated and no customer-supplied transaction hash is trusted.
  async creditInvoice(tx: Tx, input: { userId: string; invoiceId: string; orderNo: string; receiptId: string;
    asset: WalletAsset; network: Network; amount: bigint }): Promise<void> {
    if (input.amount <= 0n || !DEPOSIT_NETWORKS[input.asset]?.includes(input.network)
      || ![input.invoiceId, input.orderNo, input.receiptId].every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value))) {
      throw new AppError('provider_unavailable', 'The confirmed deposit receipt is invalid');
    }
    const providerId = 'upay-invoice';
    const externalId = `upay-invoice-receipt:${input.receiptId}`;
    const [created] = await tx.insert(deposits).values({ userId: input.userId, asset: input.asset, network: input.network,
      address: `upay-invoice:${input.invoiceId}`, providerId, externalId, amount: input.amount, status: 'pending' })
      .onConflictDoNothing({ target: deposits.externalId }).returning();
    const row = created ?? (await tx.select().from(deposits).where(eq(deposits.externalId, externalId)))[0];
    if (!row || row.userId !== input.userId || row.asset !== input.asset || row.network !== input.network || row.providerId !== providerId
      || row.address !== `upay-invoice:${input.invoiceId}` || row.amount !== input.amount) {
      throw new AppError('provider_unavailable', 'The deposit receipt is already bound to a different payment');
    }
    if (row.status === 'credited') return;
    const { transactionId, duplicate } = await post(tx, { kind: 'deposit', reference: `deposit:${row.id}`,
      postings: move(accounts.external(input.asset), accounts.userWallet(input.userId, input.asset), input.amount),
      metadata: { network: input.network, providerId, invoiceId: input.invoiceId, receiptId: input.receiptId, orderNo: input.orderNo } });
    await tx.update(deposits).set({ status: 'credited', ledgerTransactionId: transactionId, creditedAt: new Date() }).where(eq(deposits.id, row.id));
    if (!duplicate) await notify(tx, input.userId, { type: 'deposit', amount: fromMinor(input.amount, input.asset), asset: input.asset, network: NETWORKS[input.network].name });
  }

  // Только для разработки: «пришёл перевод» без блокчейна.
  async simulateDeposit(userId: string, asset: WalletAsset, network: Network, amount: string): Promise<void> {
    if (this.provider.mode !== 'demo') throw new AppError('provider_unavailable', 'Simulated deposits require the demo deposit integration');
    const minor = toMinor(amount, asset);
    if (minor <= 0n) throw new AppError('validation', 'Amount must be positive');
    const { address } = await this.getDepositAddress(userId, asset, network);
    await this.recordDeposit({ userId, asset, network, address, externalId: `mock:${randomUUID()}`, amount: minor });
  }
}
