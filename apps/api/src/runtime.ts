import type { Deps } from './app';
import type { Config } from './config';
import type { Db } from './db/client';
import { DisabledDepositProvider, MockDepositProvider } from './deposits/provider';
import { AppError } from './lib/errors';
import { MockUpayPartner } from './partner/mock';
import { UpayClient } from './partner/upay/client';
import { UpayFinancialPartner } from './partner/upay/financial-partner';
import { UpayKycIntegration } from './partner/upay/kyc';
import { DbUpaySubmissionStore } from './partner/upay/submissions';
import { DbKycDocumentStore } from './kyc/document-store';
import { DbUpaySessionStore } from './partner/upay/session-store';
import { LogBotApi, TelegramBotApi } from './telegram/bot';
import { MockWithdrawalProvider, type WithdrawalProvider } from './withdrawals/provider';
import { CardBillingService } from './services/card-billing';
import { UpayDepositInvoices } from './partner/upay/deposit-invoices';

class DisabledWithdrawalProvider implements WithdrawalProvider {
  readonly providerId = 'disabled';
  assertAvailable(): never { throw new AppError('provider_unavailable', 'Blockchain withdrawals are not connected yet'); }
  async send(): Promise<{ txHash: string }> { return this.assertAvailable(); }
}

export function createRuntimeDeps(config: Config, db: Db): Deps {
  const mockPartner = config.CARD_PARTNER === 'mock' ? new MockUpayPartner(db, config.MOCK_PARTNER_DELAY_MS, config.KYC_MOCK_DELAY_MS) : undefined;
  const upay = new UpayClient(config, new DbUpaySessionStore(db, config.appSecret));
  const journal = new DbUpaySubmissionStore(db);
  const documents = new DbKycDocumentStore(db, config.appSecret, config.KYC_DOCUMENT_TTL_SECONDS);
  const kyc = new UpayKycIntegration(config, upay, journal, documents, db, 'customer');
  const cardBilling = new CardBillingService(db, config, upay);
  return {
    config, db, partner: mockPartner ?? new UpayFinancialPartner(config, upay, journal, kyc, cardBilling), mockPartner, upay, cardBilling,
    depositInvoices: new UpayDepositInvoices(config, upay),
    depositProvider: config.DEV_TOOLS ? new MockDepositProvider() : new DisabledDepositProvider(),
    withdrawalProvider: config.DEV_TOOLS ? new MockWithdrawalProvider(config.MOCK_PARTNER_DELAY_MS) : new DisabledWithdrawalProvider(),
    bot: config.TELEGRAM_BOT_TOKEN ? new TelegramBotApi(config.TELEGRAM_BOT_TOKEN) : new LogBotApi(),
  };
}
