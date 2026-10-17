import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { KycDto, KycRequirementsDto } from '@gudex/shared';
import type { Db } from '../db/client';
import { kycProfiles, users } from '../db/schema';
import { DbKycDocumentStore, MAX_KYC_UPLOAD_BYTES, type KycDocumentIds, type KycDocumentUpload } from '../kyc/document-store';
import { AppError } from '../lib/errors';
import { PartnerError, type CardPartner, type PartnerCustomerInput } from '../partner/types';
import { assertNewCustomerCanUseCard } from '../partner/upay/native-validation';
import { enqueue, type JobContext, type JobHandler, RetryLater } from '../queue/queue';
import { notify } from './notify';

export interface KycInput {
  firstName: string; lastName: string; email: string; birthDate: string; citizenship: string;
  phone?: string; globalCode?: string; documentType?: 'id_card' | 'passport'; documentCountry?: string; documentIds?: KycDocumentIds;
}
export interface KycOptions { live: boolean; enabled: boolean; requireSelfie: boolean; }

async function jobStillActive(context?: JobContext): Promise<boolean> {
  if (!context) return true;
  if (context.signal.aborted) return false;
  try { await context.assertActive(); return !context.signal.aborted; }
  catch { return false; }
}

export class KycService {
  constructor(
    private readonly db: Db,
    private readonly partner: CardPartner,
    private readonly pollSeconds: number,
    private readonly documents?: DbKycDocumentStore,
    private readonly options: KycOptions = { live: false, enabled: true, requireSelfie: false },
  ) {}

  async requirements(): Promise<KycRequirementsDto> {
    const remote = this.options.live && this.options.enabled ? await this.partner.getKycRequirements?.() : undefined;
    return { live: this.options.live, enabled: !this.options.live || this.options.enabled,
      documentsRequired: this.options.live, selfieRequired: this.options.live && (this.options.requireSelfie || Boolean(remote?.selfieRequired)),
      maxUploadBytes: MAX_KYC_UPLOAD_BYTES, documentTypes: remote?.documentTypes ?? ['id_card', 'passport'] };
  }

  async get(userId: string): Promise<KycDto> {
    const [row] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const belongsToProvider = row?.partnerProvider === this.provider;
    return { status: belongsToProvider ? row.status : 'none', firstName: row?.firstName ?? null, lastName: row?.lastName ?? null,
      rejectionReason: belongsToProvider ? row.rejectionReason : null,
      submissionState: belongsToProvider ? row.submissionState as KycDto['submissionState'] : 'none' };
  }

  private get provider(): 'upay' | 'mock' { return this.options.live ? 'upay' : 'mock'; }

  private assertReady(): void {
    if (this.options.live && !this.options.enabled) throw new AppError('provider_unavailable', 'UPay KYC submission is disabled');
    try { this.partner.assertKycReady?.(); }
    catch (error) { if (error instanceof PartnerError) throw new AppError('provider_unavailable', error.message); throw error; }
  }

  async uploadDocument(userId: string, input: KycDocumentUpload) {
    this.assertReady();
    if (!this.documents) throw new AppError('provider_unavailable', 'Secure document storage is unavailable');
    return this.documents.put(userId, input);
  }

  async removeDocument(userId: string, id: string): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [profile] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
      if (profile && ['pending', 'unknown'].includes(profile.status) && Object.values(profile.documentIds ?? {}).includes(id)) {
        throw new AppError('validation', 'This photo belongs to an active verification');
      }
      await this.documents?.removeOwned(userId, [id], tx);
    });
  }

  async submit(userId: string, input: KycInput): Promise<KycDto> {
    this.assertReady();
    if (this.options.live) {
      if (!input.phone || !input.globalCode || !input.documentCountry || !input.documentType || !input.documentIds?.front || !this.documents) {
        throw new AppError('validation', 'Phone and identity document photos are required');
      }
      if (input.documentType === 'id_card' && !input.documentIds.back) throw new AppError('validation', 'ID card back photo is required');
      try { assertNewCustomerCanUseCard({ firstName: input.firstName.trim(), lastName: input.lastName.trim(), email: input.email.trim(),
        kyc: { phone: input.phone, globalCode: input.globalCode } }); }
      catch (error) {
        if (error instanceof PartnerError) throw new AppError('validation', error.message);
        throw error;
      }
      if ((await this.requirements()).selfieRequired && !input.documentIds.selfie) throw new AppError('validation', 'Selfie is required for this product');
    }
    await this.db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [row] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
      const sameProvider = row?.partnerProvider === this.provider;
      if (sameProvider && row && ['pending', 'approved', 'unknown'].includes(row.status)) {
        throw new AppError('kyc_already_submitted', 'KYC is already submitted or requires reconciliation');
      }
      if (this.options.live) {
        for (const [kind, id] of Object.entries(input.documentIds!)) await this.documents!.getOwned(userId, id, kind as 'front' | 'back' | 'selfie', tx);
      }
      const submissionId = randomUUID();
      const values = {
        status: 'pending' as const, partnerProvider: this.provider, partnerCustomerId: sameProvider ? row?.partnerCustomerId ?? null : null,
        firstName: input.firstName.trim().toUpperCase(), lastName: input.lastName.trim().toUpperCase(),
        email: input.email.trim().toLowerCase(), birthDate: input.birthDate, citizenship: input.citizenship.toUpperCase(),
        phone: input.phone ?? null, globalCode: input.globalCode ?? null, documentType: input.documentType ?? null,
        documentCountry: input.documentCountry?.toUpperCase() ?? null, documentIds: input.documentIds ?? null,
        submissionId, submissionState: 'queued', documentsSubmittedAt: null, rejectionReason: null, submittedAt: new Date(), updatedAt: new Date(),
      };
      await tx.insert(kycProfiles).values({ userId, ...values }).onConflictDoUpdate({ target: kycProfiles.userId, set: values });
      await enqueue(tx, 'kyc.submit', { userId, submissionId }, { dedupeKey: `kyc.submit:${submissionId}` });
    });
    return this.get(userId);
  }

  handlers(): Record<string, JobHandler> {
    type P = { userId: string; submissionId?: string };
    return {
      'kyc.submit': { run: ({ userId, submissionId }: P, context) => this.sendToPartner(userId, submissionId, context),
        onExhausted: ({ userId, submissionId }: P) => this.markUnknown(userId, submissionId) },
      'kyc.poll': { run: ({ userId, submissionId }: P) => this.poll(userId, submissionId),
        onExhausted: ({ userId, submissionId }: P) => this.markUnknown(userId, submissionId) },
      'kyc.cleanup': { run: async () => { await this.documents?.deleteExpired(); } },
    };
  }

  // An authenticated manual refresh may only read the existing remote customer status.
  async recheck(userId: string): Promise<KycDto> {
    const [profile] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    if (profile?.status === 'unknown' && profile.partnerProvider === this.provider && this.partner.reconcileKycSubmission) {
      try {
        const receipt = await this.partner.reconcileKycSubmission(this.partnerInput(profile, userId));
        if (receipt) {
          await this.db.transaction(async tx => {
            const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
            if (current?.submissionId !== profile.submissionId || current.status !== 'unknown' || current.partnerProvider !== this.provider) return;
            await tx.update(kycProfiles).set({ ...(receipt.customerNo ? { partnerCustomerId: receipt.customerNo } : {}),
              // A recovered customer without a document submission is ready to retry, not an issuer rejection.
              ...(!receipt.submitted ? { status: 'none' as const, submissionState: 'none', rejectionReason: null } : {}),
              updatedAt: new Date() }).where(eq(kycProfiles.userId, userId));
          });
          if (!receipt.submitted) return this.get(userId);
        }
      } catch { return this.get(userId); }
    }
    try { await this.poll(userId); }
    catch (error) {
      if (error instanceof RetryLater) {
        await this.db.transaction(async tx => {
          const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
          if (!current?.submissionId || current.submissionId !== profile?.submissionId || current.partnerProvider !== this.provider ||
              !['pending', 'unknown'].includes(current.status) || current.submissionState !== 'submitted' || !current.documentsSubmittedAt) return;
          await enqueue(tx, 'kyc.poll', { userId, submissionId: current.submissionId }, {
            runAt: new Date(Date.now() + this.pollSeconds * 1000), dedupeKey: `kyc.poll:${current.submissionId}`,
          });
        });
      } else if (profile) await this.markUnknown(userId, profile.submissionId ?? undefined, undefined, profile);
    }
    return this.get(userId);
  }

  private async sendToPartner(userId: string, submissionId?: string, context?: JobContext): Promise<void> {
    const [profile] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    if (!profile || profile.status !== 'pending' || profile.partnerProvider !== this.provider || (submissionId && profile.submissionId !== submissionId)) return;
    if (profile.submissionState === 'submitted' && profile.partnerCustomerId) {
      await this.db.transaction(async tx => {
        const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
        if (current?.submissionId !== profile.submissionId || current.partnerProvider !== this.provider ||
          !['pending', 'unknown'].includes(current.status) || current.submissionState !== 'submitted') return;
        await this.documents?.removeOwned(userId, Object.values(current.documentIds ?? {}), tx);
        await enqueue(tx, 'kyc.poll', { userId, submissionId: profile.submissionId }, {
          runAt: new Date(Date.now() + this.pollSeconds * 1000), dedupeKey: `kyc.poll:${profile.submissionId}`,
        });
      });
      return;
    }
    try {
      const partnerCustomerId = await this.partner.createCustomer(this.partnerInput(profile, userId, context ? () => context.assertActive() : undefined));
      await this.db.transaction(async tx => {
        const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
        if (!current || current.submissionId !== profile.submissionId || current.partnerProvider !== this.provider || !['pending', 'unknown'].includes(current.status)) return;
        if (!await jobStillActive(context)) return;
        await tx.update(kycProfiles).set({ status: 'pending', partnerCustomerId, submissionState: 'submitted', documentsSubmittedAt: new Date(), updatedAt: new Date() }).where(eq(kycProfiles.userId, userId));
        await enqueue(tx, 'kyc.poll', { userId, submissionId: profile.submissionId }, { runAt: new Date(Date.now() + this.pollSeconds * 1000), dedupeKey: `kyc.poll:${profile.submissionId}` });
        await this.documents?.removeOwned(userId, Object.values(current.documentIds ?? {}), tx);
      });
    } catch (error) {
      if (!await jobStillActive(context)) return;
      const customerNo = error && typeof error === 'object' && 'customerNo' in error && typeof error.customerNo === 'string' ? error.customerNo : undefined;
      // A submission/preflight failure is not an issuer's decision on the documents.
      // Only polling an exact submitted-document receipt can set rejected.
      await this.markUnknown(userId, profile.submissionId ?? undefined, customerNo, undefined, context);
    }
  }

  private partnerInput(profile: typeof kycProfiles.$inferSelect, userId: string, beforeSubmit?: () => Promise<void>): PartnerCustomerInput {
    return { externalRef: userId, beforeSubmit, email: profile.email!, firstName: profile.firstName!, lastName: profile.lastName!,
      birthDate: profile.birthDate!, citizenship: profile.citizenship!,
      ...(this.options.live ? { kyc: { submissionId: profile.submissionId!, customerNo: profile.partnerCustomerId ?? undefined,
        phone: profile.phone!, globalCode: profile.globalCode!, documentType: profile.documentType as 'id_card' | 'passport',
        documentCountry: profile.documentCountry!, documentIds: profile.documentIds! } } : {}) };
  }

  private async poll(userId: string, submissionId?: string): Promise<void> {
    const [profile] = await this.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    if (!profile || !['pending', 'unknown'].includes(profile.status) || profile.partnerProvider !== this.provider ||
      (submissionId && profile.submissionId !== submissionId) || !profile.partnerCustomerId) return;
    if (profile.status === 'pending' && profile.submissionState === 'queued') return;
    const result = await this.partner.getKycStatus(profile.partnerCustomerId);
    if (result.status === 'pending') {
      if (profile.status === 'unknown') {
        await this.db.transaction(async tx => {
          const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
          if (current?.submissionId === profile.submissionId && current.partnerProvider === this.provider && current.status === 'unknown') {
            await tx.update(kycProfiles).set({ status: 'pending', submissionState: 'submitted', documentsSubmittedAt: new Date(), updatedAt: new Date() }).where(eq(kycProfiles.userId, userId));
            await this.documents?.removeOwned(userId, Object.values(current.documentIds ?? {}), tx);
          }
        });
      }
      throw new RetryLater(this.pollSeconds);
    }
    await this.db.transaction(async tx => {
      const [current] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
      if (!current || current.submissionId !== profile.submissionId || current.partnerProvider !== this.provider || !['pending', 'unknown'].includes(current.status)) return;
      await tx.update(kycProfiles).set({ status: result.status, submissionState: 'submitted',
        rejectionReason: result.status === 'rejected' ? result.reason : null, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(kycProfiles.userId, userId));
      await notify(tx, userId, { type: result.status === 'approved' ? 'kyc_approved' : 'kyc_rejected' });
      await this.documents?.removeOwned(userId, Object.values(current.documentIds ?? {}), tx);
    });
  }

  private async markUnknown(userId: string, submissionId?: string, customerNo?: string,
    expected?: Pick<typeof kycProfiles.$inferSelect, 'status' | 'submissionState' | 'updatedAt' | 'partnerCustomerId'>, context?: JobContext): Promise<void> {
    await this.db.transaction(async tx => {
      const [profile] = await tx.select().from(kycProfiles).where(eq(kycProfiles.userId, userId)).for('update');
      if (!profile || profile.partnerProvider !== this.provider || !['pending', 'unknown'].includes(profile.status) || (submissionId && profile.submissionId !== submissionId)) return;
      if (expected && (profile.status !== expected.status || profile.submissionState !== expected.submissionState ||
          profile.partnerCustomerId !== expected.partnerCustomerId || profile.updatedAt.getTime() !== expected.updatedAt.getTime())) return;
      if (!await jobStillActive(context)) return;
      await tx.update(kycProfiles).set({ status: 'unknown', submissionState: 'unknown', ...(customerNo ? { partnerCustomerId: customerNo } : {}), updatedAt: new Date() }).where(eq(kycProfiles.userId, userId));
    });
  }

}
