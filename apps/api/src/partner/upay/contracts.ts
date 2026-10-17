import type { Config } from '../../config';
import { UpayClient, type UpayPage } from './client';
import { UpayError } from './transport';

// Match the customer-group identifier acceptance rules in the KYC integration.
const groupIdentifier = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;

// Operator-only protocol discovery. All calls are fixed reads; no customer fields, photo URIs,
// card numbers, payment PINs or actual receipt IDs leave this function.
export async function inspectUpayContracts(client: UpayClient, config: Config): Promise<Record<string, unknown>> {
  const shape = (value: unknown, depth = 0): unknown => {
    if (depth > 5) return 'nested';
    if (value === null) return 'null';
    if (Array.isArray(value)) return { type: 'array', sample: value.length ? shape(value[0], depth + 1) : null };
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value as object).slice(0, 150).map(([key, item]) => [key, shape(item, depth + 1)]));
    return typeof value;
  };
  const quoteFields = new Set(['openFee', 'defaultOpenAmount', 'rechargeFeeRate', 'rechargeRate', 'exchangeRate', 'cardCurrency',
    'rechargeCurrency', 'executeExchangeRate', 'symbol', 'currency', 'openFeeCurrency', 'accountCoinSymbol',
    'minPaymentAmount', 'minRechargeAmount', 'maxRechargeAmount', 'minAmount', 'maxAmount', 'feeRate', 'kycLevel']);
  const quotes = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => quoteFields.has(key) &&
      (typeof item === 'number' || typeof item === 'boolean' || (typeof item === 'string' && /^(?:\d+(?:\.\d+)?|USD|USDT|USDC)$/.test(item)))));
  };
  const probe = async (read: () => Promise<unknown>, includeQuotes = false): Promise<unknown> => {
    try {
      const data = await read();
      const fields = data && typeof data === 'object' ? (data as Record<string, unknown>).needParams : undefined;
      const needParams = Array.isArray(fields) && fields.every(field => typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,70}$/.test(field)) ? fields : undefined;
      return { ok: true, shape: shape(data), ...(includeQuotes ? { quote: quotes(data), ...(needParams ? { needParams } : {}) } : {}) };
    }
    catch (error) { return { ok: false, code: error instanceof UpayError ? error.code : undefined }; }
  };
  const customers = await client.customers(1, 1);
  const cards = await client.cards(1, 100);
  const customer = customers.list?.[0];
  const card = cards.list?.[0];
  const customerNo = customer?.no ?? customer?.customerNo;
  const cardId = card?.agentCustomerCardId;
  const links = async (operateType: number): Promise<unknown> => {
    const page = await client.readRequest<UpayPage<Record<string, unknown>>>('POST', '/card/getPageToCardOperateRecord', { body: { pageNo: 1, pageSize: 100, operateType } });
    const relations = new Set<string>();
    for (const row of page.list ?? []) for (const current of cards.list ?? []) {
      for (const left of ['cardId', 'accountCardId', 'ditchCardId']) for (const right of ['agentCustomerCardId', 'accountCardId', 'brokerCardId']) {
        if (row[left] && String(row[left]) === String(current[right])) relations.add(`${left}=${right}`);
      }
    }
    const succeeded = page.list?.find(row => Number(row.status) === 1);
    const costFields = new Set(operateType === 5 ? ['openCardAmount', 'paymentAmount', 'actualAmount', 'rechargeAmount', 'currency']
      : ['rechargeAmount', 'actualAmount', 'receivedAmount', 'rechargeFee', 'exchangeRate', 'rechargeFeeRate', 'receivedCurrency', 'rechargeCurrency']);
    const settledCosts = succeeded ? Object.fromEntries(Object.entries(succeeded).filter(([key, value]) => costFields.has(key) &&
      (typeof value === 'string' || typeof value === 'number') && /^(?:\d+(?:\.\d+)?|USD|USDT|USDC)$/.test(String(value)))) : undefined;
    return { shape: shape(page), verifiedIdRelations: [...relations], ...(settledCosts ? { settledCosts } : {}) };
  };
  const configuredGroup = config.UPAY_CUSTOMER_GROUP_ID;
  let groupReadiness = { ok: false, ready: false, configured: Boolean(configuredGroup), configuredGroupMatches: false,
    groupCount: 0, defaultGroupCount: 0, validDefaultGroupCount: 0 };
  const groupFields = await probe(async () => {
    const data = await client.readRequest<unknown>('GET', '/customer/group/all');
    const wrapped = data && typeof data === 'object' ? (data as Record<string, unknown>).list : undefined;
    const rows: unknown[] | null = Array.isArray(data) ? data : Array.isArray(wrapped) ? wrapped : null;
    if (rows) {
      const groups = rows.map(value => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
      const defaults = groups.filter(group => Number(group.isDefault) === 1);
      const validDefaults = defaults.filter(group => groupIdentifier(group.id) !== null);
      const configuredGroupMatches = Boolean(configuredGroup) && groups.some(group => groupIdentifier(group.id) === configuredGroup);
      groupReadiness = { ok: true,
        ready: configuredGroup ? configuredGroupMatches : defaults.length === 1 && validDefaults.length === 1,
        configured: Boolean(configuredGroup), configuredGroupMatches, groupCount: groups.length,
        defaultGroupCount: defaults.length, validDefaultGroupCount: validDefaults.length };
    }
    return data;
  });
  return {
    mutationsPerformed: false,
    customerFields: shape(customer ?? null), cardFields: shape(card ?? null),
    countryFields: await probe(() => client.readRequest('GET', '/common/countryAndRegion', { query: { level: 2 } })),
    groupFields, groupReadiness,
    verification: typeof customerNo === 'string' || typeof customerNo === 'number'
      ? await (async () => { try {
        const requirements = await client.readRequest<Record<string, unknown>>('GET', '/card/get/kyc', { query: { customerNo, agentCardId: config.UPAY_PRODUCT_ID } });
        const status = await client.readRequest('GET', '/card/get/kycStatus', { query: { customerNo, agentCardId: config.UPAY_PRODUCT_ID } });
        return { ok: true, requirementsShape: shape(requirements), statusShape: shape(status),
          documentType: Array.isArray(requirements.documentType) && requirements.documentType.every(value => [1, 2, 3, 4].includes(Number(value))) ? requirements.documentType : null,
          needKycLevel: typeof requirements.needKycLevel === 'number' && requirements.needKycLevel >= 0 && requirements.needKycLevel < 10 ? requirements.needKycLevel : null };
      } catch { return { ok: false }; } })() : { skipped: true },
    cardDetail: typeof cardId === 'string' || typeof cardId === 'number'
      ? await probe(() => client.readRequest('GET', '/card/getAgentCustomerCardDetail', { query: { agentCustomerCardId: cardId } })) : { skipped: true },
    product: await probe(() => client.readRequest('GET', '/card/getMayApplyCardDetail', { query: { agentCardId: config.UPAY_PRODUCT_ID } }), true),
    fee: typeof customerNo === 'string' || typeof customerNo === 'number'
      ? await probe(() => client.readRequest('GET', '/card/getCardFee', { query: { agentCardId: config.UPAY_PRODUCT_ID, customerNo } }), true) : { skipped: true },
    recharge: typeof cardId === 'string' || typeof cardId === 'number'
      ? await probe(() => client.readRequest('GET', '/card/getRechargeCardInfo', { query: { agentCustomerCardId: cardId } }), true) : { skipped: true },
    issuanceRecords: await links(5),
    rechargeRecords: await links(6),
  };
}
