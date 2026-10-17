import type { Config } from '../../config';
import { AppError } from '../../lib/errors';
import { type CardPartner, type PartnerCard, type PartnerCustomerInput, PartnerBillingAddressRequiredError, PartnerError, type PartnerKycStatus, PartnerPendingError, type PartnerTransaction } from '../types';
import type { UpayClient } from './client';
import { billingAddressRequired, decimal, decryptCardField, encryptPaymentPin, exactCents, expiry, formatCents, identifier, issuancePayload, minimumRechargeNet, object, rechargeQuote, requestHash, type UpayObject } from './financial-protocol';
import type { SubmissionEvidence, UpaySubmission, UpaySubmissionKind, UpaySubmissionStore } from './submissions';
import { UpayError } from './transport';

interface KycIntegration {
  assertReady(): void;
  createCustomer(input: PartnerCustomerInput): Promise<string>;
  getKycStatus(customerNo: string): Promise<PartnerKycStatus>;
  getKycRequirements(): Promise<{ selfieRequired: boolean; documentTypes: ('id_card' | 'passport')[] }>;
  reconcileKycSubmission(input: PartnerCustomerInput): Promise<{ customerNo?: string; submitted: boolean } | null>;
  getDocumentType?(customerNo: string): Promise<1 | 2>;
}
interface BillingIntegration {
  getVerifiedAddressId(customerNo: string, restrictionPolicy?: unknown): Promise<string | null>;
}
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const uncertain = () => new PartnerError('UPay result is unconfirmed; reconcile the exact receipt before any further submission', true);
const FINANCIAL_STEPS = { issue: 'card_issue', recharge: 'card_recharge', freeze: 'card_freeze', unfreeze: 'card_unfreeze' } as const;
// Only a durable proof that this financial POST was never dispatched authorizes a refund.
// Business rejection envelopes received after dispatch retain their uncertain outcome.
export class UpayNotDispatchedError extends PartnerError {
  constructor() { super('UPay submission was not sent', false); }
}
export function provenNotDispatched(row: { kind: unknown; state: unknown; partnerReceiptId: unknown; partnerCardId: unknown; evidence: unknown }): boolean {
  if (typeof row.kind !== 'string' || !Object.hasOwn(FINANCIAL_STEPS, row.kind) || !row.evidence || typeof row.evidence !== 'object' || Array.isArray(row.evidence)) return false;
  const evidence = row.evidence as Record<string, unknown>;
  return row.state === 'rejected' && row.partnerReceiptId === null && row.partnerCardId === null &&
    evidence.dispatchPhase === 'pre_dispatch' && evidence.step === FINANCIAL_STEPS[row.kind as keyof typeof FINANCIAL_STEPS] &&
    evidence.orderNo === undefined && evidence.receiptRecordId === undefined &&
    (row.kind !== 'issue' || ['agentCustomerCardId', 'accountCardId', 'brokerCardId'].every(key => evidence[key] === undefined)) &&
    typeof evidence.responseAck === 'string' && ['rejected_envelope', 'http_error', 'unconfirmed'].includes(evidence.responseAck);
}
function financialStep(kind: UpaySubmissionKind): string {
  if (!(kind in FINANCIAL_STEPS)) throw uncertain();
  return FINANCIAL_STEPS[kind as keyof typeof FINANCIAL_STEPS];
}
function failedSubmission(step: string, error: unknown, enteredClient: boolean): SubmissionEvidence {
  const metadata = error instanceof UpayError ? error.metadata : undefined;
  return { step, dispatchPhase: metadata?.phase ?? (enteredClient ? 'post_dispatched' : 'pre_dispatch'), responseAck: metadata?.ack ?? 'unconfirmed',
    ...(error instanceof UpayError && Number.isSafeInteger(error.code) ? { upstreamCode: error.code! } : {}),
    ...(metadata?.businessCategory === 'billing_phone_region_restricted' ? { businessCategory: metadata.businessCategory } : {}),
    ...(metadata?.httpStatus !== undefined ? { httpStatus: metadata.httpStatus } : {}) };
}

export class UpayFinancialPartner implements CardPartner {
  constructor(private readonly config: Config, private readonly client: UpayClient,
    private readonly journal: UpaySubmissionStore, private readonly kyc: KycIntegration,
    private readonly billing?: BillingIntegration) {}

  assertWriteReady(): void {
    if (!this.config.UPAY_WRITES_ENABLED || !this.client.configured || !/^\d{6}$/.test(this.config.UPAY_PAYMENT_PASSWORD ?? '')) {
      throw new AppError('provider_unavailable', 'UPay financial writes are not enabled or payment credentials are incomplete');
    }
  }
  assertKycReady(): void { this.kyc.assertReady(); }
  createCustomer(input: PartnerCustomerInput): Promise<string> { return this.kyc.createCustomer(input); }
  getKycStatus(customerNo: string): Promise<PartnerKycStatus> { return this.kyc.getKycStatus(customerNo); }
  getKycRequirements() { return this.kyc.getKycRequirements(); }
  reconcileKycSubmission(input: PartnerCustomerInput) { return this.kyc.reconcileKycSubmission(input); }

  private async pin(): Promise<string> {
    const info = await this.client.loginInfo();
    const pinSet: unknown = info.pinCodeSet;
    if (pinSet !== true && pinSet !== 1) throw new PartnerError('Set the UPay payment password on the bot account before submitting financial operations', false);
    return encryptPaymentPin(this.config.UPAY_PAYMENT_PASSWORD!, info);
  }
  private async observe<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); } catch (error) { if (error instanceof UpayNotDispatchedError) throw error; throw uncertain(); }
  }
  private async pages(endpoint: string, method: 'GET' | 'POST', params: UpayObject): Promise<UpayObject[]> {
    const rows: UpayObject[] = [];
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const input = { ...params, pageNo, pageSize: PAGE_SIZE };
      const page = object(await this.client.readRequest(method, endpoint, method === 'GET' ? { query: input as Record<string, string | number> } : { body: input }), 'page');
      if (!Array.isArray(page.list)) throw uncertain();
      rows.push(...page.list.map((row) => object(row, 'page row')));
      const total = Number(page.totalPages);
      if ((Number.isInteger(total) && total >= 0 && pageNo >= total) || page.list.length < PAGE_SIZE) return rows;
    }
    throw new PartnerError('UPay pagination exceeded the supported reconciliation window', true);
  }
  private async cardDetail(partnerCardId: string): Promise<UpayObject> {
    return object(await this.client.readRequest('GET', '/card/getAgentCustomerCardDetail', { query: { agentCustomerCardId: partnerCardId } }), 'card detail');
  }
  private receiptEvidence(response: unknown): { receiptId?: string; cardId?: string; evidence: SubmissionEvidence } {
    const data = response && typeof response === 'object' && !Array.isArray(response) ? response as UpayObject : {};
    const evidence: SubmissionEvidence = {};
    for (const key of ['orderNo', 'agentCustomerCardId', 'accountCardId', 'brokerCardId']) {
      const id = identifier(data[key]);
      if (id) evidence[key] = id;
    }
    const recordId = identifier(data.id);
    if (recordId) evidence.receiptRecordId = recordId;
    return { receiptId: identifier(data.orderNo) ?? recordId ?? undefined, cardId: identifier(data.agentCustomerCardId) ?? undefined, evidence };
  }
  private async submit(reference: string, kind: UpaySubmissionKind, endpoint: string, body: UpayObject, evidence: SubmissionEvidence, beforeSubmit?: () => Promise<void>): Promise<UpaySubmission> {
    const { pinCode: _pin, ...fingerprint } = body;
    const step = financialStep(kind);
    const claim = await this.journal.begin({ reference, kind, requestHash: requestHash(fingerprint), evidence: { ...evidence, step } });
    if (!claim.created) {
      if (provenNotDispatched(claim.submission)) throw new UpayNotDispatchedError();
      return claim.submission;
    }
    let response: unknown;
    let enteredClient = false;
    try {
      await beforeSubmit?.();
      enteredClient = true;
      response = await this.client.submitRequest(endpoint, body, { beforeDispatch: beforeSubmit });
    }
    catch (error) {
      const notDispatched = !enteredClient || error instanceof UpayError && error.metadata?.phase === 'pre_dispatch';
      const diagnostic = failedSubmission(step, error, enteredClient);
      if (notDispatched) diagnostic.dispatchPhase = 'pre_dispatch';
      await this.journal.record(reference, { state: notDispatched ? 'rejected' : 'unknown', evidence: diagnostic });
      // Re-read after committing the terminal proof; never refund if a conflicting
      // receipt or previously confirmed outcome prevented that transition.
      const persisted = notDispatched ? await this.journal.get(reference) : null;
      if (persisted && provenNotDispatched(persisted)) throw new UpayNotDispatchedError();
      throw uncertain();
    }
    const accepted: SubmissionEvidence = { step, dispatchPhase: 'post_dispatched', responseAck: 'accepted_envelope' };
    try {
      // An accepted envelope proves neither an exact receipt nor an issued card.
      // Persist that fact before extracting IDs or claiming receipt aliases.
      await this.journal.record(reference, { state: 'acknowledged', evidence: accepted });
      const receipt = this.receiptEvidence(response);
      if ((kind === 'freeze' || kind === 'unfreeze') && !receipt.cardId) receipt.cardId = identifier(evidence.agentCustomerCardId) ?? undefined;
      await this.journal.claimAliases(reference, [
        ...(identifier(receipt.evidence.orderNo) ? [`order:${receipt.evidence.orderNo}`] : []),
        ...(identifier(receipt.evidence.receiptRecordId) ? [`record:${receipt.evidence.receiptRecordId}`] : []),
        ...(kind === 'issue' && receipt.cardId ? [`card:${receipt.cardId}`] : []),
      ]);
      await this.journal.record(reference, { state: receipt.receiptId || receipt.cardId ? 'acknowledged' : 'unknown',
        partnerReceiptId: receipt.receiptId, partnerCardId: receipt.cardId, evidence: receipt.evidence });
      return (await this.journal.get(reference))!;
    } catch {
      await this.journal.record(reference, { state: 'unknown', evidence: accepted });
      throw uncertain();
    }
  }
  private async existing(reference: string, kind: UpaySubmissionKind): Promise<UpaySubmission | null> {
    const row = await this.journal.get(reference);
    if (row && row.kind !== kind) throw uncertain();
    if (row && provenNotDispatched(row)) throw new UpayNotDispatchedError();
    return row;
  }

  async issueCard(input: { externalRef: string; partnerCustomerId: string; maxFeeUsd?: bigint; beforeSubmit?: () => Promise<void> }): Promise<PartnerCard> {
    this.assertWriteReady();
    const previous = await this.existing(input.externalRef, 'issue');
    if (previous) {
      if (previous.evidence.customerNo !== input.partnerCustomerId) throw uncertain();
      const card = await this.findCardByExternalRef(input.externalRef);
      if (card) return card;
      const row = await this.journal.get(input.externalRef);
      if (row?.partnerReceiptId || row?.partnerCardId) throw new PartnerPendingError();
      throw uncertain();
    }
    if (input.maxFeeUsd === undefined) throw new PartnerError('An explicit issuance fee budget is required', false);
    const quote = await this.prepareIssue(input.partnerCustomerId, input.maxFeeUsd);
    const pinCode = await this.pin();
    const productId = this.config.UPAY_PRODUCT_ID;
    const row = await this.submit(input.externalRef, 'issue', '/card/applyOpenCard', { ...quote.payload, pinCode },
      { customerNo: input.partnerCustomerId, agentCardId: productId, openFeeUsdt: quote.openFeeUsdt, defaultOpenUsdt: quote.defaultOpenUsdt,
        maxFeeBudgetUsdt: formatCents(input.maxFeeUsd) }, input.beforeSubmit);
    const card = await this.findCardByExternalRef(input.externalRef);
    if (card) return card;
    if (row.partnerReceiptId || row.partnerCardId) throw new PartnerPendingError();
    throw uncertain();
  }

  async validateIssue(input: { partnerCustomerId: string; maxFeeUsd: bigint }): Promise<void> {
    this.assertWriteReady();
    await this.prepareIssue(input.partnerCustomerId, input.maxFeeUsd);
  }

  private async prepareIssue(customerNo: string, maxFeeUsd: bigint) {
    if ((await this.kyc.getKycStatus(customerNo)).status !== 'approved') throw new PartnerError('UPay customer KYC is not approved', false);
    const productId = this.config.UPAY_PRODUCT_ID;
    const [detail, form] = await Promise.all([
      this.client.readRequest('GET', '/card/getMayApplyCardDetail', { query: { agentCardId: productId } }),
      this.client.readRequest('GET', '/card/getCardFee', { query: { agentCardId: productId, customerNo } }),
    ]);
    const issuanceForm = structuredClone(object(form, 'issuance form'));
    // Shipping addresses have no client-owned binding in this virtual-card
    // flow. A catalog value must not silently become a delivery destination.
    if (issuanceForm.recipientAddressId != null && issuanceForm.recipientAddressId !== '') {
      throw new PartnerError('UPay delivery address is not supported for this card flow', false);
    }
    // getCardFee can return catalog IDs without an ownership binding. Only the
    // locally bound, read-back verified address may reach the financial POST.
    if (billingAddressRequired(issuanceForm) || issuanceForm.addressId != null && issuanceForm.addressId !== '') {
      const addressId = identifier(await this.billing?.getVerifiedAddressId(customerNo, object(detail, 'product').restrictedCallingCode));
      if (!addressId) throw new PartnerBillingAddressRequiredError();
      issuanceForm.addressId = addressId;
    }
    // Native defaultType only initializes the selector; the selected documentType
    // is the posted value. Our explicit selection must come from approved KYC,
    // even when the fee form retains a different nonnull product default.
    if (!this.kyc.getDocumentType) throw new PartnerError('The verified KYC document type is unavailable', false);
    const verifiedType = await this.kyc.getDocumentType(customerNo);
    if (verifiedType !== 1 && verifiedType !== 2) throw new PartnerError('The verified KYC document type is unavailable', false);
    issuanceForm.documentType = verifiedType;
    return issuancePayload(object(detail, 'product'), issuanceForm, customerNo, productId, maxFeeUsd);
  }

  private async receipt(row: UpaySubmission): Promise<UpayObject | null> {
    if (!row.partnerReceiptId) return null;
    const orderNo = identifier(row.evidence.orderNo);
    const recordId = identifier(row.evidence.receiptRecordId);
    if (!orderNo && !recordId) return null;
    const records = await this.pages('/card/getPageToCardOperateRecord', 'POST', { operateType: row.kind === 'issue' ? 5 : 6, ...(orderNo ? { orderNo } : {}) });
    const matches = records.filter((record) => orderNo ? identifier(record.orderNo) === orderNo : identifier(record.id) === recordId);
    if (matches.length !== 1) return null;
    return matches[0]!;
  }
  private async claimReceiptAliases(row: UpaySubmission, receipt: UpayObject, cardId?: string): Promise<void> {
    const orderNo = identifier(receipt.orderNo), recordId = identifier(receipt.id);
    await this.journal.claimAliases(row.reference, [...(orderNo ? [`order:${orderNo}`] : []), ...(recordId ? [`record:${recordId}`] : []),
      ...(row.kind === 'issue' && cardId ? [`card:${cardId}`] : [])]);
    await this.journal.record(row.reference, { state: 'acknowledged', evidence: { ...(orderNo ? { orderNo } : {}), ...(recordId ? { receiptRecordId: recordId } : {}) } });
  }
  private issueReceiptCost(row: UpaySubmission, receipt: UpayObject): bigint | null {
    if (Number(receipt.status) !== 1) return null;
    if (identifier(receipt.customerNo) !== identifier(row.evidence.customerNo) || receipt.currency !== 'USDT'
      || exactCents(receipt.rechargeAmount, 'receipt initial recharge') !== 0n
      || exactCents(receipt.openCardAmount, 'receipt issuance fee') !== exactCents(row.evidence.openFeeUsdt, 'quoted issuance fee')) throw uncertain();
    const actual = exactCents(receipt.paymentAmount, 'receipt issuance payment');
    if (actual > exactCents(row.evidence.maxFeeBudgetUsdt, 'reserved issuance budget')) throw uncertain();
    return actual;
  }
  private receiptMatchesCard(receipt: UpayObject, cardId: string, detail: UpayObject): boolean {
    const brokerId = identifier(receipt.brokerCardId ?? receipt.cardId);
    return identifier(receipt.agentCustomerCardId) === cardId || (brokerId !== null && brokerId === identifier(detail.brokerCardId));
  }
  private async issuedCard(row: UpaySubmission, cardId: string, receipt: UpayObject, actualCost: bigint): Promise<PartnerCard | null> {
    const detail = await this.cardDetail(cardId);
    if (detail.agentCustomerCardId !== undefined && identifier(detail.agentCustomerCardId) !== cardId) throw uncertain();
    if (identifier(detail.customerNo) !== identifier(row.evidence.customerNo)) throw uncertain();
    if (!this.receiptMatchesCard(receipt, cardId, detail)) throw uncertain();
    if (detail.agentCardId !== undefined && String(detail.agentCardId) !== row.evidence.agentCardId) throw uncertain();
    if (Number(detail.cardStatus ?? detail.state) !== 1) return null;
    const info = await this.client.loginInfo();
    const accountCardId = identifier(detail.accountCardId);
    if (!accountCardId || !info.iv) throw uncertain();
    const expiryText = typeof detail.expirationTime === 'string' && /^(?:\d{2}\/\d{2,4}|\d{4}-\d{2}(?:-\d{2})?)$/.test(detail.expirationTime)
      ? detail.expirationTime : decryptCardField(detail.expirationTime, accountCardId, info.iv);
    const expires = expiry(expiryText);
    const number = typeof detail.cardNumber === 'string' ? detail.cardNumber : '';
    const decrypted = /\d{4}$/.test(number) && /[*xX]/.test(number) ? number : decryptCardField(number, accountCardId, info.iv);
    const last4 = /\d{4}$/.exec(decrypted)?.[0];
    if (!last4) throw uncertain();
    const card = { partnerCardId: cardId, last4, ...expires };
    await this.claimReceiptAliases(row, receipt, cardId);
    await this.journal.record(row.reference, { state: 'confirmed', partnerCardId: cardId, evidence: { last4, ...expires, actualIssueCostUsdt: formatCents(actualCost) } });
    return card;
  }
  async findCardByExternalRef(reference: string): Promise<PartnerCard | null> {
    return this.observe(async () => {
    const row = await this.existing(reference, 'issue');
    if (!row) return null;
    if (row.state === 'confirmed' && row.partnerCardId && typeof row.evidence.last4 === 'string') {
      if (exactCents(row.evidence.actualIssueCostUsdt, 'confirmed issuance payment') > exactCents(row.evidence.maxFeeBudgetUsdt, 'reserved issuance budget')) throw uncertain();
      return {
      partnerCardId: row.partnerCardId, last4: row.evidence.last4, expiryMonth: Number(row.evidence.expiryMonth), expiryYear: Number(row.evidence.expiryYear),
      };
    }
    const receipt = await this.receipt(row);
    if (!receipt) return null;
    const actualCost = this.issueReceiptCost(row, receipt);
    if (actualCost === null) return null;
    if (row.partnerCardId) return this.issuedCard(row, row.partnerCardId, receipt, actualCost);
    const directId = identifier(receipt.agentCustomerCardId);
    if (directId) return this.issuedCard(row, directId, receipt, actualCost);
    const brokerId = identifier(receipt.brokerCardId ?? receipt.cardId);
    if (!brokerId) return null;
    const matches = (await this.pages('/card/list', 'GET', { customerNo: row.evidence.customerNo })).filter((card) => identifier(card.brokerCardId) === brokerId);
    const cardId = matches.length === 1 ? identifier(matches[0]!.agentCustomerCardId) : null;
    return cardId ? this.issuedCard(row, cardId, receipt, actualCost) : null;
    });
  }

  async rechargeCard(input: { partnerCardId: string; amountUsd: bigint; externalRef: string; maxDebitUsd?: bigint; beforeSubmit?: () => Promise<void> }): Promise<void> {
    this.assertWriteReady();
    const previous = await this.existing(input.externalRef, 'recharge');
    if (previous) {
      if (previous.evidence.agentCustomerCardId !== input.partnerCardId || previous.evidence.netUsd !== formatCents(input.amountUsd)) throw uncertain();
      if (await this.isRechargeDone(input.externalRef)) return;
      if ((await this.journal.get(input.externalRef))?.partnerReceiptId) throw new PartnerPendingError();
      throw uncertain();
    }
    if (input.maxDebitUsd === undefined) throw new PartnerError('An explicit recharge debit budget is required', false);
    const [info, pinCode] = await Promise.all([
      this.client.readRequest('GET', '/card/getRechargeCardInfo', { query: { agentCustomerCardId: input.partnerCardId } }), this.pin(),
    ]);
    const quote = rechargeQuote(object(info, 'recharge quote'), input.amountUsd, input.maxDebitUsd);
    const row = await this.submit(input.externalRef, 'recharge', '/card/recharge', { pinCode, agentCustomerCardId: input.partnerCardId, amount: quote.grossUsdt },
      { agentCustomerCardId: input.partnerCardId, grossUsdt: quote.grossUsdt, netUsd: formatCents(input.amountUsd),
        partnerFeeUsdt: quote.partnerFeeUsdt, exchangeRate: quote.exchangeRate, rechargeRate: quote.rechargeRate }, input.beforeSubmit);
    if (await this.isRechargeDone(input.externalRef)) return;
    if (row.partnerReceiptId) throw new PartnerPendingError();
    throw uncertain();
  }
  async validateRecharge(input: { partnerCardId: string; amountUsd: bigint; maxDebitUsd: bigint }): Promise<void> {
    this.assertWriteReady();
    const info = object(await this.client.readRequest('GET', '/card/getRechargeCardInfo', { query: { agentCustomerCardId: input.partnerCardId } }), 'recharge quote');
    rechargeQuote(info, input.amountUsd, input.maxDebitUsd);
  }
  async getRechargeMinimum(partnerCardId: string): Promise<bigint> {
    const info = object(await this.client.readRequest('GET', '/card/getRechargeCardInfo', { query: { agentCustomerCardId: partnerCardId } }), 'recharge quote');
    return minimumRechargeNet(info);
  }
  async isRechargeDone(reference: string): Promise<boolean> {
    return this.observe(async () => {
    const row = await this.existing(reference, 'recharge');
    if (!row) return false;
    if (row.state === 'confirmed') return true;
    const receipt = await this.receipt(row);
    if (!receipt || Number(receipt.status) !== 1) return false;
    const cardId = identifier(row.evidence.agentCustomerCardId);
    if (!cardId) return false;
    const detail = await this.cardDetail(cardId);
    const exactCard = identifier(receipt.agentCustomerCardId) === cardId || (identifier(receipt.brokerCardId) !== null && identifier(receipt.brokerCardId) === identifier(detail.brokerCardId))
      || (identifier(receipt.accountCardId) !== null && identifier(receipt.accountCardId) === identifier(detail.accountCardId));
    if (!exactCard || receipt.rechargeCurrency !== 'USDT' || receipt.receivedCurrency !== 'USD' || exactCents(receipt.rechargeAmount, 'receipt rechargeAmount') !== exactCents(row.evidence.grossUsdt, 'journal grossUsdt') || exactCents(receipt.receivedAmount, 'receipt receivedAmount') !== exactCents(row.evidence.netUsd, 'journal netUsd')) return false;
    await this.claimReceiptAliases(row, receipt);
    await this.journal.record(reference, { state: 'confirmed', evidence: receipt.rechargeFee !== undefined ? { partnerFeeUsdt: decimal(receipt.rechargeFee, 'receipt rechargeFee').text } : {} });
    return true;
    });
  }

  private async setState(partnerCardId: string, frozen: boolean, reference?: string, beforeSubmit?: () => Promise<void>): Promise<void> {
    this.assertWriteReady();
    if (!reference) throw new PartnerError('An operation reference is required for UPay card state changes', false);
    const kind = frozen ? 'freeze' : 'unfreeze';
    const previous = await this.existing(reference, kind);
    if (previous && previous.evidence.agentCustomerCardId !== partnerCardId) throw uncertain();
    if (!previous) {
      await this.submit(reference, kind, '/card/thawFrozen', { pinCode: await this.pin(), agentCustomerCardIds: [partnerCardId], state: frozen ? 1 : 2 }, { agentCustomerCardId: partnerCardId }, beforeSubmit);
    }
    const state = await this.getCardState(partnerCardId);
    if (state !== (frozen ? 'frozen' : 'active')) throw new PartnerPendingError();
    await this.journal.record(reference, { state: 'confirmed' });
  }
  freezeCard(partnerCardId: string, reference?: string, beforeSubmit?: () => Promise<void>): Promise<void> { return this.setState(partnerCardId, true, reference, beforeSubmit); }
  unfreezeCard(partnerCardId: string, reference?: string, beforeSubmit?: () => Promise<void>): Promise<void> { return this.setState(partnerCardId, false, reference, beforeSubmit); }
  async getCardState(partnerCardId: string): Promise<'active' | 'frozen' | null> {
    return this.observe(async () => {
    const detail = await this.cardDetail(partnerCardId);
    const state = Number(detail.cardStatus ?? detail.state);
    return state === 1 ? 'active' : state === 4 ? 'frozen' : null;
    });
  }

  async getIssueSettlement(reference: string): Promise<{ grossUsd: bigint }> {
    return this.observe(async () => {
    const row = await this.existing(reference, 'issue');
    if (!row || row.state !== 'confirmed') throw uncertain();
    const actual = exactCents(row.evidence.actualIssueCostUsdt, 'confirmed issuance payment');
    if (actual > exactCents(row.evidence.maxFeeBudgetUsdt, 'reserved issuance budget')) throw uncertain();
    return { grossUsd: actual };
    });
  }
  async getRechargeSettlement(reference: string): Promise<{ grossUsd: bigint }> {
    return this.observe(async () => {
    const row = await this.existing(reference, 'recharge');
    if (!row || row.state !== 'confirmed') throw uncertain();
    return { grossUsd: exactCents(row.evidence.grossUsdt, 'confirmed recharge cost') };
    });
  }

  async getCardSensitive(partnerCardId: string) {
    return this.observe(async () => {
    let detail = await this.cardDetail(partnerCardId);
    const info = await this.client.loginInfo();
    const decode = (data: UpayObject) => {
      const accountCardId = identifier(data.accountCardId ?? detail.accountCardId);
      if (!accountCardId || !info.iv) throw uncertain();
      const field = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value) ? value : decryptCardField(value, accountCardId, info.iv!);
      const pan = field(data.cardNumber, /^\d{12,19}$/).replace(/\s/g, '');
      const cvv = field(data.cvv, /^\d{3,4}$/);
      const expires = expiry(field(data.expirationTime, /^(?:\d{2}\/\d{2,4}|\d{4}-\d{2}(?:-\d{2})?)$/));
      if (!/^\d{12,19}$/.test(pan) || !/^\d{3,4}$/.test(cvv)) throw uncertain();
      return { pan, cvv, ...expires, holderName: typeof data.cardSignatureName === 'string' ? data.cardSignatureName : '' };
    };
    try { return decode(detail); }
    catch {
      // The panel has a separate payment-PIN-protected read for cards whose ordinary detail is masked.
      const revealed = object(await this.client.readRequest('POST', '/card/getBrokerCardDetailDecrypt', {
        body: { pinCode: await this.pin(), agentCustomerCardId: partnerCardId },
      }), 'sensitive card detail');
      detail = { ...detail, ...revealed };
      return decode(detail);
    }
    });
  }
  async listTransactions(partnerCardId: string): Promise<PartnerTransaction[]> {
    const rows = await this.pages('/card/getPageToTransaction', 'POST', { agentCustomerCardId: partnerCardId });
    const result: PartnerTransaction[] = [];
    for (const row of rows) {
      const type = Number(row.type), status = Number(row.status);
      if (type !== 2 && type !== 3) continue;
      if (status !== 4 && !(type === 3 && status === 1)) continue;
      const id = identifier(row.billId);
      if (!id || row.currency !== 'USD') throw new PartnerError('UPay posted transaction identity or currency is unsupported', true);
      const amountUsd = exactCents(row.amount, 'transaction amount');
      const occurredAt = new Date(Number(row.transactionTime));
      if (amountUsd <= 0n || !Number.isFinite(occurredAt.getTime())) throw uncertain();
      result.push({ partnerTxId: `upay:${id}`, kind: type === 2 ? 'purchase' : 'refund', amountUsd,
        merchant: typeof row.merchantName === 'string' ? row.merchantName : '', occurredAt });
    }
    return result.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async bindReceipt(reference: string, orderNo: string, partnerCardId?: string): Promise<void> {
    return this.observe(async () => {
    const row = await this.journal.get(reference);
    if (!row || !['issue', 'recharge'].includes(row.kind) || !identifier(orderNo)) throw uncertain();
    if (row.state === 'confirmed' || row.state === 'rejected' || (row.evidence.orderNo !== undefined && row.evidence.orderNo !== orderNo)) throw uncertain();
    const candidate: UpaySubmission = { ...row, partnerReceiptId: orderNo, evidence: { ...row.evidence, orderNo } };
    const receipt = await this.receipt(candidate);
    if (!receipt) throw uncertain();
    if (row.evidence.receiptRecordId !== undefined && identifier(receipt.id) !== row.evidence.receiptRecordId) throw uncertain();
    if (row.kind === 'issue') {
      if (this.issueReceiptCost(row, receipt) === null) throw uncertain();
      if (partnerCardId) {
        const detail = await this.cardDetail(partnerCardId);
        if (identifier(detail.customerNo) !== identifier(row.evidence.customerNo)) throw uncertain();
        if (detail.agentCardId !== undefined && String(detail.agentCardId) !== row.evidence.agentCardId) throw uncertain();
        if (!this.receiptMatchesCard(receipt, partnerCardId, detail)) throw uncertain();
      }
    } else {
      const cardId = identifier(row.evidence.agentCustomerCardId);
      if (!cardId) throw uncertain();
      const detail = await this.cardDetail(cardId);
      if (!(identifier(receipt.agentCustomerCardId) === cardId || (identifier(receipt.brokerCardId) !== null && identifier(receipt.brokerCardId) === identifier(detail.brokerCardId))
        || (identifier(receipt.accountCardId) !== null && identifier(receipt.accountCardId) === identifier(detail.accountCardId)))) throw uncertain();
      if (receipt.rechargeCurrency !== 'USDT' || receipt.receivedCurrency !== 'USD' || exactCents(receipt.rechargeAmount, 'receipt rechargeAmount') !== exactCents(row.evidence.grossUsdt, 'journal grossUsdt') || exactCents(receipt.receivedAmount, 'receipt receivedAmount') !== exactCents(row.evidence.netUsd, 'journal netUsd')) throw uncertain();
    }
    await this.claimReceiptAliases(row, receipt, partnerCardId);
    await this.journal.record(reference, { state: 'acknowledged', partnerReceiptId: row.partnerReceiptId ?? orderNo, partnerCardId, evidence: { orderNo, operatorBound: true } });
    });
  }
}
