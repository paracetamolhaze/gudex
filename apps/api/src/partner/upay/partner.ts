import { AppError } from '../../lib/errors';
import type { CardPartner, PartnerCard, PartnerCardSensitive, PartnerCustomerInput, PartnerKycStatus, PartnerTransaction } from '../types';

// The authenticated read client is operational independently of customer/card mutations.
// This explicit adapter prevents switching a live account onto simulated financial outcomes.
// Extend only after documented submit, receipt lookup and KYC upload contracts are verified.
export class UpayReadOnlyPartner implements CardPartner {
  assertWriteReady(): never { throw new AppError('provider_unavailable', 'UPay financial operations require verified request and reconciliation contracts'); }
  async createCustomer(_input: PartnerCustomerInput): Promise<string> { return this.assertWriteReady(); }
  async getKycStatus(_id: string): Promise<PartnerKycStatus> { return this.assertWriteReady(); }
  async issueCard(_input: { externalRef: string; partnerCustomerId: string }): Promise<PartnerCard> { return this.assertWriteReady(); }
  async findCardByExternalRef(_reference: string): Promise<PartnerCard | null> { return this.assertWriteReady(); }
  async rechargeCard(_input: { partnerCardId: string; amountUsd: bigint; externalRef: string }): Promise<void> { this.assertWriteReady(); }
  async isRechargeDone(_reference: string): Promise<boolean> { return this.assertWriteReady(); }
  async freezeCard(_id: string): Promise<void> { this.assertWriteReady(); }
  async unfreezeCard(_id: string): Promise<void> { this.assertWriteReady(); }
  async getCardSensitive(_id: string): Promise<PartnerCardSensitive> { return this.assertWriteReady(); }
  async listTransactions(_id: string): Promise<PartnerTransaction[]> { return this.assertWriteReady(); }
}
