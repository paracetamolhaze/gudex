import type { WalletAsset } from '@gudex/shared';

// Reads incoming USDT/USDC transfers to the app wallet from public blockchain APIs.
// Only public addresses are involved; nothing here can move funds.

export type WatchNetwork = 'TRC20' | 'BEP20' | 'ERC20' | 'POLYGON';
export const WATCH_NETWORKS: WatchNetwork[] = ['TRC20', 'BEP20', 'ERC20', 'POLYGON'];

export interface ChainTransfer {
  network: WatchNetwork;
  asset: WalletAsset;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  // Six-decimal minor units, like the GUDEX ledger.
  amount: bigint;
  exact: boolean;
  blockNumber: bigint | null;
  blockTime: Date;
}

export interface ScanResult { transfers: ChainTransfer[]; cursor: string; done: boolean }
type Fetch = typeof fetch;

interface Token { asset: WalletAsset; contract: string; decimals: number }
export const TOKENS: Record<WatchNetwork, Token[]> = {
  TRC20: [{ asset: 'USDT', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 }],
  BEP20: [
    { asset: 'USDT', contract: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
    { asset: 'USDC', contract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
  ],
  ERC20: [
    { asset: 'USDT', contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
    { asset: 'USDC', contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  ],
  POLYGON: [
    { asset: 'USDT', contract: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6 },
    { asset: 'USDC', contract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
  ],
};

export const EXPLORERS: Record<WatchNetwork, string> = {
  TRC20: 'https://tronscan.org/#/transaction/',
  BEP20: 'https://bscscan.com/tx/',
  ERC20: 'https://etherscan.io/tx/',
  POLYGON: 'https://polygonscan.com/tx/',
};

// Blocks behind the head before a transfer counts; Tron uses only confirmed (solidified) transfers.
const CONFIRMATIONS: Record<Exclude<WatchNetwork, 'TRC20'>, bigint> = { BEP20: 15n, ERC20: 12n, POLYGON: 64n };
// Average block time, to start reading near the moment an address was lent instead of at the chain start.
const BLOCK_MS: Record<Exclude<WatchNetwork, 'TRC20'>, number> = { BEP20: 750, ERC20: 12_000, POLYGON: 2_000 };
const BLOCK_CHUNK = 1000n;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TIMEOUT_MS = 8000;

function toMinor6(value: bigint, decimals: number): { amount: bigint; exact: boolean } {
  if (decimals === 6) return { amount: value, exact: true };
  if (decimals > 6) {
    const unit = 10n ** BigInt(decimals - 6);
    return { amount: value / unit, exact: value % unit === 0n };
  }
  return { amount: value * 10n ** BigInt(6 - decimals), exact: true };
}

async function json(fetchImpl: Fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Blockchain API HTTP ${response.status}`);
  return response.json();
}

async function rpc<T>(fetchImpl: Fetch, url: string, method: string, params: unknown[]): Promise<T> {
  const body = await json(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }) as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) throw new Error(`RPC ${method} failed: ${body.error?.message ?? 'no result'}`);
  return body.result;
}

const hex = (value: bigint) => `0x${value.toString(16)}`;
const isHash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

/** One bounded step of an EVM scan for transfers to any of the addresses, from the stored block cursor
 * (exclusive) but never earlier than the moment `sinceMs` the oldest address was lent. */
export async function scanEvm(network: Exclude<WatchNetwork, 'TRC20'>, rpcUrl: string, addresses: string[], cursor: string | null,
  sinceMs: number, fetchImpl: Fetch = fetch): Promise<ScanResult> {
  const tokens = TOKENS[network];
  const latest = BigInt(await rpc<string>(fetchImpl, rpcUrl, 'eth_blockNumber', []));
  const safe = latest - CONFIRMATIONS[network];
  const back = BigInt(Math.ceil(Math.max(0, Date.now() - sinceMs) / BLOCK_MS[network] * 1.3) + 20);
  const floor = safe - back;
  const from = cursor === null || BigInt(cursor) + 1n < floor ? floor : BigInt(cursor) + 1n;
  if (from > safe) return { transfers: [], cursor: cursor ?? safe.toString(), done: true };
  const to = from + BLOCK_CHUNK - 1n < safe ? from + BLOCK_CHUNK - 1n : safe;
  const recipients = new Map(addresses.map(address => [`0x${address.toLowerCase().slice(2).padStart(64, '0')}`, address.toLowerCase()]));
  const logs = await rpc<unknown[]>(fetchImpl, rpcUrl, 'eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to),
    address: tokens.map(token => token.contract), topics: [TRANSFER_TOPIC, null, [...recipients.keys()]] }]);
  if (!Array.isArray(logs)) throw new Error('RPC eth_getLogs returned an unexpected shape');
  const times = new Map<string, Date>();
  const transfers: ChainTransfer[] = [];
  for (const raw of logs) {
    const log = raw as Record<string, unknown>;
    const token = tokens.find(item => item.contract === String(log.address).toLowerCase());
    const topics = Array.isArray(log.topics) ? log.topics as unknown[] : [];
    const recipient = recipients.get(String(topics[2]).toLowerCase());
    if (!token || !recipient || log.removed === true || topics.length !== 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC
      || !isHash(log.transactionHash) || typeof log.blockNumber !== 'string'
      || typeof log.logIndex !== 'string' || typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(log.data)) continue;
    const blockNumber = BigInt(log.blockNumber);
    let time = times.get(log.blockNumber);
    if (!time) {
      const block = await rpc<{ timestamp?: string }>(fetchImpl, rpcUrl, 'eth_getBlockByNumber', [log.blockNumber, false]);
      if (typeof block?.timestamp !== 'string') throw new Error('RPC block has no timestamp');
      time = new Date(Number(BigInt(block.timestamp)) * 1000);
      times.set(log.blockNumber, time);
    }
    transfers.push({ network, asset: token.asset, txHash: log.transactionHash.toLowerCase(), logIndex: Number(BigInt(log.logIndex)),
      from: `0x${String(topics[1]).slice(26).toLowerCase()}`, to: recipient, ...toMinor6(BigInt(log.data), token.decimals),
      blockNumber, blockTime: time });
  }
  return { transfers, cursor: to.toString(), done: to === safe };
}

/** Confirmed TRC20 USDT transfers to one address since `sinceMs` (re-reading is harmless: transfers are de-duplicated). */
export async function scanTron(baseUrl: string, apiKey: string | undefined, address: string, sinceMs: number,
  fetchImpl: Fetch = fetch): Promise<ChainTransfer[]> {
  const token = TOKENS.TRC20[0]!;
  const url = new URL(`/v1/accounts/${address}/transactions/trc20`, baseUrl);
  for (const [key, value] of Object.entries({ only_to: 'true', only_confirmed: 'true', limit: '200', order_by: 'block_timestamp,asc',
    contract_address: token.contract, min_timestamp: String(Math.floor(sinceMs)) })) url.searchParams.set(key, value);
  const body = await json(fetchImpl, url.toString(), { headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {} }) as { data?: unknown; success?: boolean };
  if (body.success === false || !Array.isArray(body.data)) throw new Error('TronGrid returned an unexpected shape');
  const transfers: ChainTransfer[] = [];
  for (const raw of body.data) {
    const row = raw as Record<string, unknown>;
    const info = row.token_info as Record<string, unknown> | undefined;
    const time = Number(row.block_timestamp);
    if (!Number.isSafeInteger(time) || row.type !== 'Transfer' || row.to !== address || info?.address !== token.contract || Number(info?.decimals) !== token.decimals
      || typeof row.transaction_id !== 'string' || !/^[0-9a-fA-F]{64}$/.test(row.transaction_id)
      || typeof row.from !== 'string' || typeof row.value !== 'string' || !/^\d{1,40}$/.test(row.value)) continue;
    transfers.push({ network: 'TRC20', asset: token.asset, txHash: row.transaction_id.toLowerCase(), logIndex: 0, from: row.from, to: address,
      ...toMinor6(BigInt(row.value), token.decimals), blockNumber: null, blockTime: new Date(time) });
  }
  return transfers;
}
