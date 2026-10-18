import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fromMinor, type CardApplicationDto, type CardBillingAddressInput, type WalletAsset } from '@gudex/shared';
import type { Config } from '../config';
import type { Db, Tx } from '../db/client';
import { kycProfiles, users } from '../db/schema';
import { AppError, isUniqueViolation } from '../lib/errors';
import { notifyAdmins } from './admin-notify';
import type { CardBillingService } from './card-billing';
import type { CardService } from './cards';
import type { KycInput, KycService } from './kyc';
import { notify } from './notify';

// An operator creates the customer and the card by hand, so submitted photos stay available for a week.
export const APPLICATION_DOCUMENT_TTL_SECONDS = 7 * 86400;

export interface CardApplication {
  kyc: KycInput;
  billing: CardBillingAddressInput;
  asset: WalletAsset;
  idempotencyKey: string;
  expectedFundingSource?: 'wallet' | 'broker';
  expectedCustomerCharge?: string;
}

/** Manual issuance: the client submits identity, documents and billing address once. If the balance
 * already covers the fee it is reserved at once; otherwise the application waits for the payment to
 * the app wallet and moves on by itself when it arrives. No partner request is made here. */
export class CardApplicationService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly kyc: KycService,
    private readonly cards: CardService,
    private readonly billing: CardBillingService,
  ) {}

  async submit(userId: string, input: CardApplication): Promise<CardApplicationDto> {
    if (this.config.CARD_ISSUANCE_MODE !== 'manual') throw new AppError('validation', 'Card applications are available only with manual issuance');
    const replay = await this.cards.findIssueOperation(userId, input.idempotencyKey);
    if (replay) return this.result(userId, replay.id, replay.cardId);
    await this.kyc.validateSubmission(input.kyc);
    const countryName = await this.billing.applicationCountryName(userId, input.billing.countryId);
    try {
      const op = await this.db.transaction(async tx => {
        const submissionId = await this.kyc.saveSubmission(tx, userId, input.kyc, {
          countryId: input.billing.countryId, countryName, postalCode: input.billing.postalCode.trim(), address: input.billing.address.trim(),
        });
        await this.kyc.retainDocuments(tx, userId, input.kyc.documentIds, APPLICATION_DOCUMENT_TTL_SECONDS);
        if (!await this.cards.canReserveManualApplication(tx, userId, input.asset)) return null;
        return this.reserve(tx, userId, submissionId, input, 'application_received');
      });
      return op ? this.result(userId, op.id, op.cardId) : { kyc: await this.kyc.get(userId), card: null, operation: null };
    } catch (error) {
      // A lost response or a double tap with the same key resolves to the committed application.
      if (isUniqueViolation(error) || error instanceof AppError && error.code === 'kyc_already_submitted') {
        const committed = await this.cards.findIssueOperation(userId, input.idempotencyKey);
        if (committed) return this.result(userId, committed.id, committed.cardId);
      }
      throw error;
    }
  }

  /** After a payment was credited, the card request moves on by itself once the fee is covered: a saved application
   * under review, or a client whose questionnaire is already approved and whose billing address is on file. */
  async afterFeeCredited(tx: Tx, input: { userId: string; asset: WalletAsset; leaseId: string | null }): Promise<boolean> {
    // The user row is locked first, as everywhere else, so two paths never wait on each other.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for('update');
    const [profile] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, input.userId)).for('update');
    if (!profile || !profile.submissionId || !profile.firstName || !profile.lastName) return false;
    // The operator needs the address to issue the card, so no fee is taken for a questionnaire without one.
    const hasAddress = profile.billingAddress !== null || await this.billing.getSavedForAdmin(input.userId) !== null;
    const reviewing = profile.status === 'pending' && profile.submissionState === 'manual_review' && hasAddress;
    const approved = profile.status === 'approved' && hasAddress;
    if (!reviewing && !approved) return false;
    if (!await this.cards.canReserveManualApplication(tx, input.userId, input.asset)) return false;
    await this.reserve(tx, input.userId, profile.submissionId, { asset: input.asset, idempotencyKey: `fee-payment:${input.leaseId ?? randomUUID()}`,
      kyc: { firstName: profile.firstName, lastName: profile.lastName } as KycInput }, 'application_paid', reviewing ? undefined : 'issuance');
    return true;
  }

  /** The fee is already on the client's balance (a refund after a declined application, or a payment confirmed late):
   * the saved application takes it from there instead of asking for a new transfer. */
  async payFromBalance(userId: string, asset: WalletAsset): Promise<CardApplicationDto> {
    if (this.config.CARD_ISSUANCE_MODE !== 'manual') throw new AppError('validation', 'Card applications are available only with manual issuance');
    const moved = await this.db.transaction(tx => this.afterFeeCredited(tx, { userId, asset, leaseId: null }));
    if (!moved) throw new AppError('insufficient_funds', 'The balance does not cover the card fee or there is nothing to pay for');
    const [operation] = await this.cards.openIssueOperation(userId);
    return operation ? this.result(userId, operation.id, operation.cardId) : { kyc: await this.kyc.get(userId), card: null, operation: null };
  }

  // An approved client may request a card again later, so its admin notice is keyed by the new issuance, not the questionnaire.
  private async reserve(tx: Tx, userId: string, submissionId: string, input: Pick<CardApplication, 'asset' | 'idempotencyKey' | 'expectedFundingSource' | 'expectedCustomerCharge'> & { kyc: Pick<KycInput, 'firstName' | 'lastName'> },
    message: 'application_received' | 'application_paid', noticeKey: 'application' | 'issuance' = 'application') {
    const holderName = `${input.kyc.firstName.trim()} ${input.kyc.lastName.trim()}`.toUpperCase();
    const reserved = await this.cards.reserveManualApplication(tx, userId, {
      asset: input.asset, idempotencyKey: input.idempotencyKey,
      ...(input.expectedFundingSource ? { expectedFundingSource: input.expectedFundingSource } : {}),
      ...(input.expectedCustomerCharge !== undefined ? { expectedCustomerCharge: input.expectedCustomerCharge } : {}),
    }, holderName);
    await notifyAdmins(tx, this.config, { userId, eventKey: noticeKey === 'application' ? `application:${submissionId}` : `issuance:${reserved.id}`, stage: 'issuance' });
    const sponsored = Boolean(reserved.sponsorshipId);
    const amount = sponsored ? '0' : fromMinor(reserved.amount!, input.asset);
    await notify(tx, userId, message === 'application_paid' ? { type: 'application_paid', amount, asset: input.asset }
      : { type: 'application_received', asset: input.asset, sponsored, amount });
    return reserved;
  }

  private async result(userId: string, operationId: string, cardId: string): Promise<CardApplicationDto> {
    return { kyc: await this.kyc.get(userId), card: await this.cards.get(userId, cardId), operation: await this.cards.getOperation(userId, operationId) };
  }
}
