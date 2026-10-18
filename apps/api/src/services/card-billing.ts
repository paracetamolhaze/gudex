import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { CardBillingAddressDto, CardBillingAddressInput, CardBillingCountryDto } from '@gudex/shared';
import type { Config } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { cardBillingAddresses, kycProfiles, users } from '../db/schema';
import { AppError, parse } from '../lib/errors';
import type { UpayClient } from '../partner/upay/client';
import { UpayError } from '../partner/upay/transport';
import { assertBillingCallingCodeAllowed } from '../partner/upay/issuance-restrictions';
import { BILLING_COUNTRIES } from '../lib/countries';

type BillingApi = Pick<UpayClient, 'configured' | 'readRequest' | 'submitRequest'>;
type Profile = typeof kycProfiles.$inferSelect;
type AddressRow = typeof cardBillingAddresses.$inferSelect;
interface SavedAddress { input: CardBillingAddressInput; owner: { userId: string; customerNo: string; submissionId: string;
  name: string; phone: string; email: string; intlDialCode: string }; }
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identifier = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
export const cardBillingInputSchema = z.object({
  countryId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  postalCode: z.string().trim().min(4).max(10).regex(/^[a-zA-Z0-9 .-]+$/),
  address: z.string().trim().min(1).max(200).regex(/^[\x20-\x7e]+$/),
}).strict();

// Creating a book entry is an explicit user action. A committed send claim
// precedes the one POST; every subsequent request only verifies its marker.
export class CardBillingService {
  private readonly key: Buffer;
  constructor(private readonly db: Db, private readonly config: Config, private readonly client?: BillingApi) {
    this.key = createHmac('sha256', config.appSecret).update('gudex:card-billing:v1').digest();
  }
  private get live(): boolean { return this.config.CARD_PARTNER === 'upay'; }
  private api(): BillingApi {
    if (!this.live || !this.client?.configured) throw new AppError('provider_unavailable', 'Card billing is not connected');
    return this.client;
  }
  private async read<T>(endpoint: string, query: Record<string, string | number>): Promise<T> {
    try { return await this.api().readRequest<T>('GET', endpoint, { query }); }
    catch { throw new AppError('provider_unavailable', 'UPay billing lookup is temporarily unavailable'); }
  }
  private async profile(userId: string, db: DbOrTx = this.db, lock = false): Promise<Profile | null> {
    if (lock) {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw new AppError('unauthorized', 'User not found');
    }
    const query = db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    const [profile] = await (lock ? query.for('update') : query);
    return profile?.partnerProvider === 'upay' && profile.status === 'approved' && profile.partnerCustomerId && profile.submissionId ? profile : null;
  }
  private owner(profile: Profile): SavedAddress['owner'] {
    const name = `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim();
    if (!profile.partnerCustomerId || !profile.submissionId || !name || name.length > 120 || !/^[a-zA-Z0-9\s.-]+$/.test(name)
      || !/^\d{5,13}$/.test(profile.phone ?? '') || !/^\+\d{1,4}$/.test(profile.globalCode ?? '')
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email ?? '')) {
      throw new AppError('validation', 'Approved verification contact details are incomplete for billing');
    }
    return { userId: profile.userId, customerNo: profile.partnerCustomerId, submissionId: profile.submissionId,
      name, phone: profile.phone!, email: profile.email!, intlDialCode: profile.globalCode! };
  }
  private hash(saved: SavedAddress): string { return createHmac('sha256', this.key).update(JSON.stringify(saved)).digest('hex'); }
  private seal(userId: string, customerNo: string, marker: string, saved: SavedAddress) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${userId}:${customerNo}:${marker}`));
    return { ciphertext: Buffer.concat([cipher.update(JSON.stringify(saved), 'utf8'), cipher.final()]).toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  private open(row: AddressRow): SavedAddress {
    try {
      if (!/^GDXB[a-f0-9]{16}$/.test(row.marker)) throw new Error('marker');
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
      cipher.setAAD(Buffer.from(`${row.userId}:${row.customerNo}:${row.marker}`));
      cipher.setAuthTag(Buffer.from(row.tag, 'base64'));
      const saved = JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.ciphertext, 'base64')), cipher.final()]).toString('utf8')) as SavedAddress;
      if (saved.owner.userId !== row.userId || saved.owner.customerNo !== row.customerNo || this.hash(saved) !== row.requestHash) throw new Error('binding');
      return saved;
    } catch { throw new AppError('provider_unavailable', 'Saved billing address cannot be verified'); }
  }
  private matches(profile: Profile, row: AddressRow): boolean {
    try { return row.userId === profile.userId && row.customerNo === profile.partnerCustomerId
      && JSON.stringify(this.open(row).owner) === JSON.stringify(this.owner(profile)); }
    catch { return false; }
  }
  private async required(profile: Profile): Promise<boolean> {
    const form = object(await this.read('/card/getCardFee', {
      customerNo: profile.partnerCustomerId!, agentCardId: this.config.UPAY_PRODUCT_ID,
    }));
    if (!form || form.customerNo !== undefined && String(form.customerNo) !== profile.partnerCustomerId) throw new AppError('provider_unavailable', 'Card billing requirements cannot be verified');
    if (form.requiredInfo !== true && form.requiredInfo !== false) throw new AppError('provider_unavailable', 'Card billing requirements cannot be verified');
    if (form.requiredInfo && (typeof form.addressType !== 'string' || !/^(?:[123](?:,[123])*)?$/.test(form.addressType))) {
      throw new AppError('provider_unavailable', 'Card billing address type is unsupported');
    }
    return form.requiredInfo && typeof form.addressType === 'string' && form.addressType.split(',').filter(Boolean).length > 0;
  }
  async countries(_userId: string): Promise<CardBillingCountryDto[]> {
    // Manual issuance never reads the provider's catalog: the operator types the address in UPay.
    if (this.config.CARD_ISSUANCE_MODE === 'manual') return BILLING_COUNTRIES;
    if (!this.live) return [];
    const value = await this.read<unknown>('/common/countryAndRegion', { level: 2, callingCodeOptions: 'true' });
    if (!Array.isArray(value) || !value.length || value.length > 1000) throw new AppError('provider_unavailable', 'Billing countries are unavailable');
    const result: CardBillingCountryDto[] = [];
    for (const item of value) {
      const row = object(item), id = identifier(row?.id), name = row?.name_en ?? row?.name;
      if (!id || typeof name !== 'string' || !name.trim() || name.length > 200 || result.some(country => country.id === id)) {
        throw new AppError('provider_unavailable', 'Billing countries cannot be verified');
      }
      const code = row?.codeAlpha2 ?? row?.alpha2 ?? row?.code;
      result.push({ id, name, code: typeof code === 'string' && /^[A-Z]{2,3}$/i.test(code) ? code.toUpperCase() : null });
    }
    return result;
  }
  // A card application must use a country from the live product list; demo mode has no list.
  async applicationCountryName(userId: string, countryId: string): Promise<string | null> {
    const list = await this.countries(userId);
    if (!list.length) return null;
    const country = list.find(item => item.id === countryId);
    if (!country) throw new AppError('validation', 'Select a supported billing country');
    return country.name;
  }

  async get(userId: string): Promise<CardBillingAddressDto> {
    if (!this.live) return { required: false, status: 'missing', address: null };
    const profile = await this.profile(userId);
    if (!profile) return { required: true, status: 'missing', address: null };
    const required = this.config.CARD_ISSUANCE_MODE === 'manual' ? true : await this.required(profile);
    const [row] = await this.db.select().from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, userId));
    if (!row) return { required, status: 'missing', address: null };
    if (!this.matches(profile, row)) return { required, status: 'pending', address: null };
    if (this.config.CARD_ISSUANCE_MODE === 'manual' && ['prepared', 'ready'].includes(row.status)) {
      return { required, status: 'ready', address: this.open(row).input };
    }
    if (row.status === 'rejected') return { required, status: 'missing', address: this.open(row).input };
    const ready = await this.resolve(row);
    return { required, status: ready ? 'ready' : 'pending', address: this.open(row).input };
  }
  async save(userId: string, value: CardBillingAddressInput): Promise<CardBillingAddressDto> {
    const api = this.api();
    const manual = this.config.CARD_ISSUANCE_MODE === 'manual';
    if (!manual && !this.config.UPAY_KYC_ENABLED) throw new AppError('provider_unavailable', 'UPay billing writes are not enabled');
    const input = parse(cardBillingInputSchema, value);
    if (!(await this.countries(userId)).some(country => country.id === input.countryId)) throw new AppError('validation', 'Select a supported billing country');
    const row = await this.db.transaction(async tx => {
      const profile = await this.profile(userId, tx, true);
      if (!profile) throw new AppError('kyc_required', 'Approved live verification is required for billing');
      const saved: SavedAddress = { input, owner: this.owner(profile) };
      const [existing] = await tx.select().from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, userId)).for('update');
      if (existing) {
        // A later explicit edit creates a fresh private book entry; it never
        // edits or deletes the previously verified provider address.
        if (existing.customerNo === saved.owner.customerNo && (existing.status === 'rejected'
          || (existing.status === 'ready' || manual && existing.status === 'prepared') && existing.requestHash !== this.hash(saved))) {
          const marker = `GDXB${randomBytes(8).toString('hex')}`;
          const [replacement] = await tx.update(cardBillingAddresses).set({ customerNo: saved.owner.customerNo, marker,
            requestHash: this.hash(saved), ...this.seal(userId, saved.owner.customerNo, marker, saved), status: 'prepared', partnerAddressId: null, updatedAt: new Date() })
            .where(eq(cardBillingAddresses.userId, userId)).returning();
          return replacement!;
        }
        if (existing.requestHash !== this.hash(saved) || !this.matches(profile, existing)) {
          throw new AppError('validation', 'This billing address is awaiting verification; check its status before changing it');
        }
        return existing;
      }
      const marker = `GDXB${randomBytes(8).toString('hex')}`;
      const [created] = await tx.insert(cardBillingAddresses).values({ userId, customerNo: saved.owner.customerNo, marker,
        requestHash: this.hash(saved), ...this.seal(userId, saved.owner.customerNo, marker, saved) }).returning();
      return created!;
    });
    if (manual) {
      if (!['prepared', 'ready'].includes(row.status)) throw new AppError('validation', 'An earlier billing submission requires reconciliation');
      return { required: true, status: 'ready', address: input };
    }
    if (await this.resolve(row)) return { required: await this.requiredForUser(userId), status: 'ready', address: input };
    const claimed = await this.db.transaction(async tx => {
      const profile = await this.profile(userId, tx, true);
      const [current] = await tx.select().from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, userId)).for('update');
      if (!profile || !current || current.requestHash !== row.requestHash || current.marker !== row.marker || !this.matches(profile, current)) throw new AppError('kyc_required');
      if (current.status !== 'prepared') return false;
      await tx.update(cardBillingAddresses).set({ status: 'sending', updatedAt: new Date() }).where(eq(cardBillingAddresses.userId, userId));
      return true;
    });
    if (claimed) {
      const saved = this.open(row);
      try {
        await api.submitRequest('/address/edit', { id: '', type: 'ADD', isDefault: false, tag: row.marker,
          name: saved.owner.name, phone: saved.owner.phone, email: saved.owner.email, intlDialCode: saved.owner.intlDialCode, ...input },
        { beforeDispatch: async () => {
          await this.db.transaction(async tx => {
            const profile = await this.profile(userId, tx, true);
            const [current] = await tx.select().from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, userId)).for('update');
            if (!profile || !current || current.status !== 'sending' || current.requestHash !== row.requestHash || current.marker !== row.marker || !this.matches(profile, current)) {
              throw new AppError('validation', 'Billing ownership changed before submission');
            }
          });
        } });
        await this.mark(row, 'acknowledged');
      } catch (error) {
        // Only explicit before-send proof permits another user-triggered attempt.
        await this.mark(row, error instanceof UpayError && error.metadata?.phase === 'pre_dispatch' ? 'prepared'
          : error instanceof UpayError && error.metadata?.ack === 'rejected_envelope' ? 'rejected' : 'unknown');
      }
    }
    const ready = await this.resolve(row);
    const [current] = await this.db.select().from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, userId));
    return { required: await this.requiredForUser(userId), status: ready ? 'ready' : current?.status === 'rejected' ? 'missing' : 'pending', address: input };
  }
  private async requiredForUser(userId: string): Promise<boolean> {
    const profile = await this.profile(userId);
    return profile ? this.required(profile) : true;
  }
  private async mark(row: AddressRow, status: 'prepared' | 'acknowledged' | 'unknown' | 'rejected'): Promise<void> {
    await this.db.update(cardBillingAddresses).set({ status, updatedAt: new Date() }).where(and(
      eq(cardBillingAddresses.userId, row.userId), eq(cardBillingAddresses.requestHash, row.requestHash), eq(cardBillingAddresses.marker, row.marker), eq(cardBillingAddresses.status, 'sending')));
  }
  private async resolve(row: AddressRow, strict = false, restrictionPolicy?: unknown): Promise<string | null> {
    // Reads only; an absent marker after a send is never permission to POST again.
    const profile = await this.profile(row.userId);
    if (!profile || !this.matches(profile, row)) return null;
    let verifiedId: string | null = null;
    try {
      const value = await this.read<unknown>('/address/getSelectList', { customerNo: row.customerNo });
      if (!Array.isArray(value) || value.length > 1000) return null;
      const candidates = value.map(object).filter(candidate => candidate?.tag === row.marker);
      if (candidates.length !== 1) return null;
      const id = identifier(candidates[0]?.id);
      if (!id || row.partnerAddressId && row.partnerAddressId !== id) return null;
      const detail = object(await this.read('/address/info', { id }));
      const saved = this.open(row);
      if (!detail || identifier(detail.id) !== id || detail.tag !== row.marker || detail.isDefault !== false
        || identifier(detail.countryId) !== saved.input.countryId || detail.postalCode !== saved.input.postalCode || detail.address !== saved.input.address
        || detail.name !== saved.owner.name || detail.phone !== saved.owner.phone || detail.email !== saved.owner.email || detail.intlDialCode !== saved.owner.intlDialCode) return null;
      verifiedId = id;
    } catch {
      if (strict) throw new AppError('provider_unavailable', 'Saved billing address cannot currently be checked with UPay');
      return null;
    }
    return this.db.transaction(async tx => {
      const currentProfile = await this.profile(row.userId, tx, true);
      const [current] = await tx.select().from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, row.userId)).for('update');
      if (!currentProfile || !current || current.requestHash !== row.requestHash || current.marker !== row.marker || current.status === 'rejected' || !this.matches(currentProfile, current)
        || current.partnerAddressId && current.partnerAddressId !== verifiedId) return null;
      // Check the resolved OWN snapshot after both provider readback and the
      // current user/profile/address locks. The shared address catalog and form
      // contact fields cannot stand in for this verified saved billing contact.
      assertBillingCallingCodeAllowed(this.open(current).owner.intlDialCode, restrictionPolicy);
      await tx.update(cardBillingAddresses).set({ status: 'ready', partnerAddressId: verifiedId, updatedAt: new Date() })
        .where(eq(cardBillingAddresses.userId, row.userId));
      return verifiedId;
    });
  }
  async getVerifiedAddressId(customerNo: string, restrictionPolicy?: unknown): Promise<string | null> {
    if (!this.live || !this.client?.configured) return null;
    const profiles = await this.db.select().from(kycProfiles).where(eq(kycProfiles.partnerCustomerId, customerNo));
    if (profiles.length !== 1 || profiles[0]!.partnerProvider !== 'upay' || profiles[0]!.status !== 'approved') return null;
    const [row] = await this.db.select().from(cardBillingAddresses).where(and(eq(cardBillingAddresses.userId, profiles[0]!.userId), eq(cardBillingAddresses.customerNo, customerNo)));
    return row ? this.resolve(row, true, restrictionPolicy) : null;
  }

  // The admin reviews only the address explicitly supplied by this customer;
  // no remote shared address-book lookup or write is needed for manual issuance.
  async getSavedForAdmin(userId: string): Promise<CardBillingAddressInput | null> {
    const profile = await this.profile(userId);
    const [row] = await this.db.select().from(cardBillingAddresses).where(eq(cardBillingAddresses.userId, userId));
    return profile && row && ['prepared', 'ready'].includes(row.status) && this.matches(profile, row) ? this.open(row).input : null;
  }
}
