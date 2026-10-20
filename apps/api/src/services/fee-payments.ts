import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { convertMinor, fromMinor, toMinor, type FeePaymentDto, type FeeWalletDto, type WalletAsset, type WalletTransferDto } from '@gudex/shared';
import type { Config } from '../config';
import type { Db, Tx } from '../db/client';
import { adminAuditLog, appSettings, cards, deposits, feePayments, users, walletTransfers } from '../db/schema';
import { accounts, getBalance, move, post } from '../ledger/ledger';
import { AppError, isUniqueViolation } from '../lib/errors';
import { EXPLORERS, scanEvm, scanTron, TOKENS, WATCH_NETWORKS, type ChainTransfer, type WatchNetwork } from '../payments/chain-watch';
import { enqueue, type JobHandler } from '../queue/queue';
import { notify } from './notify';

// The issuance fee is paid to a pool of app wallet addresses. An address is lent to one client at a
// time, so the address itself tells who paid. After the lease ends the address rests for a cooldown,
// so a late transfer still belongs to its last borrower and nobody else.
type Family = 'tron' | 'evm';
type PaymentRow = typeof feePayments.$inferSelect;
type TransferRow = typeof walletTransfers.$inferSelect;
type Fetch = typeof fetch;
const PROVIDER_ID = 'app-wallet';
const SCAN_STEPS = 5;
// Chain clocks and ours may differ slightly; a transfer seconds before the lease still counts.
const SKEW_MS = 60_000;
// Deadlock, serialization failure, lock timeout, statement timeout: worth trying again.
const TRANSIENT_SQLSTATES = new Set(['40P01', '40001', '55P03', '57014']);
const familyOf = (network: string): Family => network === 'TRC20' ? 'tron' : 'evm';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const cursorKey = (network: WatchNetwork) => `fee_wallet_scan:${network}`;

/** Called after a transfer was credited: moves a waiting application forward when the fee is covered. */
export type FeeCreditedHook = (tx: Tx, input: { userId: string; asset: WalletAsset; leaseId: string | null }) => Promise<boolean>;

export class FeePaymentService {
  private onCredited: FeeCreditedHook | undefined;
  constructor(private readonly db: Db, private readonly config: Config, private readonly fetchImpl: Fetch = fetch) {}

  setCreditedHook(hook: FeeCreditedHook): void { this.onCredited = hook; }

  private pool(family: Family): string[] {
    const raw = family === 'tron' ? this.config.APP_WALLET_TRON : this.config.APP_WALLET_EVM;
    return [...new Set((raw ?? '').split(',').map(item => item.trim()).filter(Boolean))];
  }

  networks(): WatchNetwork[] {
    if (this.config.CARD_ISSUANCE_MODE !== 'manual') return [];
    const enabled = this.config.APP_WALLET_NETWORKS.split(',').map(item => item.trim().toUpperCase());
    return WATCH_NETWORKS.filter(network => enabled.includes(network) && this.pool(familyOf(network)).length);
  }

  private get fee(): bigint { return toMinor(this.config.CARD_ISSUE_FEE_USD, 'USD'); }
  private get leaseMs(): number { return this.config.FEE_ADDRESS_LEASE_MINUTES * 60_000; }
  private get cooldownMs(): number { return this.config.FEE_ADDRESS_COOLDOWN_MINUTES * 60_000; }

  options(): FeeWalletDto | null {
    const networks = this.networks();
    if (!networks.length) return null;
    return { fee: fromMinor(this.fee, 'USD'), networks: networks.map(network => ({ network, assets: TOKENS[network].map(token => token.asset) })) };
  }

  private dto(row: PaymentRow, txHash: string | null = null): FeePaymentDto {
    const asset = row.asset as WalletAsset;
    const missing = row.amount > row.received ? row.amount - row.received : 0n;
    return { id: row.id, asset, network: row.network as WatchNetwork, address: row.address, amount: fromMinor(row.amount, asset),
      received: fromMinor(row.received, asset), missing: fromMinor(missing, asset), status: row.status as FeePaymentDto['status'],
      expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(), paidAt: row.paidAt?.toISOString() ?? null,
      // Counted by the server clock, so a phone with a wrong clock still shows the right countdown.
      secondsLeft: row.status === 'awaiting' ? Math.max(0, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)) : 0,
      txHash, explorerUrl: txHash ? `${EXPLORERS[row.network as WatchNetwork]}${txHash}` : null };
  }

  /** The client's latest lease: open, paid recently, or ended without payment within its cooldown (a late transfer
   * still counts then). Reading an open lease wakes the watcher for it. */
  async current(userId: string): Promise<FeePaymentDto | null> {
    const [latest] = await this.db.select().from(feePayments).where(and(eq(feePayments.userId, userId),
      inArray(feePayments.status, ['awaiting', 'paid', 'expired']), gte(feePayments.createdAt, new Date(Date.now() - 24 * 60 * 60_000))))
      .orderBy(desc(feePayments.createdAt)).limit(1);
    if (!latest) return null;
    let row = latest;
    if (row.status === 'awaiting' && row.expiresAt <= new Date()) {
      const [ended] = await this.db.update(feePayments).set({ status: 'expired', endedAt: row.expiresAt })
        .where(and(eq(feePayments.id, row.id), eq(feePayments.status, 'awaiting'))).returning();
      row = ended ?? (await this.db.select().from(feePayments).where(eq(feePayments.id, row.id)))[0]!;
    }
    if (row.status === 'expired' && (row.endedAt ?? row.expiresAt).getTime() < Date.now() - this.cooldownMs) return null;
    if (row.status === 'awaiting') {
      await enqueue(this.db, 'fee_wallet.scan', { family: row.family }, { dedupeKey: `fee_wallet.scan:${row.family}`, maxAttempts: 1 });
    }
    const [transfer] = row.transferId ? await this.db.select({ txHash: walletTransfers.txHash }).from(walletTransfers).where(eq(walletTransfers.id, row.transferId)) : [];
    return this.dto(row, transfer?.txHash ?? null);
  }

  /** Lends a free address of the network's family to this client. Switching networks of the same family keeps the address. */
  async create(userId: string, input: { asset: WalletAsset; network: string }): Promise<FeePaymentDto> {
    const network = input.network as WatchNetwork;
    if (!this.networks().includes(network) || !TOKENS[network].some(token => token.asset === input.asset)) {
      throw new AppError('validation', 'This network or asset is not accepted for the issuance fee');
    }
    const family = familyOf(network);
    const fee = convertMinor(this.fee, 'USD', input.asset);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const row = await this.db.transaction(async tx => {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
          // One card per client: once a card exists or is being prepared, there is nothing to pay for.
          const [card] = await tx.select({ id: cards.id }).from(cards).where(and(eq(cards.userId, userId), inArray(cards.status, ['pending', 'active', 'frozen']))).limit(1);
          if (card) throw new AppError('card_limit', 'The client already has a card');
          // Money already on the balance in this coin (an earlier partial payment) counts: the address asks only for the rest.
          const balance = await getBalance(tx, accounts.userWallet(userId, input.asset).code);
          if (balance >= fee) throw new AppError('validation', 'The balance already covers the card fee; pay from the balance');
          const amount = fee - balance;
          const now = new Date();
          const [active] = await tx.select().from(feePayments).where(and(eq(feePayments.userId, userId), eq(feePayments.status, 'awaiting'))).for('update');
          if (active && active.expiresAt > now && active.family === family && this.pool(family).some(address => same(address, active.address))) {
            // What arrived in the old coin is already on the balance and counted in the new amount.
            const [updated] = await tx.update(feePayments).set({ network, asset: input.asset, amount, received: 0n }).where(eq(feePayments.id, active.id)).returning();
            return updated!;
          }
          if (active) await tx.update(feePayments).set({ status: active.expiresAt > now ? 'cancelled' : 'expired', endedAt: active.expiresAt > now ? now : active.expiresAt })
            .where(eq(feePayments.id, active.id));
          // An address is free for this client when nobody holds it and no other client's lease on it
          // ended within the cooldown. The client's own recent address is offered first.
          const recent = await tx.select({ address: feePayments.address, userId: feePayments.userId, status: feePayments.status }).from(feePayments)
            .where(and(eq(feePayments.family, family), or(eq(feePayments.status, 'awaiting'), gte(feePayments.endedAt, new Date(now.getTime() - this.cooldownMs - SKEW_MS)))));
          const available = this.pool(family).filter(address => !recent.some(row => same(row.address, address) && (row.status === 'awaiting' || row.userId !== userId)));
          const free = [...available.filter(address => recent.some(row => same(row.address, address))), ...available.filter(address => !recent.some(row => same(row.address, address)))];
          if (!free.length) throw new AppError('payment_addresses_busy', 'All payment addresses are in use; try again in a few minutes or choose another network');
          const [created] = await tx.insert(feePayments).values({ userId, asset: input.asset, network, family, address: free[0]!, amount,
            expiresAt: new Date(now.getTime() + this.leaseMs) }).returning();
          return created!;
        });
        return this.dto(row);
      } catch (error) {
        // Two clients took the same address at once: the unique index refuses one; pick again.
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }
    throw new AppError('payment_addresses_busy', 'Could not lend a payment address; try again');
  }

  handlers(): Record<string, JobHandler> {
    return { 'fee_wallet.scan': { run: (payload: { family?: Family }) => this.scan(payload.family) } };
  }

  /** Leases that may still receive money: open ones, and ended ones still in their cooldown. */
  private async watched(family?: Family): Promise<PaymentRow[]> {
    const now = Date.now();
    return this.db.select().from(feePayments).where(and(family ? eq(feePayments.family, family) : undefined,
      or(eq(feePayments.status, 'awaiting'), gte(feePayments.endedAt, new Date(now - this.cooldownMs - SKEW_MS)))));
  }

  /** The cron wakes the watcher only while somebody is paying; otherwise nothing is read from any chain. */
  async enqueueScan(tx: Tx): Promise<void> {
    if (!this.networks().length) return;
    const [open] = await tx.select({ id: feePayments.id }).from(feePayments).where(or(eq(feePayments.status, 'awaiting'),
      gte(feePayments.endedAt, new Date(Date.now() - this.cooldownMs - SKEW_MS)))).limit(1);
    if (open) await enqueue(tx, 'fee_wallet.scan', {}, { dedupeKey: 'fee_wallet.scan', maxAttempts: 1 });
  }

  async scan(family?: Family): Promise<void> {
    await this.db.update(feePayments).set({ status: 'expired', endedAt: sql`${feePayments.expiresAt}` })
      .where(and(eq(feePayments.status, 'awaiting'), lte(feePayments.expiresAt, new Date())));
    const leases = await this.watched(family);
    const errors: string[] = [];
    for (const network of this.networks().filter(item => !family || familyOf(item) === family)) {
      const mine = leases.filter(lease => lease.family === familyOf(network));
      if (!mine.length) { await this.db.delete(appSettings).where(eq(appSettings.key, cursorKey(network))); continue; }
      const since = Math.min(...mine.map(lease => lease.createdAt.getTime())) - SKEW_MS;
      const addresses = [...new Set(mine.map(lease => lease.address))];
      try { await this.scanNetwork(network, addresses, since); } catch (error) { errors.push(`${network}: ${(error as Error).message}`); }
    }
    // Oldest first, each on its own: a transfer that cannot be matched now must not hold back the others.
    for (const row of await this.db.select({ id: walletTransfers.id }).from(walletTransfers).where(eq(walletTransfers.status, 'new'))
      .orderBy(walletTransfers.blockTime).limit(200)) {
      try { await this.match(row.id); } catch (error) { errors.push(`transfer ${row.id}: ${(error as Error).message}`); }
    }
    if (errors.length) console.warn('fee wallet scan incomplete', errors.join('; '));
  }

  private async scanNetwork(network: WatchNetwork, addresses: string[], since: number): Promise<void> {
    if (network === 'TRC20') {
      for (const address of addresses) {
        const transfers = await scanTron(this.config.TRONGRID_URL, this.config.TRONGRID_API_KEY, address, since, this.fetchImpl);
        await this.db.transaction(async tx => { for (const transfer of transfers) await this.record(tx, transfer); });
      }
      return;
    }
    const [setting] = await this.db.select().from(appSettings).where(eq(appSettings.key, cursorKey(network)));
    let cursor = typeof (setting?.value as { cursor?: unknown } | undefined)?.cursor === 'string' ? (setting!.value as { cursor: string }).cursor : null;
    const rpcUrl = network === 'BEP20' ? this.config.BSC_RPC_URL : network === 'ERC20' ? this.config.ETH_RPC_URL : this.config.POLYGON_RPC_URL;
    for (let step = 0; step < SCAN_STEPS; step++) {
      const result = await scanEvm(network, rpcUrl, addresses, cursor, since, this.fetchImpl);
      await this.db.transaction(async tx => {
        for (const transfer of result.transfers) await this.record(tx, transfer);
        await tx.insert(appSettings).values({ key: cursorKey(network), value: { cursor: result.cursor } })
          .onConflictDoUpdate({ target: appSettings.key, set: { value: { cursor: result.cursor }, updatedAt: new Date() } });
      });
      cursor = result.cursor;
      if (result.done) return;
    }
  }

  private async record(tx: Tx, transfer: ChainTransfer): Promise<void> {
    await tx.insert(walletTransfers).values({ network: transfer.network, asset: transfer.asset, txHash: transfer.txHash, logIndex: transfer.logIndex,
      fromAddress: transfer.from, toAddress: transfer.to, amount: transfer.amount, exact: transfer.exact, blockNumber: transfer.blockNumber,
      blockTime: transfer.blockTime }).onConflictDoNothing({ target: [walletTransfers.network, walletTransfers.txHash, walletTransfers.logIndex] });
  }

  /** The transfer belongs to the last borrower of that address, if it arrived during the lease or its cooldown. */
  async match(transferId: string): Promise<void> {
    await this.db.transaction(async tx => {
      const [transfer] = await tx.select().from(walletTransfers).where(eq(walletTransfers.id, transferId)).for('update');
      if (!transfer || transfer.status !== 'new') return;
      const [lease] = transfer.amount > 0n ? await tx.select().from(feePayments).where(and(sql`lower(${feePayments.address}) = ${transfer.toAddress.toLowerCase()}`,
        lte(feePayments.createdAt, new Date(transfer.blockTime.getTime() + SKEW_MS)))).orderBy(desc(feePayments.createdAt)).limit(1).for('update') : [];
      const window = lease ? (lease.endedAt ?? lease.expiresAt).getTime() + this.cooldownMs : 0;
      if (!lease || transfer.blockTime.getTime() > window) {
        await tx.update(walletTransfers).set({ status: 'unmatched', resolvedAt: new Date() }).where(eq(walletTransfers.id, transfer.id));
        return;
      }
      const depositId = await this.credit(tx, lease.userId, transfer);
      await tx.update(walletTransfers).set({ status: 'matched', userId: lease.userId, depositId, resolvedAt: new Date() }).where(eq(walletTransfers.id, transfer.id));
      // Only the lease's own coin counts toward it; any other coin is still credited to the balance.
      const received = transfer.asset === lease.asset ? lease.received + transfer.amount : lease.received;
      const covered = received >= lease.amount;
      // Only while the address is still held for this client may we ask for the rest on the same address.
      const minutesLeft = lease.status === 'awaiting' && lease.expiresAt.getTime() > Date.now() ? Math.ceil((lease.expiresAt.getTime() - Date.now()) / 60_000) : null;
      // A transfer sent before the time ran out may be confirmed after it: the lease is then paid all the same.
      await tx.update(feePayments).set({ received, ...((lease.status === 'awaiting' || lease.status === 'expired') && covered
        ? { status: 'paid', transferId: transfer.id, paidAt: new Date(), endedAt: new Date() } : {}) }).where(eq(feePayments.id, lease.id));
      const moved = await this.moveApplication(tx, { userId: lease.userId, asset: transfer.asset as WalletAsset, leaseId: lease.id });
      if (!moved) {
        const balance = await getBalance(tx, accounts.userWallet(lease.userId, transfer.asset as WalletAsset).code);
        const need = convertMinor(this.fee, 'USD', transfer.asset as WalletAsset);
        await notify(tx, lease.userId, { type: 'fee_paid', amount: fromMinor(transfer.amount, transfer.asset as WalletAsset), asset: transfer.asset,
          ...(balance < need ? { missing: fromMinor(need - balance, transfer.asset as WalletAsset), ...(minutesLeft !== null ? { minutesLeft } : {}) } : {}) });
      }
    });
  }

  /** The money is credited in any case; moving the application on is a separate step that may not succeed now.
   * A passing database conflict rolls the whole transfer back for the next scan; any other failure leaves the money
   * on the balance, from where the client pays in the app. */
  private async moveApplication(tx: Tx, input: Parameters<FeeCreditedHook>[1]): Promise<boolean> {
    if (!this.onCredited) return false;
    try { return await tx.transaction(savepoint => this.onCredited!(savepoint, input)); }
    catch (error) {
      const cause = ((error as { cause?: unknown }).cause ?? error) as { code?: string; message?: string };
      if (cause.code && TRANSIENT_SQLSTATES.has(cause.code)) throw error;
      console.warn('fee payment credited, application not moved', input.userId, cause.code ?? '', cause.message ?? '');
      return false;
    }
  }

  private async credit(tx: Tx, userId: string, transfer: TransferRow): Promise<string> {
    const asset = transfer.asset as WalletAsset;
    if (transfer.amount <= 0n) throw new AppError('validation', 'An empty transfer cannot be credited');
    const [deposit] = await tx.insert(deposits).values({ userId, asset, network: transfer.network, providerId: PROVIDER_ID,
      address: transfer.toAddress, externalId: `${PROVIDER_ID}:${transfer.network}:${transfer.txHash}:${transfer.logIndex}`,
      amount: transfer.amount, status: 'pending' }).returning();
    const { transactionId } = await post(tx, { kind: 'deposit', reference: `deposit:${deposit!.id}`,
      postings: move(accounts.external(asset), accounts.userWallet(userId, asset), transfer.amount),
      metadata: { network: transfer.network, providerId: PROVIDER_ID, txHash: transfer.txHash, logIndex: transfer.logIndex } });
    await tx.update(deposits).set({ status: 'credited', ledgerTransactionId: transactionId, creditedAt: new Date() }).where(eq(deposits.id, deposit!.id));
    return deposit!.id;
  }

  // ─── Operator ────────────────────────────────────────────────────────────

  private transferDto(row: TransferRow): WalletTransferDto {
    return { id: row.id, network: row.network as WatchNetwork, asset: row.asset as WalletAsset, amount: fromMinor(row.amount, row.asset as WalletAsset),
      exact: row.exact, from: row.fromAddress, to: row.toAddress, txHash: row.txHash, explorerUrl: `${EXPLORERS[row.network as WatchNetwork]}${row.txHash}`,
      blockTime: row.blockTime.toISOString(), status: row.status as WalletTransferDto['status'], userId: row.userId };
  }

  async unmatched(): Promise<WalletTransferDto[]> {
    const rows = await this.db.select().from(walletTransfers).where(eq(walletTransfers.status, 'unmatched')).orderBy(desc(walletTransfers.blockTime)).limit(100);
    return rows.map(row => this.transferDto(row));
  }

  /** An operator credits an unrecognised transfer (a very late payment) to a client after checking it. */
  async assign(actorUserId: string, transferId: string, userId: string): Promise<WalletTransferDto> {
    return this.db.transaction(async tx => {
      const [target] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!target) throw new AppError('not_found', 'Клиент не найден');
      const [transfer] = await tx.select().from(walletTransfers).where(eq(walletTransfers.id, transferId)).for('update');
      if (!transfer || transfer.status !== 'unmatched') throw new AppError('validation', 'Этот платёж уже зачислен или ещё проверяется. Обновите список.');
      const depositId = await this.credit(tx, userId, transfer);
      const [updated] = await tx.update(walletTransfers).set({ status: 'assigned', userId, depositId, resolvedAt: new Date() })
        .where(eq(walletTransfers.id, transfer.id)).returning();
      await tx.insert(adminAuditLog).values({ actorUserId, targetUserId: userId, action: 'wallet_transfer_assign', reference: transfer.id,
        metadata: { network: transfer.network, asset: transfer.asset, amount: transfer.amount.toString(), txHash: transfer.txHash } });
      const moved = await this.moveApplication(tx, { userId, asset: transfer.asset as WalletAsset, leaseId: null });
      if (!moved) await notify(tx, userId, { type: 'fee_paid', amount: fromMinor(transfer.amount, transfer.asset as WalletAsset), asset: transfer.asset });
      return this.transferDto(updated!);
    });
  }
}

