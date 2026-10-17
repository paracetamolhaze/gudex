import { describe, expect, it } from 'vitest';
import type { UpayClient } from '../../src/partner/upay/client';
import { UpayError } from '../../src/partner/upay/transport';
import { inspectUpayWalletReadiness } from '../../src/partner/upay/wallet-readiness';

describe('read-only UPay wallet discovery', () => {
  it('reports exact ownership relationships and supported chains without exposing private values', async () => {
    const calls: { method: string; endpoint: string }[] = [];
    const secretCustomer = 'PRIVATE-CUSTOMER-1', secretAddress = 'PRIVATE-ADDRESS-1', secretHash = 'PRIVATE-HASH-1';
    const fixtures: Record<string, unknown> = {
      '/asset/coin/list': [{ symbol: 'USDT', coinId: 'private-coin-id', chainListRes: [
        { chainTag: 'TRC20', inStatus: 1, outStatus: 1 }, { chainTag: 'ERC20', inStatus: 0, outStatus: 1 },
      ] }, { symbol: 'USDC', chainListRes: [{ chainTag: 'ERC20', inStatus: 1, outStatus: 1 }] }],
      '/wallet/address/list': { list: [{ customerNo: secretCustomer, address: secretAddress, chainTag: 'TRC20' }], totalSize: 1 },
      '/wallet/deposit/list': { list: [{ customerNo: secretCustomer, txHash: secretHash, state: 1, riskCoinStatus: 2, amount: '9182.65' }], totalSize: 1 },
      '/wallet/deposit/depositType/list': [{ code: 1, desc: 'PRIVATE-UNTRUSTED-LABEL' }],
      '/wallet/deposit/state/list': [{ code: 1, desc: 'PRIVATE-UNTRUSTED-LABEL' }],
      '/wallet/deposit/riskCoinStatus/list': [{ code: 2, desc: 'PRIVATE-UNTRUSTED-LABEL' }],
      '/coin/chain/coinSel': [{ symbol: 'USDT', coinId: 'private-coin-id' }],
      '/coin/chain/chainSel': [{ chainTag: 'TRC20', chainId: 'private-chain-id' }],
      '/customer/list': { list: [{ no: secretCustomer, email: 'private@example.test' }] },
    };
    const client = { readRequest: async (method: string, endpoint: string) => { calls.push({ method, endpoint }); return fixtures[endpoint]; } } as unknown as Pick<UpayClient, 'readRequest'>;
    const result = await inspectUpayWalletReadiness(client);
    expect(result).toMatchObject({ mutationsPerformed: false, readyForCustomerDeposits: false,
      addressEvidence: { allSampleRowsHaveCustomerBinding: true, someOwnersMatchListedCustomers: true, sharedAddressAcrossSampleCustomers: false },
      depositEvidence: { someCustomersMatchAddressOwners: true, transactionHashFieldPresent: true, confirmationFieldPresent: false, amlFieldPresent: true },
    });
    expect(result.merchantAssetNetworks).toEqual([
      { asset: 'USDT', chains: [{ network: 'TRC20', depositsEnabled: true, withdrawalsEnabled: true, confirmationFieldsPresent: false, tokenContractFieldPresent: false },
        { network: 'ERC20', depositsEnabled: false, withdrawalsEnabled: true, confirmationFieldsPresent: false, tokenContractFieldPresent: false }] },
      { asset: 'USDC', chains: [{ network: 'ERC20', depositsEnabled: true, withdrawalsEnabled: true, confirmationFieldsPresent: false, tokenContractFieldPresent: false }] },
    ]);
    const output = JSON.stringify(result);
    for (const privateValue of [secretCustomer, secretAddress, secretHash, 'private@example.test', 'private-coin-id', 'private-chain-id', '9182.65', 'PRIVATE-UNTRUSTED-LABEL']) expect(output).not.toContain(privateValue);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.some(call => /withdraw|\/asset\/address|submit|create|add/.test(call.endpoint.replace('/wallet/address/list', '')))).toBe(false);
  });

  it('flags a shared address and never promotes empty/error responses into verified custody', async () => {
    const client = { readRequest: async (_method: string, endpoint: string) => {
      if (endpoint === '/wallet/address/list') return { list: [
        { customerNo: 'PRIVATE-ONE', address: 'PRIVATE-SHARED', chainTag: 'TON', memo: 'PRIVATE-MEMO-1' },
        { customerNo: 'PRIVATE-TWO', address: 'PRIVATE-SHARED', chainTag: 'TON', memo: 'PRIVATE-MEMO-2' },
      ], totalSize: 2 };
      throw new UpayError('PRIVATE-ERROR-DETAIL', true, 403);
    } } as unknown as Pick<UpayClient, 'readRequest'>;
    const result = await inspectUpayWalletReadiness(client);
    expect(result).toMatchObject({ readyForCustomerDeposits: false,
      addressEvidence: { sharedAddressAcrossSampleCustomers: true, memoFieldPresent: true },
      depositEvidence: { allSampleRowsHaveCustomerBinding: false, confirmationFieldPresent: false },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-');
    expect((result.probes as Record<string, unknown>).assetCoins).toEqual({ ok: false, code: 403 });
  });

  it('checks only two customers with existing cards and follows verified wallet row IDs without exposing values', async () => {
    const calls: { method: string; endpoint: string; options: { query?: Record<string, string | number>; body?: Record<string, unknown> } }[] = [];
    const customers = ['PRIVATE-CUSTOMER-A', 'PRIVATE-CUSTOMER-B', 'PRIVATE-CUSTOMER-C'];
    const client = { readRequest: async (method: string, endpoint: string, options: typeof calls[number]['options'] = {}) => {
      calls.push({ method, endpoint, options });
      if (endpoint === '/card/list') return { list: [
        { customerNo: customers[0], agentCustomerCardId: 'PRIVATE-CARD-A1', cardNumber: 'PRIVATE-PAN' },
        { customerNo: customers[0], agentCustomerCardId: 'PRIVATE-CARD-A2' },
        { customerNo: customers[1], agentCustomerCardId: 'PRIVATE-CARD-B1' },
        { customerNo: customers[2], agentCustomerCardId: 'PRIVATE-CARD-C1' },
      ], totalSize: 4 };
      if (endpoint === '/asset/list') return { list: [{ id: 'PRIVATE-MERCHANT-ASSET', userId: 'PRIVATE-MERCHANT', balance: '12345.67' }], totalSize: 1 };
      const customer = options.query?.agentCustomerNo ?? options.body?.customerNo;
      if (endpoint === '/wallet/asset/list') return { list: [{ id: `${customer}-ASSET`, agentCustomerNo: customer, symbol: 'USDT', balance: '12345.67' }], totalSize: 1 };
      if (endpoint === '/wallet/asset/info') {
        const owner = customers.find(id => `${id}-ASSET` === options.query?.id);
        expect(owner).toBeTruthy();
        return { id: options.query?.id, agentCustomerNo: owner, symbol: 'USDT', balance: '12345.67', amlBalanceList: [{ chainTag: 'TRC20', availableAmount: '12345.67' }] };
      }
      if (endpoint === '/wallet/address/list' && customer) return { list: [{ agentCustomerNo: customer,
        address: 'PRIVATE-SHARED-ADDRESS', symbol: 'USDT', chainTag: 'TRC20' }], totalSize: 1 };
      if (endpoint === '/deposit/aml/page') return { list: [{ customerNo: customer, txHash: 'PRIVATE-HASH',
        orderNo: 'PRIVATE-ORDER', orderStatus: 2, riskLevel: 1, state: 1, receiveAmount: '12345.67' }], totalSize: 1 };
      if (endpoint === '/deposit/aml/stats') return { totalAmount: '12345.67', appealPassedCount: 0 };
      return [];
    } } as unknown as Pick<UpayClient, 'readRequest'>;
    const result = await inspectUpayWalletReadiness(client);
    expect(result).toMatchObject({ mutationsPerformed: false, readyForCustomerDeposits: false,
      blockers: expect.arrayContaining(['address_read_binding_unverified']),
      existingCardWallets: { selectedCustomerCount: 2, customerSampleLimit: 2,
        observationScope: 'customers_with_existing_cards_only', automaticCreationTimingVerified: false,
        beforeCardWalletAvailabilityVerified: false, sharedAddressAcrossSelectedCustomers: true,
        customers: [expect.objectContaining({ existingCardCount: 2, matchingAssetRowCount: 1, allAssetRowsMatchCardCustomer: true,
          matchingAddressRowsWithCurrencyAndNetwork: 1, allAddressRowsMatchCardCustomer: true,
          amlRowsMatchingCardCustomer: 1, allAmlRowsMatchCardCustomer: true,
          walletInfo: expect.objectContaining({ requestedRowCustomerBindingVerified: true, detailIdMatchesListRow: true, detailCustomerMatchesCardCustomer: true }),
        }), expect.objectContaining({ existingCardCount: 1, matchingAssetRowCount: 1 })],
      },
    });
    expect(calls.filter(call => call.endpoint === '/wallet/asset/info').map(call => call.options.query?.id)).toEqual([
      `${customers[0]}-ASSET`, `${customers[1]}-ASSET`,
    ]);
    expect(calls.some(call => JSON.stringify(call.options).includes(customers[2]!))).toBe(false);
    const postCalls = calls.filter(call => call.method === 'POST');
    expect(postCalls).toHaveLength(4);
    expect(postCalls.every(call => ['/deposit/aml/page', '/deposit/aml/stats'].includes(call.endpoint))).toBe(true);
    expect(postCalls.every(call => Object.keys(call.options.body ?? {}).every(key => ['pageNo', 'pageSize', 'customerNo'].includes(key)))).toBe(true);
    expect(calls.every(call => call.method === 'GET' || ['/deposit/aml/page', '/deposit/aml/stats'].includes(call.endpoint))).toBe(true);
    expect(calls.some(call => ['/customer/add', '/card/applyOpenCard', '/card/recharge', '/asset/address', '/asset/withdraw', '/card/submit/kyc'].includes(call.endpoint))).toBe(false);
    const output = JSON.stringify(result);
    expect(output).not.toContain('PRIVATE-');
    expect(output).not.toContain('12345.67');
  });

  it('never follows wallet IDs after denied lists or inconsistent customer bindings', async () => {
    const calls: { endpoint: string; options: { query?: Record<string, string | number>; body?: Record<string, unknown> } }[] = [];
    const client = { readRequest: async (_method: string, endpoint: string, options: typeof calls[number]['options'] = {}) => {
      calls.push({ endpoint, options });
      if (endpoint === '/card/list') return { list: [
        { customerNo: 'PRIVATE-CUSTOMER-A', agentCustomerCardId: 'PRIVATE-CARD-A' },
        { customerNo: 'PRIVATE-CUSTOMER-B', agentCustomerCardId: 'PRIVATE-CARD-B' },
      ] };
      if (endpoint === '/wallet/asset/list') {
        if (options.query?.agentCustomerNo === 'PRIVATE-CUSTOMER-A') throw new UpayError('PRIVATE-SERVER-ERROR', false, 10003);
        return { list: [{ id: 'PRIVATE-FOREIGN-ID', agentCustomerNo: 'PRIVATE-CUSTOMER-B', customerNo: 'PRIVATE-FOREIGN-OWNER', symbol: 'USDT' }] };
      }
      if (endpoint === '/wallet/address/list' && options.query?.agentCustomerNo) return { list: [{ address: 'PRIVATE-ADDRESS',
        agentCustomerNo: 'PRIVATE-FOREIGN-OWNER', symbol: 'USDT', chainTag: 'TON' }] };
      return [];
    } } as unknown as Pick<UpayClient, 'readRequest'>;
    const result = await inspectUpayWalletReadiness(client);
    expect(calls.some(call => call.endpoint === '/wallet/asset/info')).toBe(false);
    expect(result).toMatchObject({ readyForCustomerDeposits: false, existingCardWallets: { customers: [
      expect.objectContaining({ walletAssets: { ok: false, code: 10003 }, walletInfo: expect.objectContaining({ skipped: true }), matchingAddressRowCount: 0 }),
      expect.objectContaining({ matchingAssetRowCount: 0, allAssetRowsMatchCardCustomer: false,
        walletInfo: expect.objectContaining({ skipped: true }), matchingAddressRowCount: 0 }),
    ] } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-');
  });
});
