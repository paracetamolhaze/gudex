import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Config } from '../../config';
import { totp } from './totp';
import type { SessionAccess, UpayAuthAttempt, UpaySessionStore } from './session-store';
import { UpayError, UpayTransport } from './transport';
import { encryptPaymentPin } from './financial-protocol';

export interface UpayPage<T> { pageNo: number; pageSize: number; totalSize: number; totalPages: number; list: T[]; }
export interface UpayMerchant { merchantNo?: string; companyName?: string; }
export interface UpayLoginInfo { id: string; iv?: string; pinCodeSet?: boolean; }
export interface UpayReadCheck { ok: boolean; code?: number; total?: number; }

// Manual issuance: GUDEX staff do everything in the panel by hand. The bot only reads a
// customer's card list (balance, state) and card operations (purchases), and freezes or
// unfreezes a card on the client's request (the payment PIN needs the login metadata).
export const CARD_INFO_READS = new Set(['GET /card/list', 'POST /card/getPageToTransaction', 'GET /sys/member/loginInfo', 'POST /card/thawFrozen']);
const READS = new Set([
  'GET /sys/member/loginInfo', 'GET /agent/info', 'GET /customer/list', 'GET /customer/get',
  'GET /agentOperateLog/getPage',
  'GET /sys/permission/homeMenu', 'GET /sys/permission/list', 'GET /sys/role/permissions/list',
  'POST /sys/member/list', 'POST /sys/role/list',
  'GET /customer/group/list', 'GET /customer/group/all', 'GET /customer/kyc/status/select',
  'GET /card/rate/list', 'GET /card/rate/list/all', 'GET /card/rate/info', 'GET /card/choose', 'GET /bill/list', 'GET /bill/info',
  'GET /quick/deposit/check', 'GET /quick/deposit/info',
  'GET /common/countryAndRegion', 'GET /kyc/info', 'GET /address/info', 'GET /address/getSelectList',
  'GET /asset/coin/list', 'GET /asset/list', 'GET /wallet/address/list', 'GET /wallet/deposit/list',
  'GET /wallet/asset/list', 'GET /wallet/asset/info',
  'POST /deposit/aml/page', 'POST /deposit/aml/stats',
  'GET /wallet/deposit/depositType/list', 'GET /wallet/deposit/state/list', 'GET /wallet/deposit/riskCoinStatus/list',
  'GET /coin/chain/coinSel', 'GET /coin/chain/chainSel',
  'GET /card/list', 'GET /card/getPageToMayApplyCard', 'GET /card/getMayApplyCardDetail', 'GET /card/getCardFee',
  'GET /card/getRechargeCardInfo', 'GET /card/getCountry', 'GET /card/get/kycStatus', 'GET /card/get/kyc',
  'GET /card/getAgentCustomerCardDetail', 'GET /card/state/list', 'GET /card/getCardOperateStatus',
  'POST /card/getCardBalanceTotal', 'POST /card/getPageToCardOperateRecord', 'POST /card/getPageToTransaction',
  'POST /card/getCardDetailDecrypt', 'POST /card/getBrokerCardDetailDecrypt',
]);
const KYC_WRITES = new Set(['/customer/add', '/card/submit/kyc', '/kyc/submit', '/file/upload']);
const FINANCIAL_WRITES = new Set(['/card/applyOpenCard', '/card/recharge', '/card/thawFrozen']);
const BILLING_WRITES = new Set(['/address/edit']);
export const UPAY_LOGIN_MIN_INTERVAL_MS = 300_000;
type AuthDecision = { kind: 'session'; token: string } | { kind: 'claim'; attempt: UpayAuthAttempt & { attemptId: string } } |
  { kind: 'wait'; attemptId: string } | { kind: 'cooldown' };

// Only methods backed by the actual panel's read request contracts are exposed here.
// Financial POSTs are deliberately a separate integration seam, never automatically replayed by this client.
export class UpayClient {
  private readonly transport: UpayTransport;
  private readonly fingerprint: string;
  private authFlight: Promise<string> | undefined;
  // Compatibility for non-durable test/custom stores. Production DbUpaySessionStore
  // always implements both methods and persists this state across instances.
  private legacyAttempt: UpayAuthAttempt | null = null;
  constructor(private readonly config: Config, private readonly store: UpaySessionStore, transport?: UpayTransport) {
    this.transport = transport ?? new UpayTransport({ baseUrl: config.UPAY_BASE_URL, deviceId: config.UPAY_DEVICE_ID, timeoutMs: config.UPAY_TIMEOUT_MS });
    this.fingerprint = createHmac('sha256', config.appSecret).update(JSON.stringify([
      config.UPAY_LOGIN, config.UPAY_PASSWORD, config.UPAY_TOTP_SECRET, config.UPAY_DEVICE_ID,
    ])).digest('hex');
  }

  get configured(): boolean { return Boolean(this.config.UPAY_LOGIN && this.config.UPAY_PASSWORD && this.config.UPAY_TOTP_SECRET); }

  get cardInfoOnly(): boolean { return this.config.CARD_ISSUANCE_MODE === 'manual'; }

  private assertCardInfo(request: string): void {
    if (this.cardInfoOnly && !CARD_INFO_READS.has(request)) {
      throw new UpayError('GUDEX lets the UPay bot read only card balances and card operations', false, undefined, { phase: 'pre_dispatch', ack: 'unconfirmed' });
    }
  }

  private async authenticate(rejectedToken?: string): Promise<string> {
    if (!this.configured) throw new UpayError('UPay credentials are not configured', false);
    for (;;) {
      const running = this.authFlight;
      if (running) {
        const token = await running;
        if (token !== rejectedToken) return token;
        if (this.authFlight === running) this.authFlight = undefined;
        continue;
      }
      const flight = this.authenticateOnce(rejectedToken);
      this.authFlight = flight;
      try { return await flight; }
      finally { if (this.authFlight === flight) this.authFlight = undefined; }
    }
  }

  private getAttempt(access: SessionAccess): Promise<UpayAuthAttempt | null> {
    return access.getAuthAttempt && access.setAuthAttempt ? access.getAuthAttempt() : Promise.resolve(this.legacyAttempt);
  }

  private async setAttempt(access: SessionAccess, attempt: UpayAuthAttempt): Promise<void> {
    if (access.getAuthAttempt && access.setAuthAttempt) await access.setAuthAttempt(attempt);
    else this.legacyAttempt = attempt;
  }

  private cooldown(): UpayError { return new UpayError('UPay authentication is cooling down; retry later', true); }

  private async authenticateOnce(rejectedToken?: string): Promise<string> {
    try {
      // Phase 1 commits the claim before any HTTP. Never keep a database transaction
      // open while logging in; even a killed invocation leaves the global cooldown.
      const decision = await this.store.withLock<AuthDecision>(async access => {
        const current = await access.get();
        if (current && typeof current.token === 'string' && current.token && current.fingerprint === this.fingerprint &&
            current.expiresAt > Date.now() && current.token !== rejectedToken) return { kind: 'session', token: current.token };
        // A delayed rejection may invalidate only the exact token that was rejected,
        // never a replacement session committed by another instance.
        if (rejectedToken && current?.token === rejectedToken) await access.set(null);
        const attempt = await this.getAttempt(access);
        if (attempt && attempt.retryAfter > Date.now()) {
          return attempt.state === 'started' && attempt.attemptId && attempt.fingerprint === this.fingerprint
            ? { kind: 'wait', attemptId: attempt.attemptId } : { kind: 'cooldown' };
        }
        const claim = { fingerprint: this.fingerprint, retryAfter: Date.now() + UPAY_LOGIN_MIN_INTERVAL_MS,
          attemptId: randomUUID(), state: 'started' as const };
        await this.setAttempt(access, claim);
        return { kind: 'claim', attempt: claim };
      });
      if (decision.kind === 'session') return decision.token;
      if (decision.kind === 'cooldown') throw this.cooldown();
      if (decision.kind === 'wait') return await this.waitForSession(decision.attemptId, rejectedToken);

      const claim = decision.attempt;
      try {
        // Phase 2 has no database lock and authenticates only once for this claim.
        const login = await this.transport.request<{ token: string; initPasswordType?: number; googleState?: number }>('POST', '/sys/member/login', {
          body: { email: this.config.UPAY_LOGIN, password: createHash('md5').update(`${this.config.UPAY_PASSWORD}broker-manage`).digest('hex') },
        });
        if (!login?.token || typeof login.token !== 'string') throw new UpayError('UPay login returned no session', false);
        if (login.initPasswordType === 1) throw new UpayError('Initialize the bot account password in UPay before using automation', false);
        if (login.googleState !== 1) throw new UpayError('Enable Google 2FA on the bot account in UPay before using automation', false);
        let googleCode: string;
        try { googleCode = totp(this.config.UPAY_TOTP_SECRET!); }
        catch { throw new UpayError('UPAY_TOTP_SECRET has an unsupported format', false); }
        await this.transport.request('POST', '/sys/member/validateGoogle', { token: login.token, body: { googleCode } });
        await this.transport.request<UpayLoginInfo>('GET', '/sys/member/loginInfo', { token: login.token });
        // Phase 3 accepts only the still-current claim. An old delayed login must
        // not overwrite a newer session after cooldown expiry or key rotation.
        const stored = await this.store.withLock(async access => {
          const active = await this.getAttempt(access);
          if (active?.attemptId !== claim.attemptId || active.fingerprint !== claim.fingerprint || active.state !== 'started') return false;
          await access.set({ token: login.token, expiresAt: Date.now() + this.config.UPAY_SESSION_TTL_SECONDS * 1000, fingerprint: this.fingerprint });
          await this.setAttempt(access, { ...claim, state: 'succeeded' });
          return true;
        });
        if (!stored) throw new UpayError('UPay authentication attempt was superseded', true);
        return login.token;
      } catch (error) {
        // Failure recording is also fenced; it never rolls back the committed claim.
        await this.store.withLock(async access => {
          const active = await this.getAttempt(access);
          if (active?.attemptId === claim.attemptId && active.state === 'started') await this.setAttempt(access, { ...claim, state: 'failed' });
        }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof UpayError) throw error;
      throw new UpayError('UPay authentication is temporarily unavailable', true);
    }
  }

  private async waitForSession(attemptId: string, rejectedToken?: string): Promise<string> {
    // Other serverless instances can reuse the winning session without issuing
    // another login. Monotonic time keeps the wait bounded if wall time changes.
    const deadline = performance.now() + Math.min(25_000, this.config.UPAY_TIMEOUT_MS * 3 + 1_000);
    let pause = 25;
    while (performance.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, pause));
      pause = Math.min(1_000, pause * 2);
      const result = await this.store.withLock(async access => {
        const current = await access.get();
        if (current && typeof current.token === 'string' && current.token && current.fingerprint === this.fingerprint &&
            current.expiresAt > Date.now() && current.token !== rejectedToken) return { token: current.token };
        const active = await this.getAttempt(access);
        return { waiting: active?.attemptId === attemptId && active.state === 'started' && active.retryAfter > Date.now() };
      });
      if ('token' in result && result.token) return result.token;
      if (!result.waiting) throw this.cooldown();
    }
    throw this.cooldown();
  }

  async readRequest<T>(method: 'GET' | 'POST', endpoint: string, options: { query?: Record<string, string | number>; body?: object } = {}): Promise<T> {
    if (!READS.has(`${method} ${endpoint}`)) throw new UpayError('This UPay endpoint is not an approved read', false);
    this.assertCardInfo(`${method} ${endpoint}`);
    const token = await this.authenticate();
    try { return await this.transport.request<T>(method, endpoint, { ...options, token }); }
    catch (err) {
      if (!(err instanceof UpayError) || !err.sessionExpired) throw err;
      const renewed = await this.authenticate(token);
      return this.transport.request<T>(method, endpoint, { ...options, token: renewed });
    }
  }

  async submitRequest<T>(endpoint: string, body: object, options: { beforeDispatch?: () => Promise<void> } = {}): Promise<T> {
    this.assertCardInfo(`POST ${endpoint}`);
    if (BILLING_WRITES.has(endpoint)) {
      const address = body as Record<string, unknown>;
      if (address.type !== 'ADD' || address.id !== '' || address.isDefault !== false || typeof address.tag !== 'string' || !/^GDXB[a-f0-9]{16}$/.test(address.tag)) {
        throw new UpayError('Only explicitly owned new billing entries are allowed', false, undefined, { phase: 'pre_dispatch', ack: 'unconfirmed' });
      }
    }
    const enabled = KYC_WRITES.has(endpoint) || BILLING_WRITES.has(endpoint) ? this.config.UPAY_KYC_ENABLED : FINANCIAL_WRITES.has(endpoint) ? this.config.UPAY_WRITES_ENABLED : false;
    if (!enabled) throw new UpayError('UPay writes are not enabled for this operation', false, undefined, { phase: 'pre_dispatch', ack: 'unconfirmed' });
    let token: string;
    try {
      token = await this.authenticate();
      await options.beforeDispatch?.();
    } catch (error) {
      throw new UpayError(error instanceof UpayError ? error.message : 'UPay submission pre-dispatch check failed',
        error instanceof UpayError ? error.retryable : true, error instanceof UpayError ? error.code : undefined,
        { phase: 'pre_dispatch', ack: error instanceof UpayError ? error.metadata?.ack ?? 'unconfirmed' : 'unconfirmed',
          ...(error instanceof UpayError && error.metadata?.httpStatus !== undefined ? { httpStatus: error.metadata.httpStatus } : {}) });
    }
    try { return await this.transport.request<T>('POST', endpoint, { token, body }); }
    catch (error) {
      // No retry and no unproven refund: an external POST may already have taken effect.
      throw new UpayError(error instanceof UpayError ? error.message : 'UPay submission result is unknown', true,
        error instanceof UpayError ? error.code : undefined,
        error instanceof UpayError && error.metadata ? error.metadata : { phase: 'post_dispatched', ack: 'unconfirmed' });
    }
  }

  async uploadRequest(file: Uint8Array, mimeType: string, fileType: number, options: { beforeDispatch?: () => Promise<void> } = {}): Promise<{ uri: string; fullUrl?: string }> {
    if (!['image/jpeg', 'image/png'].includes(mimeType) || file.byteLength > 2 * 1024 * 1024 || file.byteLength === 0 || !Number.isInteger(fileType) || fileType < 1 || fileType > 99) {
      throw new UpayError('Invalid UPay upload', false);
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file).buffer], { type: mimeType }), mimeType === 'image/png' ? 'kyc-document.png' : 'kyc-document.jpg');
    form.append('fileType', String(fileType));
    const result = await this.submitRequest<{ uri: string; fullUrl?: string }>('/file/upload', form, options);
    if (!result || typeof result.uri !== 'string' || !result.uri || result.uri.length > 4096) throw new UpayError('UPay upload returned an invalid receipt', true);
    return result;
  }

  /** Native unpaid invoice creation, separate from card spending and address
   * allocation. A dispatched request is never replayed, even on session expiry. */
  async createDepositInvoice(body: { coinId: string; chainId: string; amount: number; ditchCode: 'PTF' },
    options: { beforeDispatch?: () => Promise<void> } = {}): Promise<unknown> {
    this.assertCardInfo('POST /quick/deposit/submit');
    if (!this.config.UPAY_INVOICE_DEPOSITS_ENABLED || !body || Object.keys(body).sort().join(',') !== 'amount,chainId,coinId,ditchCode' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(body.coinId) || !/^[A-Za-z0-9_-]{1,128}$/.test(body.chainId) || body.ditchCode !== 'PTF' ||
        !Number.isFinite(body.amount) || body.amount < 1 || body.amount > 100_000 || !/^\d+(?:\.\d{1,6})?$/.test(String(body.amount))) {
      throw new UpayError('UPay invoice creation is disabled or invalid', false, undefined, { phase: 'pre_dispatch', ack: 'unconfirmed' });
    }
    let token: string;
    try { token = await this.authenticate(); await options.beforeDispatch?.(); }
    catch (error) {
      throw new UpayError('UPay invoice pre-dispatch check failed', error instanceof UpayError ? error.retryable : true,
        error instanceof UpayError ? error.code : undefined, { phase: 'pre_dispatch', ack: 'unconfirmed' });
    }
    try { return await this.transport.request('POST', '/quick/deposit/submit', { token, body }); }
    catch (error) {
      throw new UpayError('UPay invoice creation outcome is unknown', true, error instanceof UpayError ? error.code : undefined,
        error instanceof UpayError && error.metadata ? error.metadata : { phase: 'post_dispatched', ack: 'unconfirmed' });
    }
  }

  loginInfo(): Promise<UpayLoginInfo> { return this.readRequest('GET', '/sys/member/loginInfo'); }

  // The panel checks this credential separately before its financial submission.
  // Keep this fixed endpoint outside both the replayable reads and mutation APIs.
  async validatePaymentPassword(): Promise<{ valid: true }> {
    this.assertCardInfo('POST /asset/checkPinCode');
    const pin = this.config.UPAY_PAYMENT_PASSWORD;
    if (!/^\d{6}$/.test(pin ?? '')) throw new UpayError('Configure a six digit UPay payment password before validation', false);
    const info = await this.loginInfo();
    const pinSet: unknown = info?.pinCodeSet;
    if (pinSet !== true && pinSet !== 1) throw new UpayError('UPay has not confirmed a configured payment password', false);
    let pinCode: string;
    try { pinCode = encryptPaymentPin(pin!, info); }
    catch { throw new UpayError('UPay payment password encryption metadata is unavailable', false); }
    const token = await this.authenticate();
    // Even a session-expired response must not cause a second credential attempt.
    const result = await this.transport.request<unknown>('POST', '/asset/checkPinCode', { token, body: { pinCode } });
    if (result === false) throw new UpayError('UPay payment password validation was not confirmed', false);
    return { valid: true };
  }

  merchant(): Promise<UpayMerchant> { return this.readRequest('GET', '/agent/info'); }
  customers(pageNo = 1, pageSize = 20): Promise<UpayPage<Record<string, unknown>>> { return this.readRequest('GET', '/customer/list', { query: { pageNo, pageSize } }); }
  cards(pageNo = 1, pageSize = 20): Promise<UpayPage<Record<string, unknown>>> { return this.readRequest('GET', '/card/list', { query: { pageNo, pageSize } }); }
  products(): Promise<UpayPage<Record<string, unknown>>> { return this.readRequest('GET', '/card/getPageToMayApplyCard', { query: { pageNo: 1, pageSize: 100 } }); }
  groups(): Promise<UpayPage<Record<string, unknown>>> { return this.readRequest('GET', '/customer/group/list', { query: { pageNo: 1, pageSize: 100 } }); }
  cardBalance(): Promise<{ symbol: string; balanceTotal: string }> { return this.readRequest('POST', '/card/getCardBalanceTotal'); }

  async check(): Promise<{ authenticated: true; merchant: UpayMerchant | null; paymentPasswordSet: boolean | null;
    financialWritesEnabled: boolean; reads: Record<'merchant' | 'cards' | 'customers' | 'products', UpayReadCheck> }> {
    const info = await this.loginInfo();
    const probe = async <T>(read: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; code?: number }> => {
      try { return { ok: true, data: await read() }; }
      catch (error) { return { ok: false, code: error instanceof UpayError ? error.code : undefined }; }
    };
    const [merchant, cards, customers, products] = await Promise.all([
      probe(() => this.merchant()), probe(() => this.cards(1, 1)), probe(() => this.customers(1, 1)), probe(() => this.products()),
    ]);
    const summary = (result: { ok: true; data: unknown } | { ok: false; code?: number }): UpayReadCheck => {
      if (!result.ok) return { ok: false, code: result.code };
      const total = (result.data as { totalSize?: unknown } | null)?.totalSize;
      return { ok: true, ...(typeof total === 'number' && Number.isFinite(total) ? { total } : {}) };
    };
    const pinState: unknown = info.pinCodeSet;
    return { authenticated: true,
      merchant: merchant.ok ? { merchantNo: merchant.data.merchantNo, companyName: merchant.data.companyName } : null,
      paymentPasswordSet: pinState === true || pinState === 1 ? true : pinState === false || pinState === 0 ? false : null,
      financialWritesEnabled: this.config.CARD_PARTNER === 'upay' && this.config.UPAY_WRITES_ENABLED,
      reads: { merchant: summary(merchant), cards: summary(cards), customers: summary(customers), products: summary(products) } };
  }
}
