import { describe, expect, it } from 'vitest';
import { scanEvm, scanTron } from '../../src/payments/chain-watch';

const lent = '0x27ABFbd775d68b692fdF1e15B87d915C3E458404';
const other = '0x46FDf83EC403a822468b25Cb771F200A65a8a5CF';
const tronWallet = 'TQ1TkHLPYPKn9wBRUySxD3pXZt4sb5bhZx';
const pad = (address: string) => `0x${address.toLowerCase().slice(2).padStart(64, '0')}`;
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function rpcFetch(handlers: Record<string, (params: any[]) => unknown>, calls: { method: string; params: any[] }[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ method: body.method, params: body.params });
    return Response.json({ jsonrpc: '2.0', id: 1, result: handlers[body.method]!(body.params) });
  }) as unknown as typeof fetch;
}

describe('EVM app wallet scan', () => {
  it('reads confirmed USDT/USDC transfers to the lent addresses only, keeping 18-decimal precision honest', async () => {
    const calls: { method: string; params: any[] }[] = [];
    const fetcher = rpcFetch({
      eth_blockNumber: () => '0x3e8',
      eth_getLogs: () => [
        { address: '0x55d398326f99059fF775485246999027B3197955', topics: [transfer, pad('0x1111111111111111111111111111111111111111'), pad(lent)],
          data: `0x${(10_000_000_000_000_000_000n).toString(16)}`, blockNumber: '0x3e0', transactionHash: hash(1), logIndex: '0x2' },
        // 10.0000001 BSC-USD is recorded, but marked as more precise than the ledger.
        { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', topics: [transfer, pad('0x2222222222222222222222222222222222222222'), pad(other)],
          data: `0x${(10_000_000_100_000_000_000n).toString(16)}`, blockNumber: '0x3e0', transactionHash: hash(2), logIndex: '0x0' },
        // Another token contract and a transfer to someone else are ignored.
        { address: '0x0000000000000000000000000000000000000bad', topics: [transfer, pad(lent), pad(lent)], data: '0x1', blockNumber: '0x3e0', transactionHash: hash(3), logIndex: '0x0' },
        { address: '0x55d398326f99059fF775485246999027B3197955', topics: [transfer, pad(lent), pad('0x3333333333333333333333333333333333333333')], data: '0x1', blockNumber: '0x3e0', transactionHash: hash(4), logIndex: '0x0' },
      ],
      eth_getBlockByNumber: () => ({ timestamp: '0x6720f000' }),
    }, calls);
    const result = await scanEvm('BEP20', 'https://rpc.test', [lent, other], '900', Date.now() - 60_000, fetcher);
    expect(result).toMatchObject({ cursor: '985', done: true });
    expect(result.transfers).toEqual([
      { network: 'BEP20', asset: 'USDT', txHash: hash(1), logIndex: 2, from: '0x1111111111111111111111111111111111111111', to: lent.toLowerCase(),
        amount: 10_000_000n, exact: true, blockNumber: 992n, blockTime: new Date(0x6720f000 * 1000) },
      { network: 'BEP20', asset: 'USDC', txHash: hash(2), logIndex: 0, from: '0x2222222222222222222222222222222222222222', to: other.toLowerCase(),
        amount: 10_000_000n, exact: false, blockNumber: 992n, blockTime: new Date(0x6720f000 * 1000) },
    ]);
    expect(calls.find(call => call.method === 'eth_getLogs')!.params[0]).toMatchObject({ fromBlock: '0x385', toBlock: '0x3d9',
      topics: [transfer, null, [pad(lent), pad(other)]] });
  });

  it('starts near the moment the address was lent instead of an old cursor, and reads in bounded chunks', async () => {
    const fetcher = rpcFetch({ eth_blockNumber: () => '0x2710', eth_getLogs: () => [], eth_getBlockByNumber: () => ({ timestamp: '0x1' }) });
    // Ethereum: 12 s blocks, lent 2 minutes ago → about 33 blocks back from the confirmed head 9988.
    const fresh = await scanEvm('ERC20', 'https://rpc.test', [lent], '100', Date.now() - 120_000, fetcher);
    expect(fresh.done).toBe(true);
    expect(fresh.cursor).toBe('9988');
    const behind = await scanEvm('ERC20', 'https://rpc.test', [lent], '5000', Date.now() - 24 * 60 * 60_000, fetcher);
    expect(behind).toEqual({ transfers: [], cursor: '6000', done: false });
  });
});

describe('Tron app wallet scan', () => {
  it('reads confirmed USDT TRC20 transfers to the address since the lease', async () => {
    let requested = '';
    const fetcher = (async (url: string) => {
      requested = url;
      return Response.json({ success: true, data: [
        { transaction_id: 'a'.repeat(64), token_info: { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 }, block_timestamp: 1_800_000_000_000,
          from: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', to: tronWallet, type: 'Transfer', value: '10000000' },
        { transaction_id: 'b'.repeat(64), token_info: { address: 'TFakeTokenContract1111111111111111', decimals: 6 }, block_timestamp: 1_800_000_000_500,
          from: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', to: tronWallet, type: 'Transfer', value: '10000000' },
      ] });
    }) as unknown as typeof fetch;
    const transfers = await scanTron('https://api.trongrid.test', undefined, tronWallet, 1_799_999_999_000, fetcher);
    expect(new URL(requested).searchParams.get('only_confirmed')).toBe('true');
    expect(new URL(requested).searchParams.get('min_timestamp')).toBe('1799999999000');
    expect(transfers).toEqual([{ network: 'TRC20', asset: 'USDT', txHash: 'a'.repeat(64), logIndex: 0, from: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
      to: tronWallet, amount: 10_000_000n, exact: true, blockNumber: null, blockTime: new Date(1_800_000_000_000) }]);
  });
});
