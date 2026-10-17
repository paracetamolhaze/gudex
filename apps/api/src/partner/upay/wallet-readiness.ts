import type { UpayClient } from './client';
import { UpayError } from './transport';

type Row = Record<string, unknown>;
type ReadClient = Pick<UpayClient, 'readRequest'>;
type Probe = { ok: true; data: unknown } | { ok: false; code?: number };

const NETWORKS = new Set(['TON', 'TRC20', 'ERC20', 'BEP20', 'POLYGON']);
const CURRENCIES = new Set(['USDT', 'USDC']);
const row = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const rows = (value: unknown): Row[] => {
  const source = Array.isArray(value) ? value : row(value)?.list;
  return Array.isArray(source) ? source.map(row).filter((item): item is Row => item !== null) : [];
};
const identity = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value :
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const network = (value: unknown): string | null => typeof value === 'string' && NETWORKS.has(value.toUpperCase()) ? value.toUpperCase() : null;
const currency = (value: unknown): string | null => typeof value === 'string' && CURRENCIES.has(value.toUpperCase()) ? value.toUpperCase() : null;
const safeCode = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= -1000 && value <= 1000 ? value : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Values are never returned, including on errors. Only fixed public currency/network codes,
// numeric enum codes, structural field names, aggregate counts and equality proofs may leave this module.
function shape(value: unknown, depth = 0): unknown {
  if (depth > 5) return 'nested';
  if (value === null) return 'null';
  if (Array.isArray(value)) return { type: 'array', sample: value.length ? shape(value[0], depth + 1) : null };
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as object).slice(0, 120)
    .filter(([key]) => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key))
    .map(([key, item]) => [key, shape(item, depth + 1)]));
  return typeof value;
}

function summary(probe: Probe): Row {
  if (!probe.ok) return { ok: false, ...(probe.code !== undefined ? { code: probe.code } : {}) };
  return { ok: true, shape: shape(probe.data), sampleCount: rows(probe.data).length, total: count(row(probe.data)?.totalSize) };
}

function numericEnums(value: unknown, keys: string[]): Record<string, number[]> {
  return Object.fromEntries(keys.map(key => [key, [...new Set(rows(value).map(item => safeCode(item[key])).filter((code): code is number => code !== null))].sort((a, b) => a - b)]));
}

function customerKey(item: Row): string | null { return identity(item.customerNo) ?? identity(item.agentCustomerNo); }

function matchesCustomer(item: Row, customerNo: string): boolean {
  const identifiers = [identity(item.customerNo), identity(item.agentCustomerNo)].filter((id): id is string => id !== null);
  return identifiers.length > 0 && identifiers.every(id => id === customerNo);
}

export async function inspectUpayWalletReadiness(client: ReadClient): Promise<Row> {
  const read = async (method: 'GET' | 'POST', endpoint: string, options: { query?: Record<string, string | number>; body?: object } = {}): Promise<Probe> => {
    try { return { ok: true, data: await client.readRequest(method, endpoint, options) }; }
    catch (error) { return { ok: false, ...(error instanceof UpayError && error.code !== undefined ? { code: error.code } : {}) }; }
  };
  const probe = async (endpoint: string, query?: Record<string, string | number>): Promise<Probe> => {
    return read('GET', endpoint, query ? { query } : {});
  };
  const page = { pageNo: 1, pageSize: 100 };
  const [assetCoins, addresses, deposits, depositTypes, depositStates, depositRisks, coinChoices, customers, cards, merchantAssets] = await Promise.all([
    probe('/asset/coin/list'), probe('/wallet/address/list', page), probe('/wallet/deposit/list', page),
    probe('/wallet/deposit/depositType/list'), probe('/wallet/deposit/state/list'), probe('/wallet/deposit/riskCoinStatus/list'),
    probe('/coin/chain/coinSel'), probe('/customer/list', page), probe('/card/list', page), probe('/asset/list', page),
  ]);
  const stablecoins = assetCoins.ok ? rows(assetCoins.data).filter(item => currency(item.symbol) !== null) : [];
  const networks = stablecoins.map(item => ({
    asset: currency(item.symbol),
    chains: rows(item.chainListRes).map(chain => ({ network: network(chain.chainTag),
      depositsEnabled: chain.inStatus === 1, withdrawalsEnabled: chain.outStatus === 1,
      confirmationFieldsPresent: Object.keys(chain).some(key => /confirm/i.test(key)),
      tokenContractFieldPresent: Object.keys(chain).some(key => /contract|tokenAddress/i.test(key)),
    })).filter(chain => chain.network !== null),
  }));
  const chainChoices = await Promise.all((coinChoices.ok ? rows(coinChoices.data) : [])
    .filter(item => currency(item.symbol) !== null && identity(item.coinId) !== null).slice(0, 2)
    .map(async item => ({ asset: currency(item.symbol), result: await probe('/coin/chain/chainSel', { coinId: identity(item.coinId)! }) })));
  const customerNumbers = new Set((customers.ok ? rows(customers.data) : [])
    .map(item => identity(item.no) ?? customerKey(item)).filter((id): id is string => id !== null));
  const addressRows = addresses.ok ? rows(addresses.data) : [];
  const depositRows = deposits.ok ? rows(deposits.data) : [];
  const ownersByAddress = new Map<string, Set<string>>();
  for (const item of addressRows) {
    const owner = customerKey(item), address = identity(item.address), chain = network(item.chainTag);
    if (!owner || !address || !chain) continue;
    const key = `${chain}:${address}`;
    const owners = ownersByAddress.get(key) ?? new Set<string>();
    owners.add(owner); ownersByAddress.set(key, owners);
  }
  const addressOwners = new Set(addressRows.map(customerKey).filter((id): id is string => id !== null));
  const has = (items: Row[], pattern: RegExp) => items.some(item => Object.keys(item).some(key => pattern.test(key)));
  // The user reports automatic wallets on card issuance. Inspect only customers from existing cards;
  // neither a new card nor an address is created to test that hypothesis.
  const existingCards = (cards.ok ? rows(cards.data) : []).slice(0, 100)
    .filter(item => identity(item.agentCustomerCardId) !== null && identity(item.customerNo) !== null);
  const selectedCustomers = [...new Set(existingCards.map(item => identity(item.customerNo)!))].slice(0, 2);
  const selectedAddressOwners = new Map<string, Set<string>>();
  const customerWallets = await Promise.all(selectedCustomers.map(async customerNo => {
    const [walletAssets, walletAddresses, amlPage, amlStats] = await Promise.all([
      probe('/wallet/asset/list', { ...page, agentCustomerNo: customerNo }),
      probe('/wallet/address/list', { ...page, agentCustomerNo: customerNo }),
      read('POST', '/deposit/aml/page', { body: { ...page, customerNo } }),
      read('POST', '/deposit/aml/stats', { body: { customerNo } }),
    ]);
    const assets = walletAssets.ok ? rows(walletAssets.data) : [];
    const ownedAssets = assets.filter(item => matchesCustomer(item, customerNo));
    const addresses = walletAddresses.ok ? rows(walletAddresses.data) : [];
    const ownedAddresses = addresses.filter(item => matchesCustomer(item, customerNo));
    const completeAddresses = ownedAddresses.filter(item => identity(item.address) !== null && currency(item.symbol) !== null && network(item.chainTag) !== null);
    for (const item of completeAddresses) {
      const key = `${network(item.chainTag)}:${identity(item.address)}`;
      const owners = selectedAddressOwners.get(key) ?? new Set<string>();
      owners.add(customerNo); selectedAddressOwners.set(key, owners);
    }
    // Never probe guessed IDs or adopt another customer's wallet when an API ignores its filter.
    const wallet = ownedAssets.find(item => identity(item.id) !== null && currency(item.symbol) !== null);
    let walletInfo: Row = { skipped: true, reason: 'no_verified_customer_asset_row' };
    if (wallet) {
      const result = await probe('/wallet/asset/info', { id: identity(wallet.id)! });
      const detail = result.ok ? row(result.data) : null;
      walletInfo = { ...summary(result), requestedRowCustomerBindingVerified: true,
        detailIdMatchesListRow: detail && identity(detail.id) !== null ? identity(detail.id) === identity(wallet.id) : null,
        detailCustomerMatchesCardCustomer: detail && customerKey(detail) !== null ? matchesCustomer(detail, customerNo) : null };
    }
    const amlRows = amlPage.ok ? rows(amlPage.data) : [];
    return {
      existingCardCount: existingCards.filter(item => identity(item.customerNo) === customerNo).length,
      walletAssets: summary(walletAssets), walletInfo, addresses: summary(walletAddresses),
      amlPage: summary(amlPage), amlStats: summary(amlStats),
      matchingAssetRowCount: ownedAssets.length,
      allAssetRowsMatchCardCustomer: assets.length > 0 && assets.every(item => matchesCustomer(item, customerNo)),
      matchingAddressRowCount: ownedAddresses.length,
      matchingAddressRowsWithCurrencyAndNetwork: completeAddresses.length,
      allAddressRowsMatchCardCustomer: addresses.length > 0 && addresses.every(item => matchesCustomer(item, customerNo)),
      observedAddressCurrencies: [...new Set(completeAddresses.map(item => currency(item.symbol)))],
      observedAddressNetworks: [...new Set(completeAddresses.map(item => network(item.chainTag)))],
      amlRowsMatchingCardCustomer: amlRows.filter(item => matchesCustomer(item, customerNo)).length,
      allAmlRowsMatchCardCustomer: amlRows.length > 0 && amlRows.every(item => matchesCustomer(item, customerNo)),
      amlEnumCodes: amlPage.ok ? numericEnums(amlPage.data, ['orderStatus', 'riskLevel', 'materialStatus', 'state', 'receiptType']) : {},
      transactionHashFieldPresent: has(amlRows, /^(hash|txHash|transactionHash)$/i),
      confirmationFieldPresent: has(amlRows, /confirm/i),
    };
  }));
  return {
    mutationsPerformed: false,
    readyForCustomerDeposits: false,
    blockers: ['address_read_binding_unverified', 'confirmed_deposit_and_aml_semantics_unverified',
      'customer_wallet_to_merchant_spendable_funds_contract_unverified'],
    probes: { assetCoins: summary(assetCoins), addresses: summary(addresses), deposits: summary(deposits),
      depositTypes: summary(depositTypes), depositStates: summary(depositStates), depositRisks: summary(depositRisks),
      coinChoices: summary(coinChoices), chainChoices: chainChoices.map(item => ({ asset: item.asset, ...summary(item.result) })) },
    merchantAssetNetworks: networks,
    addressEvidence: {
      sampleCount: addressRows.length, total: addresses.ok ? count(row(addresses.data)?.totalSize) : null,
      allSampleRowsHaveCustomerBinding: addressRows.length > 0 && addressRows.every(item => customerKey(item) !== null),
      someOwnersMatchListedCustomers: [...addressOwners].some(owner => customerNumbers.has(owner)),
      sharedAddressAcrossSampleCustomers: [...ownersByAddress.values()].some(owners => owners.size > 1),
      memoFieldPresent: has(addressRows, /^(memo|tag|destinationTag|comment)$/i),
      observedNetworks: [...new Set(addressRows.map(item => network(item.chainTag)).filter(Boolean))],
    },
    depositEvidence: {
      sampleCount: depositRows.length, total: deposits.ok ? count(row(deposits.data)?.totalSize) : null,
      allSampleRowsHaveCustomerBinding: depositRows.length > 0 && depositRows.every(item => customerKey(item) !== null),
      someCustomersMatchAddressOwners: depositRows.some(item => { const id = customerKey(item); return id !== null && addressOwners.has(id); }),
      transactionHashFieldPresent: has(depositRows, /^(hash|txHash|transactionHash)$/i),
      confirmationFieldPresent: has(depositRows, /confirm/i),
      amlFieldPresent: has(depositRows, /aml|risk/i),
      enumCodes: deposits.ok ? numericEnums(deposits.data, ['state', 'riskCoinStatus', 'riskLevel', 'orderStatus', 'materialStatus']) : {},
    },
    statusOptionCodes: { types: depositTypes.ok ? numericEnums(depositTypes.data, ['code', 'value']) : {},
      states: depositStates.ok ? numericEnums(depositStates.data, ['code', 'value']) : {},
      risks: depositRisks.ok ? numericEnums(depositRisks.data, ['code', 'value']) : {} },
    existingCardWallets: {
      cards: summary(cards), merchantAssets: summary(merchantAssets), selectedCustomerCount: selectedCustomers.length,
      customerSampleLimit: 2, observationScope: 'customers_with_existing_cards_only', automaticCreationTimingVerified: false,
      beforeCardWalletAvailabilityVerified: false,
      sharedAddressAcrossSelectedCustomers: [...selectedAddressOwners.values()].some(owners => owners.size > 1),
      customers: customerWallets,
    },
  };
}
