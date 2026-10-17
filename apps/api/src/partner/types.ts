// Контракт с карточным партнёром. Сейчас реализован заглушкой (mock.ts).
// Настоящий адаптер UPay (HTTP к внутреннему API панели или Playwright) реализует этот же интерфейс,
// и больше ничего в backend менять не придётся.

export interface PartnerCard {
  partnerCardId: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
}

export interface PartnerCardSensitive {
  pan: string;
  cvv: string;
  expiryMonth: number;
  expiryYear: number;
  holderName: string;
}

export interface PartnerTransaction {
  partnerTxId: string;
  kind: 'purchase' | 'refund';
  amountUsd: bigint; // центы, всегда положительное
  merchant: string;
  occurredAt: Date;
}

export interface PartnerCustomerInput {
  beforeSubmit?: () => Promise<void>;
  externalRef: string; // наш userId
  email: string;
  firstName: string;
  lastName: string;
  birthDate: string; // YYYY-MM-DD
  citizenship: string; // ISO-3166 alpha-2
  kyc?: {
    submissionId: string;
    customerNo?: string;
    phone: string;
    globalCode: string;
    documentType: 'id_card' | 'passport';
    documentCountry: string;
    documentIds: { front: string; back?: string; selfie?: string };
  };
}

export type PartnerKycStatus = { status: 'pending' } | { status: 'approved' } | { status: 'rejected'; reason: string };

// Порядок у UPay: клиент (Customer Management) → KYC certification → выпуск карты на клиента → пополнение.
export interface CardPartner {
  // Синхронная проверка конфигурации/возможности записи до резервирования денег.
  assertWriteReady?(): void;
  assertKycReady?(): void;
  getKycRequirements?(): Promise<{ selfieRequired: boolean; documentTypes: ('id_card' | 'passport')[] }>;
  reconcileKycSubmission?(input: PartnerCustomerInput): Promise<{ customerNo?: string; submitted: boolean } | null>;
  // Создаёт клиента у партнёра и отправляет его на KYC. Повтор с тем же externalRef возвращает того же клиента.
  createCustomer(input: PartnerCustomerInput): Promise<string>;
  getKycStatus(partnerCustomerId: string): Promise<PartnerKycStatus>;

  // externalRef — наш id операции. Партнёр (или адаптер) обязан по нему находить уже созданную карту,
  // чтобы повтор после потерянного ответа не выпустил вторую.
  issueCard(input: { externalRef: string; partnerCustomerId: string; maxFeeUsd?: bigint; beforeSubmit?: () => Promise<void> }): Promise<PartnerCard>;
  validateIssue?(input: { partnerCustomerId: string; maxFeeUsd: bigint }): Promise<void>;
  findCardByExternalRef(externalRef: string): Promise<PartnerCard | null>;

  rechargeCard(input: { partnerCardId: string; amountUsd: bigint; externalRef: string; maxDebitUsd?: bigint; beforeSubmit?: () => Promise<void> }): Promise<void>;
  isRechargeDone(externalRef: string): Promise<boolean>;

  freezeCard(partnerCardId: string, externalRef?: string, beforeSubmit?: () => Promise<void>): Promise<void>;
  unfreezeCard(partnerCardId: string, externalRef?: string, beforeSubmit?: () => Promise<void>): Promise<void>;
  getCardState?(partnerCardId: string): Promise<'active' | 'frozen' | null>;
  bindReceipt?(reference: string, orderNo: string, partnerCardId?: string): Promise<void>;
  getIssueSettlement?(reference: string): Promise<{ grossUsd: bigint }>;
  getRechargeSettlement?(reference: string): Promise<{ grossUsd: bigint }>;
  validateRecharge?(input: { partnerCardId: string; amountUsd: bigint; maxDebitUsd: bigint }): Promise<void>;
  getRechargeMinimum?(partnerCardId: string): Promise<bigint>;

  getCardSensitive(partnerCardId: string): Promise<PartnerCardSensitive>;
  listTransactions(partnerCardId: string): Promise<PartnerTransaction[]>;
}

export class PartnerError extends Error {
  constructor(
    message: string,
    // false — подтверждённый отказ БЕЗ внешнего списания/создания.
    // Таймаут и неизвестный результат всегда retryable=true: они не разрешают возврат резерва.
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class PartnerBillingAddressRequiredError extends PartnerError {
  constructor() { super('UPay requires a verified billing address', false); }
}

export class PartnerCardRegionRestrictedError extends PartnerError {
  constructor() { super('The billing phone calling code is not supported for this card', false); }
}

// Acknowledged request with an exact receipt: poll that receipt, never resubmit the mutation.
export class PartnerPendingError extends PartnerError {
  constructor(readonly delaySeconds = 30) { super('Partner accepted the request; awaiting a confirmed result', true); }
}
