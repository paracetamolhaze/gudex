// Контракт API между backend и приложением. Все суммы — десятичные строки.
import type { Asset, Network, WalletAsset } from './assets';

export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'unknown';
export type CardStatus = 'pending' | 'active' | 'frozen' | 'failed' | 'closed';
export type OperationStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'unknown';
export type OperationType = 'issue' | 'topup' | 'freeze' | 'unfreeze';
export type Locale = 'ru' | 'en';

export type ErrorCode =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'telegram_auth_failed'
  | 'pin_required'
  | 'pin_invalid'
  | 'pin_locked'
  | 'unlock_required'
  | 'kyc_required'
  | 'kyc_already_submitted'
  | 'insufficient_funds'
  | 'card_limit'
  | 'card_not_active'
  | 'billing_address_required'
  | 'card_region_restricted'
  | 'quote_changed'
  | 'amount_too_small'
  | 'invalid_address'
  | 'recipient_not_found'
  | 'self_transfer'
  | 'provider_unavailable'
  | 'internal';

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; attemptsLeft?: number; lockedUntil?: string; minAmount?: string; asset?: WalletAsset };
}

// Сессия Mini App. Пока код-пароль не введён, сессия «заблокирована»: доступны только профиль и установка кода.
export interface SessionDto {
  accessToken: string;
  expiresIn: number;
  unlocked: boolean;
  hasPin: boolean;
}

// Короткоживущее подтверждение для чувствительных действий (показ реквизитов карты).
export interface ConfirmationDto {
  confirmationToken: string;
  expiresIn: number;
}

export interface BiometricTokenDto {
  biometricToken: string;
}

export interface KycDto {
  status: KycStatus;
  firstName: string | null;
  lastName: string | null;
  rejectionReason: string | null;
  submissionState: 'none' | 'queued' | 'submitted' | 'unknown' | 'manual_review' | 'manual_verified';
}

export interface KycDocumentDto {
  id: string;
  kind: 'front' | 'back' | 'selfie';
  mimeType: 'image/jpeg' | 'image/png';
  size: number;
  expiresAt: string;
}

export interface KycRequirementsDto {
  live: boolean;
  enabled: boolean;
  documentsRequired: boolean;
  selfieRequired: boolean;
  maxUploadBytes: number;
  documentTypes: ('id_card' | 'passport')[];
}

export interface MeDto {
  id: string;
  telegram: {
    id: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    photoUrl: string | null;
  };
  locale: Locale;
  hasPin: boolean;
  kyc: KycDto;
}

export interface BalanceDto {
  asset: WalletAsset;
  amount: string;
}

export interface WalletDto {
  balances: BalanceDto[];
  cardsTotalUsd: string;
  totalUsd: string;
}

export interface DepositAddressDto {
  asset: WalletAsset;
  network: Network;
  address: string;
  minAmount: string;
  demo: boolean;
}

export interface DepositInvoiceOptionDto {
  asset: WalletAsset;
  network: Network;
  decimals: number;
  minAmount: string;
  maxAmount: string;
}

export interface DepositInvoiceInput {
  asset: WalletAsset;
  network: Network;
  amount: string;
  idempotencyKey: string;
}

export type DepositInvoiceState = 'prepared' | 'sending' | 'awaiting_payment' | 'confirming' | 'credited' | 'expired' | 'unknown';
export interface DepositInvoiceDto {
  id: string;
  state: DepositInvoiceState;
  asset: WalletAsset;
  network: Network;
  requestedAmount: string;
  creditedAmount: string | null;
  paymentUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CardDto {
  id: string;
  status: CardStatus;
  pendingOperationStatus: 'pending' | 'processing' | 'unknown' | null;
  pendingOperationId: string | null;
  issueRestriction?: 'billing_phone_region_restricted' | null;
  productName: string;
  last4: string | null;
  holderName: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  currency: 'USD';
  balance: string;
  failureReason: string | null;
  createdAt: string;
}

export interface CardSensitiveDto {
  pan: string;
  cvv: string;
  expiryMonth: number;
  expiryYear: number;
  holderName: string;
}

export interface OperationDto {
  id: string;
  type: OperationType;
  status: OperationStatus;
  fulfillmentMode?: 'automatic' | 'manual';
  cardId: string;
  asset: WalletAsset | null;
  amount: string | null;
  fee: string | null;
  fundingSource?: 'wallet' | 'broker';
  issueRestriction?: 'billing_phone_region_restricted' | null;
  error: string | null;
  createdAt: string;
}

export interface CardIssueQuoteDto {
  asset: WalletAsset;
  // Current issuance fee in USD; customerCharge is in the selected asset.
  fee: string;
  customerCharge: string;
  fundingSource: 'wallet' | 'broker';
}

export type CardAdditionalAttemptQuoteDto =
  | { eligible: false; reason: 'unavailable' | 'already_requested'; existingOperation?: OperationDto }
  | { eligible: true; quoteToken: string; expiresAt: string; termsVersion: 'additional-issue-v1';
      asset: 'USDT'; fundingSource: 'broker'; customerCharge: '0'; additionalBrokerCostUsd: '10';
      retainedBrokerReserveUsd: '10'; maximumCumulativeCostUsd: '20' };

export interface CardAdditionalAttemptInput {
  quoteToken: string;
  idempotencyKey: string;
  acceptedRisk: true;
  termsVersion: 'additional-issue-v1';
}

export interface CardBillingAddressInput {
  countryId: string;
  postalCode: string;
  address: string;
}

export interface CardBillingAddressDto {
  required: boolean;
  status: 'missing' | 'ready' | 'pending';
  address: CardBillingAddressInput | null;
}

export interface CardBillingCountryDto {
  id: string;
  name: string;
  code: string | null;
}

export interface TopupQuoteDto {
  asset: WalletAsset;
  amount: string;
  fee: string;
  netUsd: string;
  rate: string;
  minAmount?: string;
}

export type ActivityKind =
  | 'deposit'
  | 'withdrawal'
  | 'transfer_in'
  | 'transfer_out'
  | 'referral_reward'
  | 'card_issue'
  | 'card_topup'
  | 'card_purchase'
  | 'card_refund';
export type ActivityStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface ActivityItemDto {
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  asset: Asset;
  // Со знаком: "+100" — поступление, "-25.5" — списание.
  amount: string;
  fee: string | null;
  fundingSource?: 'wallet' | 'broker';
  merchant: string | null;
  // Вторая сторона: @ник при переводе, адрес при выводе.
  counterparty: string | null;
  cardLast4: string | null;
  network: Network | null;
  createdAt: string;
}

// ─── Вывод, переводы, рефералы ───────────────────────────────────────────

export type WithdrawalStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'unknown';

export interface WithdrawalDto {
  id: string;
  asset: WalletAsset;
  network: Network;
  address: string;
  // Списано с баланса (включая комиссию сети) и сколько дойдёт до адреса.
  amount: string;
  fee: string;
  netAmount: string;
  status: WithdrawalStatus;
  txHash: string | null;
  error: string | null;
  createdAt: string;
}

// Получатель перевода — пользователь GUDEX с этим @ником.
export interface RecipientDto {
  username: string;
  name: string | null;
}

export interface TransferDto {
  id: string;
  asset: WalletAsset;
  amount: string;
  recipient: RecipientDto;
  createdAt: string;
}

export interface ReferralDto {
  link: string;
  invited: number;
  earned: BalanceDto[];
  // Доля от комиссий приглашённых, в базисных пунктах (2000 = 20%).
  shareBps: number;
}

// Всё, что нужно экрану «Купить крипту», чтобы запустить виджет WhiteBird (wbExchangeSdk.setup).
// Выдаётся только вошедшему пользователю: в нём ключи партнёра и адреса пополнения клиента.
export interface ExchangeSessionDto {
  ready: boolean;
  // Скрипт SDK (CDN) и merchantId партнёра. mode: AuthMode | LoginMode | TokensMode.
  sdkUrl: string;
  merchantId: string | null;
  // merchantPass — не секрет, а basic-токен для AuthMode, видимый клиенту (см. docs/13_WHITEBIRD_SDK.md).
  merchantPass: string | null;
  mode: string;
  themeMode: 'dark' | 'light';
  // Фирменный цвет для брендирования виджета (hex) или null.
  color: string | null;
  locale: Locale;
  // Куда отправлять купленную крипту: адрес пополнения GUDEX клиента + код валюты WhiteBird (сеть внутри кода).
  options: { asset: WalletAsset; network: Network; address: string; currency: string }[];
}

// Объявление о сбоях и технических работах. Включается командой боту /notice.
export interface ServiceNoticeDto {
  message: string | null;
  updatedAt: string | null;
}

export interface AppConfigDto {
  assets: {
    asset: WalletAsset;
    decimals: number;
    networks: { id: Network; name: string; short: string; withdrawFee: string; minWithdraw: string }[];
    minDeposit: string;
  }[];
  card: {
    productName: string;
    issueFeeUsd: string;
    topupFeeBps: number;
    minTopupUsd: string;
    maxCardsPerUser: number;
    // Лимиты эмитента. null — не заданы (не показываем).
    limits: { perTransactionUsd: string | null; dailyUsd: string | null; monthlyUsd: string | null };
  };
  referral: { shareBps: number };
  links: { site: string; support: string | null; channel: string | null };
  // Покупка и продажа крипты картой внутри приложения — партнёр WhiteBird. ready=false, пока не выданы ключи.
  exchange: { provider: 'whitebird'; ready: boolean };
  // true только в dev-сборке backend: включает кнопки «симулировать депозит/покупку».
  devTools: boolean;
  integration: {
    cardPartner: 'mock' | 'upay';
    issuanceMode?: 'automatic' | 'manual';
    upayConfigured: boolean;
    upayWritesEnabled: boolean;
    deposits: 'demo' | 'disabled' | 'live';
    depositFlow: 'address' | 'checkout' | 'disabled';
    depositInvoiceRead: boolean;
    withdrawals: 'demo' | 'disabled';
    capabilities: { kyc: boolean; issue: boolean; topup: boolean; freeze: boolean };
  };
}
