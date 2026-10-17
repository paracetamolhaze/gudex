import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cardOperations, kycProfiles, upaySubmissions, users } from '../db/schema';
import { AppError } from '../lib/errors';
import type { UpayClient } from '../partner/upay/client';
import { UpayError } from '../partner/upay/transport';
import { exactCents, formatCents, identifier, issuancePayload } from '../partner/upay/financial-protocol';

type Row = Record<string, unknown>;
type Reader = Pick<UpayClient, 'readRequest'> & Partial<Pick<UpayClient, 'loginInfo'>>;
const row = (value: unknown): Row | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const statusCode = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 999 ? value : null;
const shape = (value: unknown) => value === null || value === undefined ? 'null' : Array.isArray(value) ? 'array' : row(value) ? 'object' : 'other';
const unavailable = () => new AppError('provider_unavailable', 'Owner-scoped issuance observation is unavailable');
const failure = (error: unknown): 'deadline_exceeded' | 'read_failed' => error === DEADLINE ? 'deadline_exceeded' : 'read_failed';
const DEADLINE = Symbol('read deadline');

async function readBefore(client: Reader, method: 'GET' | 'POST', endpoint: string, options: { query?: Record<string, string | number>; body?: object }, deadline: number): Promise<unknown> {
  return beforeDeadline(() => client.readRequest(method, endpoint, options), deadline);
}

async function beforeDeadline<T>(read: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw DEADLINE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(DEADLINE), remaining);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

type AuditScope = { memberId?: string; names?: Set<string>; identity?: { memberCatalogComplete: boolean; ownMemberUnique: boolean; nameIdentityAvailable: boolean } };
type LogItem = { fieldTypes: Record<string, string>; fieldShapes: Record<string, string>; fieldShapesTruncated: boolean; statusCode: 1 | 2 | null;
  operatorMatchesLogin: boolean; operatorNameMatchesLogin: boolean; operatorIdentityBasis: 'member_id' | 'unique_member_name' | 'unconfirmed';
  timestampFormat: 'wall_clock' | 'epoch_ms' | 'iso_with_timezone' | 'other'; timestampSource: 'createTime' | 'createTimeStr'; displayedTime: string | null; timestampTimezoneVerified: false;
  createdAtUtc: string | null; epochWithinOperationWindow: boolean | null; resCode: number | null; resCodeMeaningVerified: false;
  resDescribeState: 'missing' | 'null' | 'empty' | 'text' | 'other' | 'unconfirmed'; resDescribeLength: number | null; resDescribeLengthTruncated: boolean;
  typeCode: number | null; subTypeCode: number | null;
  ownCustomerMentioned: boolean; endpointMentioned: boolean };
const AUDIT_FIELD_KEYS = ['accountId', 'memberId', 'memberName', 'typeName', 'subTypeName', 'createTime', 'status',
  'request', 'requestParams', 'params', 'response', 'result', 'error', 'message', 'msg', 'code', 'errorCode', 'httpStatus', 'statusCode', 'path', 'url', 'uri', 'operatedTime'] as const;
const memberNames = (member: Row): string[] => ['name', 'memberName', 'email'].map(key => member[key]).filter((value): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 320 && value.trim() === value && !/[*＊•●]/.test(value) && !/^(?:null|undefined|x{2,})$/i.test(value));
async function auditIdentity(client: Reader, login: Row, memberId: string, deadline: number, scope: AuditScope) {
  scope.identity = { memberCatalogComplete: false, ownMemberUnique: false, nameIdentityAvailable: false };
  scope.names = new Set();
  try {
    const response = await readBefore(client, 'POST', '/sys/member/list', { body: { pageNo: 1, pageSize: 1000 } }, deadline);
    const page = row(response), raw = Array.isArray(response) ? response : page?.list;
    if (!Array.isArray(raw) || raw.length > 1000 || raw.some(value => !row(value) || !identifier(row(value)!.id))) return;
    const members = raw as Row[];
    const totalValid = !page || (page.totalSize === undefined || Number.isSafeInteger(page.totalSize) && Number(page.totalSize) === members.length);
    const pagesValid = !page || page.totalPages === undefined || Number.isSafeInteger(page.totalPages) &&
      (page.totalPages === 1 || page.totalPages === 0 && members.length === 0);
    const complete = totalValid && pagesValid && (page?.totalPages !== undefined || page?.totalSize !== undefined || members.length < 1000);
    scope.identity.memberCatalogComplete = complete;
    if (!complete) return;
    const own = members.filter(member => identifier(member.id) === memberId);
    scope.identity.ownMemberUnique = own.length === 1;
    if (own.length !== 1) return;
    const aliases = [...memberNames(own[0]!), ...memberNames(login)];
    for (const name of aliases) if (!members.some(member => identifier(member.id) !== memberId && memberNames(member).includes(name))) scope.names.add(name);
    scope.identity.nameIdentityAvailable = scope.names.size > 0;
  } catch { /* Direct exact IDs remain usable; an unavailable catalog cannot establish a name identity. */ }
}
function auditTimestamp(value: unknown): { format: LogItem['timestampFormat']; wallClock: string | null } {
  if (typeof value === 'string' && /^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const at = Date.parse(`${value.replace(' ', 'T')}Z`);
    if (Number.isFinite(at) && new Date(at).toISOString().slice(0, 19).replace('T', ' ') === value) return { format: 'wall_clock', wallClock: value };
  }
  if ((typeof value === 'string' && /^\d{13}$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1e12 && value <= 9999999999999)) return { format: 'epoch_ms', wallClock: null };
  if (typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) return { format: 'iso_with_timezone', wallClock: null };
  return { format: 'other', wallClock: null };
}
function auditEpoch(value: unknown): number | null {
  const numeric = typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : value;
  return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= Date.UTC(2000, 0, 1) && numeric < Date.UTC(2100, 0, 1) ? numeric : null;
}
const boundedInteger = (value: unknown, maximum: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
function auditResultCode(value: unknown): number | null {
  return boundedInteger(typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value, 999999999);
}
type StructuralSchema = { shape: string; count?: number; fieldShapes?: Record<string, string>; truncated?: boolean; samples?: StructuralSchema[]; nested?: Record<string, StructuralSchema> };
const valueType = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : ['string', 'number', 'boolean', 'object'].includes(typeof value) ? typeof value : 'other';
function structuralSchema(value: unknown, depth = 0): StructuralSchema {
  if (Array.isArray(value)) return { shape: 'array', count: value.length, truncated: value.length > 3,
    samples: depth < 3 ? value.slice(0, 3).map(item => structuralSchema(item, depth + 1)) : [] };
  const object = row(value);
  if (!object) return { shape: valueType(value) };
  const keys = Object.keys(object).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)).sort();
  const nestedKeys = depth < 2 ? keys.filter(key => row(object[key]) || Array.isArray(object[key])).slice(0, 4) : [];
  return { shape: 'object', fieldShapes: Object.fromEntries(keys.slice(0, 64).map(key => [key, valueType(object[key])])), truncated: keys.length > 64,
    nested: Object.fromEntries(nestedKeys.map(key => [key, structuralSchema(object[key], depth + 1)])) };
}
async function auditObservation(client: Reader, customerNo: string, operation: { createdAt: Date; updatedAt: Date }, deadline: number,
  scope: AuditScope, historyPreview = false) {
  const items: LogItem[] = [];
  let observedRows = 0, pageCount = 0, identityUnconfirmed = false;
  const end = (available: boolean, complete: boolean, reason: string) => ({ available, complete: complete && !identityUnconfirmed,
    reason: reason === 'none' && identityUnconfirmed ? 'identity_unconfirmed' : reason,
    observedRows, pages: pageCount, truncated: observedRows > 50, identity: scope.identity ?? { memberCatalogComplete: false, ownMemberUnique: false, nameIdentityAvailable: false }, items });
  if (!scope.memberId) {
    if (historyPreview) return end(false, false, 'identity_unconfirmed');
    if (!client.loginInfo) return end(false, false, 'unavailable');
    let memberId: string | null, login: Row;
    try { login = row(await beforeDeadline(() => client.loginInfo!(), deadline)) ?? {}; memberId = identifier(login.id); }
    catch (error) { return end(true, false, failure(error)); }
    if (!memberId) return end(true, false, 'identity_unconfirmed');
    scope.memberId = memberId;
    await auditIdentity(client, login, memberId, deadline, scope);
  }
  const memberId = scope.memberId, maxPages = historyPreview ? 1 : 10;
  // The SPA clears its date filter to empty strings, not omitted parameters.
  // Use an explicit broad epoch range for this one-page positive control instead.
  const operatedTimeBegin = historyPreview ? 0 : operation.createdAt.getTime() - 60000;
  const operatedTimeEnd = historyPreview ? Date.now() : operation.updatedAt.getTime() + 60000;
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    let response: unknown;
    try {
      response = await readBefore(client, 'GET', '/agentOperateLog/getPage', { query: { pageNo, pageSize: 100, memberId, operatedTimeBegin, operatedTimeEnd } }, deadline);
    } catch (error) { return end(true, false, failure(error)); }
    pageCount++;
    const page = row(response);
    if (!page || !Array.isArray(page.list) || page.list.length > 100 ||
      (page.totalPages !== undefined && (!Number.isSafeInteger(page.totalPages) || Number(page.totalPages) < 0)) ||
      (page.totalSize !== undefined && (!Number.isSafeInteger(page.totalSize) || Number(page.totalSize) < 0))) return end(true, false, 'unsupported_shape');
    observedRows += page.list.length;
    for (const raw of page.list) {
      const item = row(raw);
      if (!item) return end(true, false, 'unsupported_shape');
      const ownerKeys = ['accountId', 'memberId'].filter(key => Object.hasOwn(item, key) && item[key] !== null && item[key] !== '');
      const idsConsistent = ownerKeys.every(key => identifier(item[key]) === memberId);
      const operatorNameMatchesLogin = typeof item.memberName === 'string' && scope.names?.has(item.memberName) === true;
      const operatorMatchesLogin = idsConsistent && (ownerKeys.length > 0 || operatorNameMatchesLogin);
      if (!operatorMatchesLogin) identityUnconfirmed = true;
      if (items.length >= 50) continue;
      const type = (key: string) => !Object.hasOwn(item, key) ? 'missing' : item[key] === null ? 'null' : Array.isArray(item[key]) ? 'array'
        : ['string', 'number', 'boolean', 'object'].includes(typeof item[key]) ? typeof item[key] : 'other';
      const text = Object.values(item).filter((value): value is string => typeof value === 'string');
      const schemaKeys = Object.keys(item).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)).sort();
      const formattedTimestamp = auditTimestamp(item.createTimeStr);
      const timestamp = formattedTimestamp.wallClock ? formattedTimestamp : auditTimestamp(item.createTime);
      const epoch = operatorMatchesLogin ? auditEpoch(item.createTime) : null;
      items.push({ fieldTypes: Object.fromEntries(AUDIT_FIELD_KEYS.map(key => [key, type(key)])),
        fieldShapes: Object.fromEntries(schemaKeys.slice(0, 128).map(key => [key, type(key)])), fieldShapesTruncated: schemaKeys.length > 128,
        statusCode: item.status === 1 || item.status === 2 ? item.status : null, operatorMatchesLogin, operatorNameMatchesLogin,
        operatorIdentityBasis: operatorMatchesLogin ? ownerKeys.length > 0 ? 'member_id' : 'unique_member_name' : 'unconfirmed',
        timestampFormat: timestamp.format, timestampSource: formattedTimestamp.wallClock ? 'createTimeStr' : 'createTime',
        displayedTime: operatorMatchesLogin ? timestamp.wallClock : null, timestampTimezoneVerified: false,
        createdAtUtc: epoch === null ? null : new Date(epoch).toISOString(),
        epochWithinOperationWindow: epoch === null ? null : epoch >= operation.createdAt.getTime() - 60000 && epoch <= operation.updatedAt.getTime() + 60000,
        resCode: operatorMatchesLogin ? auditResultCode(item.resCode) : null, resCodeMeaningVerified: false,
        resDescribeState: !operatorMatchesLogin ? 'unconfirmed' : !Object.hasOwn(item, 'resDescribe') ? 'missing' : item.resDescribe === null ? 'null'
          : item.resDescribe === '' ? 'empty' : typeof item.resDescribe === 'string' ? 'text' : 'other',
        resDescribeLength: operatorMatchesLogin && typeof item.resDescribe === 'string' ? Math.min(item.resDescribe.length, 4096) : null,
        resDescribeLengthTruncated: operatorMatchesLogin && typeof item.resDescribe === 'string' && item.resDescribe.length > 4096,
        typeCode: operatorMatchesLogin ? boundedInteger(item.type, 999999) : null, subTypeCode: operatorMatchesLogin ? boundedInteger(item.subType, 999999) : null,
        ownCustomerMentioned: text.some(value => value.includes(customerNo)), endpointMentioned: text.some(value => value.includes('/card/applyOpenCard')) });
    }
    if (typeof page.totalPages === 'number') {
      if (pageNo >= page.totalPages) return end(true, true, 'none');
      if (page.totalPages > maxPages) return end(true, false, 'pagination_limit');
    } else if (typeof page.totalSize === 'number' && observedRows >= page.totalSize) {
      return end(true, true, 'none');
    } else if (page.list.length < 100) {
      if (typeof page.totalSize === 'number' && page.totalSize > observedRows) return end(true, false, 'pagination_incomplete');
      return end(true, true, 'none');
    }
  }
  return end(true, false, 'pagination_limit');
}

async function pages(client: Reader, endpoint: '/card/list' | '/card/getPageToCardOperateRecord', customerNo: string, deadline: number) {
  const rows: Row[] = [];
  let observedRows = 0, pageCount = 0;
  const end = (complete: boolean, reason: string) => ({ complete, reason, observedRows, pageCount, rows });
  for (let pageNo = 1; pageNo <= 100; pageNo++) {
    let response: unknown;
    try {
      response = await readBefore(client, endpoint === '/card/list' ? 'GET' : 'POST', endpoint, endpoint === '/card/list'
        ? { query: { customerNo, pageNo, pageSize: 100 } } : { body: { customerNo, operateType: 5, pageNo, pageSize: 100 } }, deadline);
    } catch (error) { return end(false, failure(error)); }
    pageCount++;
    const page = row(response);
    if (!page || !Array.isArray(page.list) || page.list.length > 100 ||
      (page.totalPages !== undefined && (!Number.isSafeInteger(page.totalPages) || Number(page.totalPages) < 0)) ||
      (page.totalSize !== undefined && (!Number.isSafeInteger(page.totalSize) || Number(page.totalSize) < 0))) return end(false, 'unsupported_shape');
    observedRows += page.list.length;
    const items = page.list.map(row);
    if (items.some(item => !item)) return end(false, 'unsupported_shape');
    // A filtered request alone is insufficient proof of a row's ownership.
    if (items.some(item => identifier(item!.customerNo) !== customerNo)) {
      rows.length = 0;
      return end(false, 'ownership_unconfirmed');
    }
    rows.push(...items as Row[]);
    if (typeof page.totalPages === 'number') {
      if (pageNo >= page.totalPages) return end(true, 'none');
      if (page.totalPages > 100) return end(false, 'pagination_limit');
    } else if (page.list.length < 100) {
      if (typeof page.totalSize === 'number' && page.totalSize > observedRows) return end(false, 'pagination_incomplete');
      return end(true, 'none');
    }
  }
  return end(false, 'pagination_limit');
}

function timeAtOrAfter(value: unknown, operationAt: Date): boolean | null {
  const milliseconds = typeof value === 'number' && Number.isSafeInteger(value) && value >= 1e12 ? value
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) ? milliseconds >= operationAt.getTime() : null;
}

function amountMatch(actual: unknown, expected: unknown): boolean | null {
  try { return exactCents(actual, 'amount') === exactCents(expected, 'quote'); } catch { return null; }
}
function budgetMatch(actual: unknown, budget: unknown): boolean | null {
  try { return exactCents(actual, 'amount') <= exactCents(budget, 'budget'); } catch { return null; }
}

// These independent observations never bind an operation or infer a debit from time/amount.
async function readPages(client: Reader, endpoint: string, query: Record<string, string | number>, deadline: number, maxPages = 20) {
  const rows: Row[] = [];
  let pageCount = 0;
  const end = (complete: boolean, reason: string) => ({ rows, pageCount, complete, reason });
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    let value: unknown;
    try { value = await readBefore(client, 'GET', endpoint, { query: { ...query, pageNo, pageSize: 100 } }, deadline); }
    catch (error) { return end(false, failure(error)); }
    pageCount++;
    const page = row(value);
    if (!page || !Array.isArray(page.list) || page.list.length > 100 || page.list.some(item => !row(item)) ||
      (page.totalPages !== undefined && (!Number.isSafeInteger(page.totalPages) || Number(page.totalPages) < 0)) ||
      (page.totalSize !== undefined && (!Number.isSafeInteger(page.totalSize) || Number(page.totalSize) < 0))) return end(false, 'unsupported_shape');
    rows.push(...page.list as Row[]);
    if (typeof page.totalPages === 'number') {
      if (pageNo >= page.totalPages) return end(page.totalSize === undefined || rows.length >= Number(page.totalSize),
        page.totalSize !== undefined && rows.length < Number(page.totalSize) ? 'pagination_incomplete' : 'none');
      if (page.totalPages > maxPages) return end(false, 'pagination_limit');
    } else if (page.list.length < 100 || (typeof page.totalSize === 'number' && rows.length >= page.totalSize)) {
      return end(page.totalSize === undefined || rows.length >= Number(page.totalSize),
        page.totalSize !== undefined && rows.length < Number(page.totalSize) ? 'pagination_incomplete' : 'none');
    }
  }
  return end(false, 'pagination_limit');
}

const customerNumber = (value: Row) => identifier(value.no ?? value.customerNo);
const safeMoney = (value: unknown): string | null => {
  try { const cents = exactCents(value, 'diagnostic amount'); return cents <= 100_000_000_000n ? formatCents(cents) : null; } catch { return null; }
};
async function customerGroupObservation(client: Reader, customerNo: string, productId: string, documentType: string | null,
  evidence: Row, deadline: number, configuredGroupId?: string) {
  const customers = await readPages(client, '/customer/list', {}, deadline);
  const candidates = customers.rows.filter(item => customerNumber(item) === customerNo);
  if (!customers.complete || candidates.length !== 1 || !identifier(candidates[0]?.customerId)) return {
    complete: false, reason: !customers.complete ? customers.reason : 'customer_not_unique', customerMatches: false, detailIdentifierMatches: false };
  const customerId = identifier(candidates[0]!.customerId)!;
  let detail: Row | null;
  try { detail = row(await readBefore(client, 'GET', '/customer/get', { query: { customerId } }, deadline)); }
  catch (error) { return { complete: false, reason: failure(error), customerMatches: false, detailIdentifierMatches: false }; }
  const customerMatches = !!detail && customerNumber(detail) === customerNo;
  const detailIdentifierMatches = !!detail && identifier(detail.customerId) === customerId;
  if (!detail || !customerMatches || !detailIdentifierMatches) return { complete: false, reason: 'ownership_unconfirmed', customerMatches, detailIdentifierMatches };
  const [groups, rates, catalog, product, fee] = await Promise.all([
    readPages(client, '/customer/group/list', {}, deadline), readPages(client, '/card/rate/list', {}, deadline),
    readBefore(client, 'GET', '/card/rate/list/all', {}, deadline).then(value => ({ ok: Array.isArray(value) && value.length <= 2000 && value.every(item => row(item)), value })).catch(() => ({ ok: false, value: null })),
    readBefore(client, 'GET', '/card/getMayApplyCardDetail', { query: { agentCardId: productId } }, deadline).then(row).catch(() => null),
    readBefore(client, 'GET', '/card/getCardFee', { query: { customerNo, agentCardId: productId } }, deadline).then(row).catch(() => null),
  ]);
  const currentId = identifier(detail.groupId);
  const current = groups.complete && currentId ? groups.rows.filter(group => identifier(group.id) === currentId) : [];
  const target = groups.complete ? groups.rows.filter(group => typeof group.name === 'string' && /^gudex bot$/i.test(group.name)) : [];
  const currentGroup = current.length === 1 ? current[0] : undefined, targetGroup = target.length === 1 ? target[0] : undefined;
  const currentRate = identifier(currentGroup?.rateBatchNo), targetRate = identifier(targetGroup?.rateBatchNo);
  const [choicesProbe, targetTariff] = await Promise.all([
    readBefore(client, 'GET', '/card/choose', {}, deadline)
      .then(value => ({ value, outcome: { ok: true, httpStatus: null as number | null, upstreamCode: null as number | null } }))
      .catch((error: unknown) => ({ value: null, outcome: { ok: false,
        httpStatus: error instanceof UpayError ? error.metadata?.httpStatus ?? null : null,
        upstreamCode: error instanceof UpayError ? error.code ?? null : null } })),
    targetRate ? readBefore(client, 'GET', '/card/rate/info', { query: { batchNo: targetRate } }, deadline).then(row).catch(() => null) : null,
  ]);
  const choices = choicesProbe.value;
  const choiceRows = Array.isArray(choices) && choices.length <= 2000 && choices.every(item => row(item)) ? choices as Row[] : [];
  const selectedChoices = choiceRows.filter(choice => identifier(choice.agentCardId) === productId);
  const targetItems = targetTariff && Array.isArray(targetTariff.items) && targetTariff.items.length <= 2000 && targetTariff.items.every(item => row(item)) ? targetTariff.items as Row[] : [];
  const selectedTariffs = targetItems.filter(item => identifier(item.agentCardId) === productId);
  const targetRateMatches = !!targetRate && identifier(targetTariff?.batchNo) === targetRate;
  const currencyMatchesUsdt = selectedChoices.length === 1 && selectedChoices[0]!.coinSymbol === 'USDT';
  const brokerCostUsdt = currencyMatchesUsdt ? safeMoney(selectedChoices[0]!.costFee) : null;
  const customerOpenFeeUsdt = currencyMatchesUsdt && targetRateMatches && selectedTariffs.length === 1 ? safeMoney(selectedTariffs[0]!.openFee) : null;
  const operationProductMatches = evidence.agentCardId === productId;
  const selectedProductTariff = { complete: brokerCostUsdt !== null && customerOpenFeeUsdt !== null && operationProductMatches,
    brokerProductUnique: selectedChoices.length === 1, tariffProductUnique: selectedTariffs.length === 1, targetRateMatches, currencyMatchesUsdt, operationProductMatches,
    brokerCostUsdt, customerOpenFeeUsdt, choicesSchema: structuralSchema(choices), choicesRead: choicesProbe.outcome,
    withinOpBrokerBudget: brokerCostUsdt !== null && operationProductMatches ? budgetMatch(brokerCostUsdt, evidence.maxFeeBudgetUsdt) : null,
    costCustomerAreDifferent: brokerCostUsdt !== null && customerOpenFeeUsdt !== null ? amountMatch(brokerCostUsdt, customerOpenFeeUsdt) === false : null };
  const rateMatches = (batchNo: string | null) => batchNo && rates.complete ? rates.rows.filter(rate => identifier(rate.batchNo) === batchNo) : [];
  const catalogRows = catalog.ok ? catalog.value as Row[] : [];
  const hasCatalogRate = (batchNo: string | null) => !!batchNo && catalog.ok && catalogRows.some(rate => identifier(rate.batchNo) === batchNo);
  let feeFormReady = false, paymentUsdt: string | null = null;
  const feeFormCustomerMatches = !!fee && identifier(fee.customerNo) === customerNo;
  const productMatches = !!product && (product.agentCardId === undefined || product.agentCardId === null || identifier(product.agentCardId) === productId) && evidence.agentCardId === productId;
  const currenciesMatch = !!product && product.rechargeCurrency === 'USDT' && (product.cardCurrency ?? product.currency) === 'USD';
  if (product && fee && feeFormCustomerMatches && productMatches && currenciesMatch) try {
    const filled = { ...fee, documentType: fee.defaultType ?? fee.documentType ?? (documentType === 'id_card' ? 1 : documentType === 'passport' ? 2 : undefined) };
    const quote = issuancePayload(product, filled, customerNo, productId, exactCents(evidence.maxFeeBudgetUsdt, 'budget'));
    paymentUsdt = formatCents(quote.feeCents); feeFormReady = true;
  } catch { /* A readable form does not prove group admission or a successful issuance. */ }
  const currentMatches = rateMatches(currentRate), targetMatches = rateMatches(targetRate);
  const listedSource = candidates[0]!.source, detailSource = detail.source;
  const source = detailSource === undefined ? listedSource : listedSource !== undefined && listedSource !== detailSource ? null : detailSource;
  return { complete: groups.complete && rates.complete && catalog.ok && current.length === 1 && target.length === 1,
    reason: !groups.complete ? groups.reason : !rates.complete ? rates.reason : !catalog.ok ? 'rate_catalog_unavailable' : current.length !== 1 || target.length !== 1 ? 'group_not_unique' : 'none',
    customerMatches, detailIdentifierMatches, registrationSource: source === 1 ? 'api' : source === 2 ? 'system' : source === 3 ? 'user' : 'unknown', selectedProductTariff,
    groups: { complete: groups.complete, observedRows: groups.rows.length, currentGroupUnique: current.length === 1,
      currentIsDefault: currentGroup?.isDefault === 1, currentHasRate: !!currentRate, gudexBotMatches: target.length,
      currentIsGudexBot: !!currentGroup && !!targetGroup && identifier(currentGroup.id) === identifier(targetGroup.id), gudexBotHasRate: !!targetRate,
      sameRateAsGudexBot: !!currentRate && !!targetRate && currentRate === targetRate,
      configuredGroupPresent: configuredGroupId !== undefined, configuredGroupMatchesCurrent: configuredGroupId ? identifier(configuredGroupId) === currentId : null,
      configuredGroupMatchesGudexBot: configuredGroupId && targetGroup ? identifier(configuredGroupId) === identifier(targetGroup.id) : null },
    rates: { complete: rates.complete, observedRows: rates.rows.length, currentRateMatches: currentMatches.length, gudexBotRateMatches: targetMatches.length,
      catalogComplete: catalog.ok, catalogHasCurrentRate: hasCatalogRate(currentRate), catalogHasGudexBotRate: hasCatalogRate(targetRate),
      currentRateGroupMatches: !!identifier(currentGroup?.no) && currentMatches.length === 1 && identifier(currentMatches[0]!.customerGroupNo) === identifier(currentGroup?.no),
      gudexBotRateGroupMatches: !!identifier(targetGroup?.no) && targetMatches.length === 1 && identifier(targetMatches[0]!.customerGroupNo) === identifier(targetGroup?.no) },
    product: { productMatches, feeFormCustomerMatches, feeFormReady, openFeeUsdt: currenciesMatch ? safeMoney(product?.openFee) : null,
      initialPaymentUsdt: currenciesMatch ? safeMoney(product?.defaultOpenAmount) : null, paymentUsdt,
      accountCoinBalanceUsdt: product?.accountCoinSymbol === 'USDT' ? safeMoney(product.accountCoinBalance) : null,
      withinOperationBudget: paymentUsdt === null ? null : budgetMatch(paymentUsdt, evidence.maxFeeBudgetUsdt),
      groupAllowed: null, customerTariffEqualsBrokerCostEstablished: false },
  };
}

function billTime(value: unknown): number | null {
  const numeric = typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : value;
  if (typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= 1e12 && numeric <= 8.64e15) return numeric;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const milliseconds = Date.parse(value); return Number.isFinite(milliseconds) ? milliseconds : null;
}
async function brokerBillObservation(client: Reader, customerNo: string, operation: { createdAt: Date; updatedAt: Date }, evidence: Row, deadline: number, historyPreview = false) {
  // Native merchant-bills uses date strings, orderType=1, issuance tab type=4.
  // A surrounding UTC date window avoids inventing a server timezone; row time remains only an observation.
  // The observed UI sends empty strings when its date range is cleared.
  const startTime = historyPreview ? '' : new Date(operation.createdAt.getTime() - 86400000).toISOString().slice(0, 10);
  const endTime = historyPreview ? '' : new Date(operation.updatedAt.getTime() + 86400000).toISOString().slice(0, 10);
  const bills = await readPages(client, '/bill/list', { orderType: 1, type: 4, startTime, endTime }, deadline, historyPreview ? 1 : 10);
  const knownOrder = identifier(evidence.orderNo), knownCard = identifier(evidence.agentCustomerCardId);
  const keys = ['customerNo', 'agentCustomerNo', 'orderNo', 'agentCustomerCardId', 'brokerCardId', 'selfId', 'selfType', 'dataClass', 'createTimeTimestamp', 'createTime', 'tradeTime'] as const;
  return { complete: bills.complete, reason: bills.reason, observedRows: bills.rows.length, pages: bills.pageCount, truncated: bills.rows.length > 50,
    evidenceOnly: true, exactOperationBindingEstablished: false, dateWindowTimezoneVerified: false,
    allRowsMatchRequestedType: bills.rows.every(item => item.type === 4),
    items: bills.rows.slice(0, 50).map(item => {
      const currencyMatchesUsdt = item.symbol === 'USDT', amountUsdt = currencyMatchesUsdt ? safeMoney(item.amount) : null;
      const at = billTime(item.createTimeTimestamp ?? item.createTime ?? item.tradeTime);
      const rowCustomer = identifier(item.customerNo ?? item.agentCustomerNo);
      const customerFieldsConsistent = item.customerNo === undefined || item.agentCustomerNo === undefined || identifier(item.customerNo) === identifier(item.agentCustomerNo);
      return { amountUsdt, currencyMatchesUsdt, type: item.type === 4 ? 'card_issue' : 'other',
        state: item.state === 1 ? 'succeeded' : item.state === 2 ? 'pending' : item.state === 3 ? 'failed' : item.state === 4 ? 'cancelled' : 'other',
        direction: item.inOut === 1 ? 'credit' : item.inOut === 2 ? 'debit' : 'unknown',
        customerMatches: !!rowCustomer && customerFieldsConsistent && rowCustomer === customerNo,
        orderMatchesKnownReceipt: !!knownOrder && identifier(item.orderNo) === knownOrder,
        cardMatchesKnownCard: !!knownCard && identifier(item.agentCustomerCardId) === knownCard,
        hasOrderId: identifier(item.orderNo) !== null, hasCardId: identifier(item.agentCustomerCardId ?? item.brokerCardId) !== null,
        amountMatchesOperationBudget: amountUsdt === null ? null : amountMatch(amountUsdt, evidence.maxFeeBudgetUsdt),
        timeClass: at === null ? 'unconfirmed' : at < operation.createdAt.getTime() - 60000 ? 'before_operation'
          : at > operation.updatedAt.getTime() + 60000 ? 'after_operation' : 'operation_window',
        inRequestedDateWindow: at === null || historyPreview ? null : new Date(at).toISOString().slice(0, 10) >= startTime && new Date(at).toISOString().slice(0, 10) <= endTime,
        fieldTypes: Object.fromEntries(keys.map(key => [key, !Object.hasOwn(item, key) ? 'missing' : item[key] === null ? 'null' : Array.isArray(item[key]) ? 'array'
          : ['string', 'number', 'boolean', 'object'].includes(typeof item[key]) ? typeof item[key] : 'other'])),
      };
    }),
  };
}

// Provider observation only. POST below is the panel's paginated record READ;
// no receipt binding, reconciliation, card decrypt, enqueue or business mutation occurs.
export async function inspectCardOperationProviderStatus(db: Db, client: Reader, operationId: string, productId: string, configuredGroupId?: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new AppError('validation', 'Invalid operation ID');
  const local = await db.transaction(async tx => {
    const [owned] = await tx.select({ operation: cardOperations }).from(cardOperations).innerJoin(users, eq(users.id, cardOperations.userId))
      .where(and(eq(cardOperations.id, operationId), eq(users.telegramId, 514468501n)));
    if (!owned) throw new AppError('not_found', 'Card operation not found');
    const [profile] = await tx.select({ provider: kycProfiles.partnerProvider, customerNo: kycProfiles.partnerCustomerId, documentType: kycProfiles.documentType }).from(kycProfiles).where(eq(kycProfiles.userId, owned.operation.userId));
    const [journal] = await tx.select({ kind: upaySubmissions.kind, evidence: upaySubmissions.evidence }).from(upaySubmissions).where(eq(upaySubmissions.reference, owned.operation.id));
    const evidence = row(journal?.evidence);
    if (owned.operation.type !== 'issue' || owned.operation.partnerProvider !== 'upay' || profile?.provider !== 'upay' || journal?.kind !== 'issue' ||
      !profile.customerNo || identifier(profile.customerNo) !== profile.customerNo || evidence?.customerNo !== profile.customerNo || !identifier(productId)) throw unavailable();
    return { operation: owned.operation, customerNo: profile.customerNo, documentType: profile.documentType, evidence };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  const deadline = Date.now() + 40000;
  const auditScope: AuditScope = {};
  const [records, cards, catalog, audit, customerGroup, brokerBills] = await Promise.all([
    pages(client, '/card/getPageToCardOperateRecord', local.customerNo, deadline), pages(client, '/card/list', local.customerNo, deadline),
    readBefore(client, 'GET', '/card/getCardOperateStatus', { query: { operateType: 5 } }, deadline)
      .then(value => ({ ok: true, value })).catch(() => ({ ok: false, value: null })),
    auditObservation(client, local.customerNo, local.operation, deadline, auditScope),
    customerGroupObservation(client, local.customerNo, productId, local.documentType, local.evidence, deadline, configuredGroupId),
    brokerBillObservation(client, local.customerNo, local.operation, local.evidence, deadline),
  ]);
  const [auditHistoryPreview, brokerBillsHistoryPreview] = await Promise.all([
    audit.complete && audit.observedRows === 0 ? auditObservation(client, local.customerNo, local.operation, deadline, auditScope, true) : null,
    brokerBills.complete && brokerBills.observedRows === 0 ? brokerBillObservation(client, local.customerNo, local.operation, local.evidence, deadline, true) : null,
  ]);
  const narrowCompleteAndEmpty = audit.complete && audit.observedRows === 0;
  const historyOwnRowsInOperationWindow = auditHistoryPreview?.items.filter(item => item.operatorMatchesLogin && item.epochWithinOperationWindow === true).length ?? 0;
  const auditFilterConsistency = { narrowCompleteAndEmpty, historyOwnRowsInOperationWindow,
    filterReliability: narrowCompleteAndEmpty && historyOwnRowsInOperationWindow > 0 ? 'contradicted' : 'unverified' };
  const catalogRows = Array.isArray(catalog.value) ? catalog.value : [];
  const codes = [...new Set(catalogRows.map(item => typeof item === 'number' ? statusCode(item) : statusCode(row(item)?.code ?? row(item)?.value))
    .filter((code): code is number => code !== null))].sort((a, b) => a - b);
  const recordItems = records.rows.slice(0, 50).map(record => {
    const cardId = identifier(record.brokerCardId ?? record.cardId);
    const consistent = record.brokerCardId === undefined || record.cardId === undefined || identifier(record.brokerCardId) === identifier(record.cardId);
    const matches = cardId && consistent ? cards.rows.filter(card => identifier(card.brokerCardId) === cardId) : [];
    return { record, matches, safe: { statusCode: statusCode(record.status), hasRecordId: identifier(record.id) !== null,
      hasOrderId: identifier(record.orderNo) !== null, hasCardId: cardId !== null, customerMatches: identifier(record.customerNo) === local.customerNo,
      productMatches: record.agentCardId === undefined ? null : identifier(record.agentCardId) === productId && local.evidence.agentCardId === productId,
      currencyMatchesUsdt: record.currency === undefined ? null : record.currency === 'USDT',
      openFeeMatchesQuote: amountMatch(record.openCardAmount, local.evidence.openFeeUsdt), initialRechargeMatchesQuote: amountMatch(record.rechargeAmount, local.evidence.defaultOpenUsdt),
      paymentWithinBudget: budgetMatch(record.paymentAmount, local.evidence.maxFeeBudgetUsdt),
      issuerTimeAtOrAfterOperation: timeAtOrAfter(record.createTime, local.operation.createdAt),
      cardIdentifiersConsistent: consistent, exactCardListMatches: matches.length } };
  });
  const detailItems: { customerMatches: boolean; cardIdentifierMatches: boolean; brokerMatchesRecord: boolean; productMatches: boolean | null; statusCode: number | null }[] = [];
  const seen = new Set<string>();
  let detailReadFailed = false, detailsTruncated = !records.complete || !cards.complete || records.rows.length > 50;
  if (records.complete && cards.complete) for (const candidate of recordItems) {
    if (candidate.matches.length !== 1) continue;
    const card = candidate.matches[0]!, cardId = identifier(card.agentCustomerCardId);
    if (!cardId || seen.has(cardId)) continue;
    if (seen.size >= 10 || Date.now() >= deadline) { detailsTruncated = true; break; }
    seen.add(cardId);
    try {
      const detail = row(await readBefore(client, 'GET', '/card/getAgentCustomerCardDetail', { query: { agentCustomerCardId: cardId } }, deadline));
      if (!detail) { detailReadFailed = true; continue; }
      detailItems.push({ customerMatches: identifier(detail.customerNo) === local.customerNo,
        cardIdentifierMatches: identifier(detail.agentCustomerCardId) === cardId,
        brokerMatchesRecord: identifier(detail.brokerCardId) === identifier(card.brokerCardId),
        productMatches: detail.agentCardId === undefined ? null : identifier(detail.agentCardId) === productId && local.evidence.agentCardId === productId,
        statusCode: statusCode(detail.cardStatus) });
    } catch { detailReadFailed = true; }
  }
  const [fresh] = await db.select({ customerNo: kycProfiles.partnerCustomerId, provider: kycProfiles.partnerProvider }).from(kycProfiles).where(eq(kycProfiles.userId, local.operation.userId));
  if (fresh?.customerNo !== local.customerNo || fresh.provider !== 'upay') throw unavailable();
  return { matchingUser: true, customerMatchesJournal: true, evidenceOnly: true, exactOperationBindingEstablished: false,
    records: { complete: records.complete, reason: records.reason, observedRows: records.observedRows, pages: records.pageCount,
      truncated: records.rows.length > 50, items: recordItems.map(item => item.safe) },
    cards: { complete: cards.complete, reason: cards.reason, observedRows: cards.observedRows, pages: cards.pageCount, truncated: cards.rows.length > 50,
      items: cards.rows.slice(0, 50).map(card => ({ statusCode: statusCode(card.state), customerMatches: identifier(card.customerNo) === local.customerNo,
        hasCardId: identifier(card.agentCustomerCardId) !== null, hasBrokerCardId: identifier(card.brokerCardId) !== null,
        productMatches: card.agentCardId === undefined ? null : identifier(card.agentCardId) === productId && local.evidence.agentCardId === productId })) },
    details: { truncated: detailsTruncated, readFailed: detailReadFailed, items: detailItems }, statusCatalog: { ok: catalog.ok, shape: shape(catalog.value), codes }, audit, auditHistoryPreview, auditFilterConsistency, customerGroup, brokerBills, brokerBillsHistoryPreview,
  };
}
