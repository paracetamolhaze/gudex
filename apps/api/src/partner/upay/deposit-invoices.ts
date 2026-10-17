import { fromMinor, type Network, type WalletAsset } from '@gudex/shared';
import type { Config } from '../../config';
import type { UpayClient } from './client';
import { UpayError } from './transport';

type Row = Record<string, unknown>;
type InvoiceClient = Pick<UpayClient, 'configured' | 'readRequest' | 'createDepositInvoice'>;
export interface UpayInvoiceOption { asset: WalletAsset; network: Network; minAmount: string; maxAmount: string; decimals: number; }
export interface UpayInvoiceReceipt { receiptId: string; orderNo: string; asset: WalletAsset; network: Network; amount: bigint; }
export interface UpayInvoiceInspection { state: 'processing' | 'paid' | 'expired'; receipt: UpayInvoiceReceipt | null; }
type ReadinessStage = 'configuration' | 'catalog_read' | 'catalog_shape' | 'catalog_identifier' | 'catalog_precision' | 'catalog_minimum'
  | 'chains_shape' | 'chain_duplicate' | 'chain_identifier' | 'support_read' | 'support_shape'
  | 'provider_duplicate' | 'provider_chains' | 'provider_bounds' | 'complete';
export interface UpayInvoiceReadiness {
  configured: boolean; ready: boolean; mutationsPerformed: false; stage: ReadinessStage;
  catalogShape: unknown; catalogRowCount: number | null; stablecoinCount: number | null; optionCount: number;
  currentPair: { asset: WalletAsset; network: Network } | null;
  checks: { asset: WalletAsset; network: Network; chainShape: unknown; supportShape: unknown; quickSupported: boolean; hasPtf: boolean }[];
  error: { kind: 'deadline' | 'upay_error' | 'unexpected_error'; code: number | null; httpStatus: number | null; retryable: boolean } | null;
}
export interface NativeDepositInvoices {
  readonly configured: boolean;
  options(): Promise<UpayInvoiceOption[]>;
  create(input: { asset: WalletAsset; network: Network; amount: bigint; beforeDispatch?: () => Promise<void> }):
    Promise<{ orderNo: string; url: string; expiresAt: Date | null }>;
  inspect(input: { orderNo: string; asset: WalletAsset; network: Network }): Promise<UpayInvoiceInspection>;
  inspectInvoiceReadiness?(): Promise<UpayInvoiceReadiness>;
}

const SCALE = 1_000_000n;
const MAX_AMOUNT = 100_000n * SCALE;
const READ_BUDGET_MS = 15_000;
// These pairs were verified against the native catalog and quick/deposit/check.
// New networks require evidence rather than silently inheriting generic wallet networks.
const PAIRS = new Set(['USDT:TRC20', 'USDT:BEP20', 'USDC:BEP20']);
const bad = (label: string, dispatched = false): never => {
  throw new UpayError(`UPay invoice ${label} is unavailable or inconsistent`, dispatched, undefined,
    { phase: dispatched ? 'post_dispatched' : 'pre_dispatch', ack: 'unconfirmed' });
};
const row = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const id = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value :
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
function shape(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (depth > 3) return 'nested';
  if (Array.isArray(value)) return { type: 'array', sample: value.length ? shape(value[0], depth + 1) : null };
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Row).slice(0, 60)
    .filter(([key]) => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)).map(([key, item]) => [key, shape(item, depth + 1)]));
  return typeof value;
}
function minor(value: unknown, label: string, dispatched = false): bigint {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,12}(?:\.\d{1,12})?$/.test(text)) return bad(label, dispatched);
  const [whole, fraction = ''] = text.split('.');
  if (/[^0]/.test(fraction.slice(6))) return bad(label, dispatched);
  return BigInt(whole!) * SCALE + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
}
function rows(value: unknown, label: string): Row[] {
  const source = Array.isArray(value) ? value : row(value)?.list;
  if (!Array.isArray(source) || source.length > 2000 || source.some(item => !row(item))) return bad(label);
  return source as Row[];
}
function expiry(value: unknown): Date | null {
  // A timezone-free wall-clock string is not a portable timestamp. Native status3
  // remains authoritative for expiry when the server supplies no offset.
  let time: number;
  if (typeof value === 'number' && Number.isSafeInteger(value)) time = value < 100_000_000_000 ? value * 1000 : value;
  else if (typeof value === 'string' && /^\d{10}(?:\d{3})?$/.test(value)) time = value.length === 10 ? Number(value) * 1000 : Number(value);
  else if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) time = Date.parse(value);
  else return null;
  return Number.isFinite(time) && time > 0 && time <= 8_640_000_000_000_000 ? new Date(time) : null;
}
function checkout(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) return bad('checkout receipt', true);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'quick.upay.best' || url.username || url.password || url.port) return bad('checkout receipt', true);
    return value;
  } catch { return bad('checkout receipt', true); }
}

/** Native merchant invoice binding. This module never allocates a shared address
 * or treats a requested/paid amount as received merchant funds. */
export class UpayDepositInvoices implements NativeDepositInvoices {
  constructor(private readonly config: Config, private readonly client: InvoiceClient) {}
  get configured(): boolean { return this.config.CARD_PARTNER === 'upay' && this.client.configured; }

  private assertDeadline(deadline: number, preDispatch = false): void {
    if (Date.now() >= deadline) throw new UpayError('UPay invoice verification deadline reached', true, undefined,
      preDispatch ? { phase: 'pre_dispatch', ack: 'unconfirmed' } : undefined);
  }
  private async read(deadline: number, endpoint: string, options: { query?: Record<string, string | number> } = {}): Promise<unknown> {
    this.assertDeadline(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Only reads are raced. A delayed authentication/GET can finish harmlessly;
      // this invocation will issue no further read or invoice POST afterwards.
      const result = await Promise.race([this.client.readRequest('GET', endpoint, options), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UpayError('UPay invoice verification deadline reached', true)), Math.max(1, deadline - Date.now()));
      })]);
      this.assertDeadline(deadline);
      return result;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private async catalog(deadline: number, trace?: UpayInvoiceReadiness): Promise<{ option: UpayInvoiceOption; coinId: string; chainId: string; min: bigint; max: bigint; quantum: bigint }[]> {
    const stage = (value: ReadinessStage) => { if (trace) trace.stage = value; };
    stage('catalog_read');
    const source = await this.read(deadline, '/asset/coin/list');
    stage('catalog_shape');
    if (trace) trace.catalogShape = shape(source);
    const coins = rows(source, 'catalog');
    if (trace) { trace.catalogRowCount = coins.length; trace.stablecoinCount = coins.filter(coin => coin.symbol === 'USDT' || coin.symbol === 'USDC').length; }
    const result: { option: UpayInvoiceOption; coinId: string; chainId: string; min: bigint; max: bigint; quantum: bigint }[] = [];
    const seen = new Set<string>();
    for (const coin of coins) {
      if (coin.symbol !== 'USDT' && coin.symbol !== 'USDC') continue;
      const asset = coin.symbol;
      if (trace) trace.currentPair = null;
      stage('catalog_identifier');
      const coinId = id(coin.coinId);
      if (!coinId) return bad('catalog');
      // Native catalog decimals governs invoice input precision. It is 2 for
      // stablecoins today, independently of the wallet's six-decimal base unit.
      const decimals = coin.decimals;
      stage('catalog_precision');
      if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 6) return bad('catalog');
      const quantum = 10n ** BigInt(6 - decimals);
      stage('catalog_minimum');
      const minimum = minor(coin.inMinAmount, 'minimum');
      const rawMin = minimum > SCALE ? minimum : SCALE;
      const min = ((rawMin + quantum - 1n) / quantum) * quantum;
      if (min > MAX_AMOUNT) continue;
      stage('chains_shape');
      for (const chain of rows(coin.chainListRes, 'chains')) {
        const pair = `${asset}:${String(chain.chainTag)}`;
        if (!PAIRS.has(pair) || chain.inStatus !== 1) continue;
        if (trace) trace.currentPair = { asset, network: chain.chainTag as Network };
        stage('chain_duplicate');
        if (seen.has(pair)) return bad('duplicate catalog binding');
        seen.add(pair);
        stage('chain_identifier');
        const chainId = id(chain.chainId);
        if (!chainId) return bad('chain');
        stage('support_read');
        const check = row(await this.read(deadline, '/quick/deposit/check', { query: { coinId, chainId } }));
        stage('support_shape');
        const quickSupported = check?.isSupportQuickDeposit === 1;
        const ptf = Array.isArray(check?.ditchInfos) ? check.ditchInfos.map(row).filter((item): item is Row => item?.ditchCode === 'PTF') : [];
        const hasPtf = ptf.length > 0;
        if (trace) trace.checks.push({ asset, network: chain.chainTag as Network, chainShape: shape(chain), supportShape: shape(check), quickSupported, hasPtf });
        if (!quickSupported || !hasPtf) continue;
        stage('provider_duplicate');
        if (ptf.length !== 1) return bad('duplicate checkout provider');
        const provider = ptf[0]!;
        stage('provider_chains');
        if (!Array.isArray(provider.chainInfos)) return bad('checkout provider chains');
        const providerChains = rows(provider.chainInfos, 'checkout provider chains').filter(item => id(item.chainId) === chainId);
        // Native chainInfos.symbol is the network (TRC20/BEP20), not USDT/USDC.
        if (providerChains.length !== 1 || providerChains[0]!.symbol !== chain.chainTag) return bad('checkout provider chain binding');
        stage('provider_bounds');
        const providerMin = minor(provider.minAmount, 'checkout provider minimum');
        const providerMax = minor(provider.maxAmount, 'checkout provider maximum');
        if (providerMin <= 0n || providerMax < providerMin) return bad('checkout provider bounds');
        const lower = providerMin > min ? providerMin : min;
        const upper = providerMax < MAX_AMOUNT ? providerMax : MAX_AMOUNT;
        const effectiveMin = ((lower + quantum - 1n) / quantum) * quantum;
        const effectiveMax = upper / quantum * quantum;
        if (effectiveMin > effectiveMax) return bad('checkout provider bounds');
        result.push({ option: { asset, network: chain.chainTag as Network, minAmount: fromMinor(effectiveMin, asset), maxAmount: fromMinor(effectiveMax, asset), decimals },
          coinId, chainId, min: effectiveMin, max: effectiveMax, quantum });
      }
    }
    return result;
  }

  /** OPS diagnostic runs the exact production catalog validation. Only fixed
   * stage names, numeric error codes and structural field types leave it. */
  async inspectInvoiceReadiness(): Promise<UpayInvoiceReadiness> {
    const result: UpayInvoiceReadiness = { configured: this.configured, ready: false, mutationsPerformed: false, stage: 'configuration',
      catalogShape: null, catalogRowCount: null, stablecoinCount: null, optionCount: 0, currentPair: null, checks: [], error: null };
    if (!this.configured) return result;
    const deadline = Date.now() + READ_BUDGET_MS;
    try {
      const options = await this.catalog(deadline, result);
      result.optionCount = options.length;
      result.ready = options.length > 0;
      result.stage = 'complete';
      return result;
    } catch (error) {
      result.error = { kind: Date.now() >= deadline ? 'deadline' : error instanceof UpayError ? 'upay_error' : 'unexpected_error',
        code: error instanceof UpayError ? error.code ?? null : null,
        httpStatus: error instanceof UpayError ? error.metadata?.httpStatus ?? null : null,
        retryable: error instanceof UpayError ? error.retryable : true };
      return result;
    }
  }

  async options(): Promise<UpayInvoiceOption[]> { return this.configured ? (await this.catalog(Date.now() + READ_BUDGET_MS)).map(item => item.option) : []; }

  async create(input: { asset: WalletAsset; network: Network; amount: bigint; beforeDispatch?: () => Promise<void> }): Promise<{ orderNo: string; url: string; expiresAt: Date | null }> {
    const deadline = Date.now() + READ_BUDGET_MS;
    if (!this.configured || !this.config.UPAY_INVOICE_DEPOSITS_ENABLED) return bad('capability');
    if (!PAIRS.has(`${input.asset}:${input.network}`) || typeof input.amount !== 'bigint' || input.amount <= 0n || input.amount > MAX_AMOUNT) return bad('amount or network');
    let selected: Awaited<ReturnType<UpayDepositInvoices['catalog']>>[number];
    try {
      const candidate = (await this.catalog(deadline)).find(item => item.option.asset === input.asset && item.option.network === input.network);
      if (!candidate || input.amount < candidate.min || input.amount > candidate.max || input.amount % candidate.quantum !== 0n) return bad('minimum, maximum, precision or network');
      selected = candidate;
    } catch (error) {
      // A generic transport error may describe a dispatched catalog GET. At this
      // boundary no invoice POST has started, so an explicit client retry is safe.
      throw new UpayError('UPay invoice pre-dispatch checks are unavailable', error instanceof UpayError ? error.retryable : true,
        error instanceof UpayError ? error.code : undefined, { phase: 'pre_dispatch', ack: 'unconfirmed' });
    }
    // Keep this outside the preflight catch: every failure after the one-shot
    // client starts its POST retains the original uncertain dispatch metadata.
    const response = row(await this.client.createDepositInvoice({ coinId: selected.coinId, chainId: selected.chainId,
      amount: Number(fromMinor(input.amount, input.asset)), ditchCode: 'PTF' }, { beforeDispatch: async () => {
        this.assertDeadline(deadline, true);
        await input.beforeDispatch?.();
        this.assertDeadline(deadline, true);
      } }));
    const orderNo = id(response?.orderNo);
    if (!response || !orderNo) return bad('creation receipt', true);
    return { orderNo, url: checkout(response.url), expiresAt: expiry(response.expireTime) };
  }

  async inspect(input: { orderNo: string; asset: WalletAsset; network: Network }): Promise<UpayInvoiceInspection> {
    const deadline = Date.now() + READ_BUDGET_MS;
    if (!id(input.orderNo) || !PAIRS.has(`${input.asset}:${input.network}`)) return bad('binding');
    const info = row(await this.read(deadline, '/quick/deposit/info', { query: { orderNo: input.orderNo } }));
    if (id(info?.orderNo) !== input.orderNo || ![1, 2, 3].includes(info?.status as number)) return bad('status receipt', true);
    if (info!.status !== 2) return { state: info!.status === 1 ? 'processing' : 'expired', receipt: null };
    const bill = await this.exactBill(input.orderNo, deadline);
    if (!bill) return { state: 'paid', receipt: null };
    const receiptId = id(bill.id)!;
    const envelope = row(await this.read(deadline, '/bill/info', { query: { id: receiptId } }));
    const detail = row(envelope?.outInInfo);
    if (!detail || id(detail.orderNo) !== input.orderNo || (detail.id !== undefined && id(detail.id) !== receiptId)) return bad('bill identity', true);
    if (detail.type !== 1 || detail.sonType !== 8 || detail.state !== 1 || detail.inOut !== 1 || detail.receiptType !== 1) return { state: 'paid', receipt: null };
    if (detail.symbol !== input.asset || (bill.symbol !== undefined && bill.symbol !== input.asset)) return bad('bill currency', true);
    if ((detail.chainTag !== undefined && detail.chainTag !== input.network) ||
        (row(detail.quickPayInfo)?.chainTag !== undefined && row(detail.quickPayInfo)!.chainTag !== input.network)) return bad('bill network', true);
    const amount = minor(detail.intoAmount, 'received amount', true);
    const gross = minor(detail.amount, 'gross amount', true);
    const fee = minor(detail.fee, 'fee amount', true);
    // These are three independently reported receipt values. Do not manufacture
    // a net amount using gross-fee: the native UI does not establish that identity.
    if (amount <= 0n || gross <= 0n || amount > MAX_AMOUNT || gross > MAX_AMOUNT || fee > gross || amount > gross) return bad('bill amounts', true);
    return { state: 'paid', receipt: { receiptId, orderNo: input.orderNo, asset: input.asset, network: input.network, amount } };
  }

  private async exactBill(orderNo: string, deadline: number): Promise<Row | null> {
    const matches: Row[] = [];
    let count = 0;
    let expectedTotal: number | null = null;
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      const response = row(await this.read(deadline, '/bill/list', { query: { orderNo, type: 1, orderType: 1, pageNo, pageSize: 100 } }));
      const total = response?.totalSize;
      if (!response || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > 2000 ||
          (expectedTotal !== null && expectedTotal !== total)) return bad('bill pagination', true);
      expectedTotal = total;
      const list = rows(response, 'bill page');
      if (list.length > 100 || (list.length === 0 && count < total)) return bad('bill pagination', true);
      count += list.length;
      for (const item of list) {
        if (id(item.orderNo) !== orderNo) continue;
        if (!id(item.id)) return bad('bill identifier', true);
        matches.push(item);
      }
      if (count > total || matches.length > 1) return bad('ambiguous bill receipt', true);
      if (count === total) return matches[0] ?? null;
    }
    return bad('incomplete bill lookup', true);
  }
}
