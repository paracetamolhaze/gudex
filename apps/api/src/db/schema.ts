import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: 'bigint' });

export const kycStatus = pgEnum('kyc_status', ['none', 'pending', 'approved', 'rejected', 'unknown']);
export const cardStatus = pgEnum('card_status', ['pending', 'active', 'frozen', 'failed', 'closed']);
export const operationStatus = pgEnum('operation_status', ['pending', 'processing', 'succeeded', 'failed', 'unknown']);
export const operationType = pgEnum('operation_type', ['issue', 'topup', 'freeze', 'unfreeze']);
export const withdrawalStatus = pgEnum('withdrawal_status', ['pending', 'processing', 'succeeded', 'failed', 'unknown']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'done', 'failed']);

// ─── Пользователи и доступ ───────────────────────────────────────────────

// Пользователь = аккаунт Telegram. Вход — по подписанным данным Mini App (initData).
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    telegramId: bigint('telegram_id', { mode: 'bigint' }).notNull().unique(),
    username: text('username'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    photoUrl: text('photo_url'),
    locale: text('locale').notNull().default('ru'),
    // Код-пароль хранится только как scrypt-хэш с солью и серверным «перцем».
    pinHash: text('pin_hash'),
    pinFailedAttempts: integer('pin_failed_attempts').notNull().default(0),
    pinLockedUntil: timestamp('pin_locked_until', { withTimezone: true }),
    authVersion: integer('auth_version').notNull().default(0),
    // Реферальная программа: свой код для ссылки-приглашения и кто пригласил (задаётся один раз, при регистрации).
    referralCode: text('referral_code').unique(),
    referredBy: uuid('referred_by').references((): AnyPgColumn => users.id),
    // Когда отправили напоминание «выпустите карту» — оно приходит один раз.
    cardReminderSentAt: timestamp('card_reminder_sent_at', { withTimezone: true }),
    // Which Terms of Use / Privacy Policy version the client accepted, and when (proof of consent).
    termsVersion: text('terms_version'),
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [
    // Поиск получателя перевода по @нику — без учёта регистра, как в Telegram.
    index('users_username_lower_idx').on(sql`lower(${t.username})`),
    index('users_referred_by_idx').on(t.referredBy),
  ],
);

// Токены для входа по биометрии Telegram (BiometricManager хранит токен на устройстве за Face ID / отпечатком).
export const biometricTokens = pgTable(
  'biometric_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('biometric_tokens_user_idx').on(t.userId)],
);

// KYC проводит партнёр (в UPay: клиент → KYC certification). Здесь — наша копия данных и статуса.
export const kycProfiles = pgTable('kyc_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  status: kycStatus('status').notNull().default('none'),
  partnerCustomerId: text('partner_customer_id').unique(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  // У пользователей Telegram нет email, а UPay требует его при создании клиента.
  email: text('email'),
  birthDate: date('birth_date', { mode: 'string' }),
  citizenship: varchar('citizenship', { length: 2 }),
  phone: text('phone'),
  globalCode: text('global_code'),
  documentType: text('document_type'),
  documentCountry: text('document_country'),
  documentIds: jsonb('document_ids').$type<{ front: string; back?: string; selfie?: string }>(),
  // Billing address from the single manual card application; the operator enters it in UPay.
  billingAddress: jsonb('billing_address').$type<{ countryId: string; countryName: string | null; postalCode: string; address: string }>(),
  submissionId: uuid('submission_id'),
  submissionState: text('submission_state').notNull().default('none'),
  partnerProvider: text('partner_provider').notNull().default('mock'),
  documentsSubmittedAt: timestamp('documents_submitted_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  updatedAt: updatedAt(),
});

export const kycDocuments = pgTable('kyc_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  kind: text('kind').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, t => [index('kyc_documents_user_idx').on(t.userId), index('kyc_documents_expiry_idx').on(t.expiresAt)]);

// Explicitly supplied billing addresses only. The partner's shared address book
// is never imported; address and contact snapshots are authenticated ciphertext.
export const cardBillingAddresses = pgTable('card_billing_addresses', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  customerNo: text('customer_no').notNull().unique(),
  marker: varchar('marker', { length: 20 }).notNull().unique(),
  requestHash: text('request_hash').notNull(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  status: text('status').notNull().default('prepared'),
  partnerAddressId: text('partner_address_id').unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [check('card_billing_addresses_status', sql`${t.status} in ('prepared', 'sending', 'acknowledged', 'unknown', 'ready', 'rejected')`),
  check('card_billing_addresses_marker', sql`${t.marker} ~ '^GDXB[a-f0-9]{16}$'`)]);

export const upaySubmissions = pgTable('upay_submissions', {
  reference: text('reference').primaryKey(),
  kind: text('kind').notNull(),
  requestHash: text('request_hash').notNull(),
  state: text('state').notNull(),
  partnerReceiptId: text('partner_receipt_id'),
  partnerCardId: text('partner_card_id'),
  evidence: jsonb('evidence'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [uniqueIndex('upay_submissions_receipt_unique').on(t.kind, t.partnerReceiptId).where(sql`partner_receipt_id is not null`)]);

export const upaySubmissionAliases = pgTable('upay_submission_aliases', {
  kind: text('kind').notNull(),
  alias: text('alias').notNull(),
  reference: text('reference').notNull().references(() => upaySubmissions.reference),
}, t => [primaryKey({ columns: [t.kind, t.alias] })]);

// ─── Леджер (двойная запись) ─────────────────────────────────────────────
// Баланс любого счёта = сумма его проводок. Поле balance — кэш, обновляется
// в той же транзакции, что и проводки, под блокировкой строки.

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    userId: uuid('user_id').references(() => users.id),
    asset: text('asset').notNull(),
    kind: text('kind').notNull(), // user_wallet | user_card | system
    allowNegative: boolean('allow_negative').notNull().default(false),
    balance: money('balance').notNull().default(sql`0`),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_accounts_user_idx').on(t.userId)],
);

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  // Уникальная ссылка на бизнес-событие: повторная проводка того же события невозможна.
  reference: text('reference').notNull().unique(),
  metadata: jsonb('metadata'),
  createdAt: createdAt(),
});

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    asset: text('asset').notNull(),
    amount: money('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_entries_account_idx').on(t.accountId), index('ledger_entries_tx_idx').on(t.transactionId)],
);

// ─── Депозиты ────────────────────────────────────────────────────────────

export const depositAddresses = pgTable(
  'deposit_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    asset: text('asset').notNull(),
    network: text('network').notNull(),
    providerId: text('provider_id').notNull().default('mock'),
    address: text('address').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('deposit_addresses_user_asset_network').on(t.userId, t.asset, t.network)],
);

export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    asset: text('asset').notNull(),
    network: text('network').notNull(),
    providerId: text('provider_id').notNull().default('mock'),
    address: text('address').notNull(),
    // Хэш транзакции в блокчейне (+ индекс выхода) или id события провайдера.
    externalId: text('external_id').notNull().unique(),
    amount: money('amount').notNull(),
    status: text('status').notNull().default('pending'), // pending | credited
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id),
    createdAt: createdAt(),
    creditedAt: timestamp('credited_at', { withTimezone: true }),
  },
  (t) => [index('deposits_user_idx').on(t.userId)],
);

// ─── Оплата выпуска на кошелёк приложения ────────────────────────────────
// Адрес из пула закрепляется за одним клиентом на время оплаты: плательщика определяет адрес.

export const feePayments = pgTable('fee_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  asset: text('asset').notNull(),
  network: text('network').notNull(),
  family: text('family').notNull(),
  address: text('address').notNull(),
  // The fee to collect, and what has arrived on the lent address so far (6-decimal units).
  amount: money('amount').notNull(),
  received: money('received').notNull().default(0n),
  status: text('status').notNull().default('awaiting'),
  transferId: uuid('transfer_id'),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, t => [
  uniqueIndex('fee_payments_active_address').on(sql`lower(${t.address})`).where(sql`${t.status} = 'awaiting'`),
  uniqueIndex('fee_payments_one_active').on(t.userId).where(sql`${t.status} = 'awaiting'`),
  index('fee_payments_user_idx').on(t.userId),
]);

export const walletTransfers = pgTable('wallet_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  network: text('network').notNull(),
  asset: text('asset').notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull().default(0),
  fromAddress: text('from_address').notNull(),
  toAddress: text('to_address').notNull(),
  amount: money('amount').notNull(),
  // false when the on-chain value has precision below 6 decimals and cannot match a request exactly.
  exact: boolean('exact').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }),
  blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('new'),
  userId: uuid('user_id').references(() => users.id),
  depositId: uuid('deposit_id').references(() => deposits.id),
  createdAt: createdAt(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, t => [uniqueIndex('wallet_transfers_identity').on(t.network, t.txHash, t.logIndex), index('wallet_transfers_status_idx').on(t.status)]);

// ─── Вывод и переводы ────────────────────────────────────────────────────

// A native payment link is created only by an explicit user request. Its
// uncertain creation is never replayed; a paid flag alone cannot credit funds.
export const depositInvoices = pgTable('deposit_invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  providerId: text('provider_id').notNull().default('upay-invoice'),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  asset: text('asset').notNull(),
  network: text('network').notNull(),
  requestedAmount: money('requested_amount').notNull(),
  state: text('state').notNull().default('sending'),
  orderNo: text('order_no').unique(),
  urlCiphertext: text('url_ciphertext'),
  urlIv: text('url_iv'),
  urlTag: text('url_tag'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  receiptId: text('receipt_id').unique(),
  creditedAmount: money('credited_amount'),
  creditedAt: timestamp('credited_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [uniqueIndex('deposit_invoices_idempotency').on(t.userId, t.idempotencyKey),
  index('deposit_invoices_user_idx').on(t.userId),
  check('deposit_invoices_provider', sql`${t.providerId} = 'upay-invoice'`),
  check('deposit_invoices_amount', sql`${t.requestedAmount} > 0 and (${t.creditedAmount} is null or ${t.creditedAmount} > 0)`),
  check('deposit_invoices_state', sql`${t.state} in ('prepared', 'sending', 'awaiting_payment', 'confirming', 'credited', 'expired', 'unknown')`),
  check('deposit_invoices_credit_proof', sql`${t.state} <> 'credited' or (${t.orderNo} is not null and ${t.receiptId} is not null and ${t.creditedAmount} is not null and ${t.creditedAt} is not null)`)]);

// Вывод на внешний кошелёк. Деньги резервируются при создании, отправка — в фоне.
export const withdrawals = pgTable(
  'withdrawals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    asset: text('asset').notNull(),
    network: text('network').notNull(),
    providerId: text('provider_id').notNull().default('mock'),
    address: text('address').notNull(),
    amount: money('amount').notNull(), // списание с баланса, включая комиссию сети
    fee: money('fee').notNull(),
    status: withdrawalStatus('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    txHash: text('tx_hash'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('withdrawals_idempotency').on(t.userId, t.idempotencyKey), index('withdrawals_user_idx').on(t.userId)],
);

// Перевод между пользователями GUDEX — мгновенная проводка внутри леджера.
export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id),
    asset: text('asset').notNull(),
    amount: money('amount').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('transfers_idempotency').on(t.fromUserId, t.idempotencyKey),
    index('transfers_from_idx').on(t.fromUserId),
    index('transfers_to_idx').on(t.toUserId),
  ],
);

// Начисления пригласившему: доля от каждой комиссии GUDEX, которую заплатил приглашённый.
export const referralRewards = pgTable(
  'referral_rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referrerId: uuid('referrer_id')
      .notNull()
      .references(() => users.id),
    refereeId: uuid('referee_id')
      .notNull()
      .references(() => users.id),
    asset: text('asset').notNull(),
    amount: money('amount').notNull(),
    // Ссылка на проводку комиссии: за одну комиссию — одно начисление.
    source: text('source').notNull().unique(),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id),
    createdAt: createdAt(),
  },
  (t) => [index('referral_rewards_referrer_idx').on(t.referrerId)],
);

// Настройки, которые меняются без деплоя (например, объявление о сбоях).
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

// ─── Карты ───────────────────────────────────────────────────────────────

export const cards = pgTable(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    productName: text('product_name').notNull(),
    status: cardStatus('status').notNull().default('pending'),
    partnerCardId: text('partner_card_id').unique(),
    last4: varchar('last4', { length: 4 }),
    holderName: text('holder_name'),
    expiryMonth: integer('expiry_month'),
    expiryYear: integer('expiry_year'),
    failureReason: text('failure_reason'),
    // Card balance as UPay reports it (USD cents); shown instead of the local estimate when known.
    partnerBalance: money('partner_balance'),
    partnerBalanceAt: timestamp('partner_balance_at', { withTimezone: true }),
    // Operator-entered card number and CVV, AES-GCM sealed to this user and card.
    requisitesCiphertext: text('requisites_ciphertext'),
    requisitesIv: text('requisites_iv'),
    requisitesTag: text('requisites_tag'),
    // Crypto deposit addresses UPay gives this card for top-ups, entered by the operator.
    topupAddresses: jsonb('topup_addresses').$type<Record<string, string>>(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('cards_user_idx').on(t.userId)],
);

// Каждое действие с картой — отдельная операция со своим статусом.
// idempotencyKey приходит из приложения: повторный запрос не создаст вторую операцию.
export const cardOperations = pgTable(
  'card_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id),
    type: operationType('type').notNull(),
    partnerProvider: text('partner_provider').notNull().default('mock'),
    fulfillmentMode: text('fulfillment_mode').notNull().default('automatic'),
    sponsorshipId: uuid('sponsorship_id').references((): AnyPgColumn => cardIssueSponsorships.id),
    status: operationStatus('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    asset: text('asset'),
    amount: money('amount'), // Внутренний резерв источника; при sponsorship клиентское списание в DTO равно 0.
    fee: money('fee'), // Резерв выпуска/комиссия пополнения; расход брокера берётся из подтверждённого settlement.
    netUsd: money('net_usd'), // сколько зачислить на карту, в центах
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('card_operations_idempotency').on(t.userId, t.idempotencyKey),
    check('card_operations_fulfillment_mode', sql`${t.fulfillmentMode} in ('automatic', 'manual')`),
    check('card_operations_manual_dispatch', sql`${t.fulfillmentMode} <> 'manual' or (${t.attempts} = 0 and ${t.status} in ('pending', 'succeeded', 'failed'))`),
    index('card_operations_card_idx').on(t.cardId),
    check('card_operations_sponsorship_fields', sql`${t.sponsorshipId} is null or (${t.type} = 'issue' and ${t.partnerProvider} = 'upay' and ${t.asset} is not null and ${t.asset} = 'USDT' and ${t.amount} is not null and ${t.amount} = 10000000 and ${t.fee} is not null and ${t.fee} = ${t.amount})`),
  ],
);

// A new client key that resumed a pending issuance must keep replaying it after completion.
export const cardOperationRequestAliases = pgTable('card_operation_request_aliases', {
  userId: uuid('user_id').notNull().references(() => users.id),
  idempotencyKey: text('idempotency_key').notNull(),
  operationId: uuid('operation_id').notNull().references(() => cardOperations.id),
  createdAt: createdAt(),
}, t => [primaryKey({ columns: [t.userId, t.idempotencyKey] }), index('card_operation_request_aliases_operation_idx').on(t.operationId)]);

// One explicitly authorized first issuance; this never creates spendable user funds.
export const cardIssueSponsorships = pgTable('card_issue_sponsorships', {
  id: uuid('id').primaryKey().defaultRandom(),
  telegramId: bigint('telegram_id', { mode: 'bigint' }).notNull(),
  retryOfOperationId: uuid('retry_of_operation_id').unique().references((): AnyPgColumn => cardOperations.id),
  partnerProvider: text('partner_provider').notNull().default('upay'),
  budgetUsd: money('budget_usd').notNull().default(1000n),
  operationId: uuid('operation_id').unique().references((): AnyPgColumn => cardOperations.id),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [uniqueIndex('card_issue_sponsorships_primary_telegram_unique').on(t.telegramId).where(sql`${t.retryOfOperationId} is null`),
  check('card_issue_sponsorships_budget', sql`${t.budgetUsd} = 1000`),
  check('card_issue_sponsorships_provider', sql`${t.partnerProvider} = 'upay'`),
  check('card_issue_sponsorships_retry_target', sql`${t.retryOfOperationId} is null or (${t.telegramId} = 514468501 and ${t.retryOfOperationId} = '82c68578-6791-463f-9c6d-edbd4407a8ff'::uuid)`),
  check('card_issue_sponsorships_consumed', sql`${t.consumedAt} is null or ${t.operationId} is not null`)]);

// One explicit human acceptance of an additional, separate broker expense.
// The original operation and its reserve remain unmodified and uncertain.
export const cardIssueRetryConsents = pgTable('card_issue_retry_consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  originalOperationId: uuid('original_operation_id').notNull().unique().references(() => cardOperations.id),
  newOperationId: uuid('new_operation_id').notNull().unique().references(() => cardOperations.id),
  sponsorshipId: uuid('sponsorship_id').notNull().unique().references(() => cardIssueSponsorships.id),
  termsVersion: text('terms_version').notNull(),
  quoteHash: text('quote_hash').notNull(),
  authVersion: integer('auth_version').notNull(),
  kycSnapshotHash: text('kyc_snapshot_hash').notNull(),
  originalSnapshotHash: text('original_snapshot_hash').notNull(),
  productId: text('product_id').notNull(),
  additionalBudgetUsd: money('additional_budget_usd').notNull(),
  cumulativeBudgetUsd: money('cumulative_budget_usd').notNull(),
  consentedAt: timestamp('consented_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [check('card_issue_retry_consents_terms', sql`${t.termsVersion} = 'additional-issue-v1'`),
  check('card_issue_retry_consents_budgets', sql`${t.additionalBudgetUsd} = 1000 and ${t.cumulativeBudgetUsd} = 2000`)]);

export const cardTransactions = pgTable(
  'card_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id),
    partnerTxId: text('partner_tx_id').notNull().unique(),
    kind: text('kind').notNull(), // purchase | refund
    amountUsd: money('amount_usd').notNull(),
    merchant: text('merchant'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id),
    createdAt: createdAt(),
  },
  (t) => [index('card_transactions_card_idx').on(t.cardId), index('card_transactions_user_idx').on(t.userId)],
);

// ─── Очередь задач ───────────────────────────────────────────────────────

export const adminNotifications = pgTable('admin_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventKey: text('event_key').notNull(),
  recipientTelegramId: bigint('recipient_telegram_id', { mode: 'bigint' }).notNull(),
  userId: uuid('user_id').notNull().references(() => users.id),
  stage: text('stage').notNull(),
  createdAt: createdAt(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, t => [uniqueIndex('admin_notifications_event_recipient').on(t.eventKey, t.recipientTelegramId),
  check('admin_notifications_stage', sql`${t.stage} in ('verification', 'issuance', 'card_request', 'support')`)]);

// ─── Почта клиентов для кодов UPay ───────────────────────────────────────
// Адрес на нашем домене привязан к одному клиенту; письма приходят через Cloudflare Email Routing.

export const mailAddresses = pgTable('mail_addresses', {
  address: text('address').primaryKey(),
  userId: uuid('user_id').notNull().unique().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [check('mail_addresses_address', sql`${t.address} = lower(${t.address}) and length(${t.address}) <= 254`)]);

export const inboundEmails = pgTable('inbound_emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  recipient: text('recipient').notNull(),
  userId: uuid('user_id').references(() => users.id),
  sender: text('sender').notNull(),
  subject: text('subject'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  status: text('status').notNull(),
  hasCode: boolean('has_code').notNull().default(false),
  codeCiphertext: text('code_ciphertext'),
  codeIv: text('code_iv'),
  codeTag: text('code_tag'),
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
  error: text('error'),
  createdAt: createdAt(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, t => [index('inbound_emails_user_idx').on(t.userId, t.createdAt), index('inbound_emails_created_idx').on(t.createdAt),
  index('inbound_emails_status_idx').on(t.status, t.createdAt),
  check('inbound_emails_subject_check', sql`${t.subject} is null or length(${t.subject}) <= 200`),
  check('inbound_emails_status_check', sql`${t.status} in ('queued', 'delivered', 'no_code', 'unknown_sender', 'stale', 'rate_limited', 'expired', 'failed')`)]);

// ─── Поддержка в приложении ──────────────────────────────────────────────
// Один диалог на клиента. Прочитанность — по времени: что новее отметки, то не прочитано.

export const supportThreads = pgTable('support_threads', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  status: text('status').notNull().default('open'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  lastClientMessageAt: timestamp('last_client_message_at', { withTimezone: true }),
  lastSupportMessageAt: timestamp('last_support_message_at', { withTimezone: true }),
  clientReadAt: timestamp('client_read_at', { withTimezone: true }),
  supportReadAt: timestamp('support_read_at', { withTimezone: true }),
  /** The client sees messages from this moment on; older, closed conversations stay with the operator only. */
  clientSince: timestamp('client_since', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [index('support_threads_last_message_idx').on(t.lastMessageAt), check('support_threads_status_check', sql`${t.status} in ('open', 'closed')`)]);

export const supportMessages = pgTable('support_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => supportThreads.userId),
  author: text('author').notNull(),
  adminUserId: uuid('admin_user_id'),
  text: text('text').notNull(),
  createdAt: createdAt(),
}, t => [index('support_messages_thread_idx').on(t.userId, t.createdAt), check('support_messages_author_check', sql`${t.author} in ('client', 'support')`),
  check('support_messages_text_check', sql`length(${t.text}) between 1 and 2000`)]);

export const adminAuditLog = pgTable('admin_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  targetUserId: uuid('target_user_id').notNull().references(() => users.id),
  action: text('action').notNull(),
  reference: text('reference').notNull(),
  metadata: jsonb('metadata'),
  createdAt: createdAt(),
}, t => [uniqueIndex('admin_audit_action_reference').on(t.action, t.reference), index('admin_audit_target_idx').on(t.targetUserId)]);

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    queue: text('queue').notNull(),
    payload: jsonb('payload').notNull(),
    status: jobStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lockToken: uuid('lock_token'),
    dedupeKey: text('dedupe_key'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_due_idx').on(t.status, t.runAt),
    uniqueIndex('jobs_dedupe_active')
      .on(t.dedupeKey)
      .where(sql`status in ('queued', 'running')`),
  ],
);

// ─── Заглушка UPay ───────────────────────────────────────────────────────
// Таблицы изображают состояние на стороне партнёра. Настоящий адаптер их не использует.

export const mockUpayCustomers = pgTable('mock_upay_customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalRef: text('external_ref').notNull().unique(),
  email: text('email').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  birthDate: text('birth_date').notNull(),
  citizenship: text('citizenship').notNull(),
  createdAt: createdAt(),
});

export const mockUpayCards = pgTable('mock_upay_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => mockUpayCustomers.id),
  externalRef: text('external_ref').notNull().unique(),
  holderName: text('holder_name').notNull(),
  pan: text('pan').notNull(),
  cvv: text('cvv').notNull(),
  expiryMonth: integer('expiry_month').notNull(),
  expiryYear: integer('expiry_year').notNull(),
  balance: money('balance').notNull().default(sql`0`),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
});

export const mockUpayRecharges = pgTable('mock_upay_recharges', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalRef: text('external_ref').notNull().unique(),
  cardId: uuid('card_id')
    .notNull()
    .references(() => mockUpayCards.id),
  amount: money('amount').notNull(),
  createdAt: createdAt(),
});

export const mockUpayTransactions = pgTable('mock_upay_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id')
    .notNull()
    .references(() => mockUpayCards.id),
  kind: text('kind').notNull(),
  amount: money('amount').notNull(),
  merchant: text('merchant').notNull(),
  createdAt: createdAt(),
});
