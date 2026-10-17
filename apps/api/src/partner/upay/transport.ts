import { randomBytes } from 'node:crypto';
import { PartnerError } from '../types';

export interface UpayErrorMetadata {
  phase: 'pre_dispatch' | 'post_dispatched';
  ack: 'rejected_envelope' | 'http_error' | 'unconfirmed';
  httpStatus?: number;
  businessCategory?: 'billing_phone_region_restricted';
}

export class UpayError extends PartnerError {
  readonly code?: number;
  readonly metadata?: UpayErrorMetadata;
  constructor(message: string, retryable: boolean, code?: number, metadata?: UpayErrorMetadata) {
    super(message, retryable);
    if (typeof code === 'number' && Number.isSafeInteger(code)) this.code = code;
    if (metadata && ['pre_dispatch', 'post_dispatched'].includes(metadata.phase) && ['rejected_envelope', 'http_error', 'unconfirmed'].includes(metadata.ack)) {
      this.metadata = { phase: metadata.phase, ack: metadata.ack,
        ...(Number.isInteger(metadata.httpStatus) && metadata.httpStatus! >= 100 && metadata.httpStatus! <= 599 ? { httpStatus: metadata.httpStatus } : {}),
        ...(metadata.phase === 'post_dispatched' && metadata.ack === 'rejected_envelope' && metadata.businessCategory === 'billing_phone_region_restricted'
          ? { businessCategory: metadata.businessCategory } : {}) };
    }
  }
  get sessionExpired(): boolean { return this.code !== undefined && [10020, 10011, 10021].includes(this.code); }
}

export interface UpayTransportOptions {
  baseUrl: string;
  deviceId: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class UpayTransport {
  private readonly fetch: typeof fetch;
  constructor(private readonly options: UpayTransportOptions) { this.fetch = options.fetch ?? globalThis.fetch; }

  async request<T>(method: 'GET' | 'POST', endpoint: string, options: {
    token?: string; query?: Record<string, string | number>; body?: object;
  } = {}): Promise<T> {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(endpoint)) throw new UpayError('Invalid UPay endpoint', false, undefined, { phase: 'pre_dispatch', ack: 'unconfirmed' });
    const url = new URL(`${this.options.baseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
    const multipart = options.body instanceof FormData;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', Accept: 'application/json;charset=UTF-8',
      'Cache-Control': 'no-cache', deviceID: this.options.deviceId, Token: options.token ?? '',
      pretreatment: 'true', language: 'en-US', 'Accept-Language': 'en-US',
      DateTime: new Date().toISOString().slice(0, 19).replace('T', ' '),
      'X-B3-Traceid': randomBytes(8).toString('hex'), 'X-B3-Spanid': randomBytes(8).toString('hex'),
    };
    if (multipart) delete headers['Content-Type'];
    let response: Response;
    try {
      response = await this.fetch(url, { method, headers, body: multipart ? options.body as FormData : options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs), redirect: 'error' });
    } catch {
      throw new UpayError(`UPay ${endpoint}: connection failed or timed out`, true, undefined, { phase: 'post_dispatched', ack: 'unconfirmed' });
    }
    if (!response.ok) {
      const metadata: UpayErrorMetadata = { phase: 'post_dispatched', ack: 'http_error', httpStatus: response.status };
      if (response.status === 401) throw new UpayError('UPay session expired', true, 10020, metadata);
      throw new UpayError(`UPay ${endpoint}: HTTP ${response.status}`, response.status === 429 || response.status >= 500, undefined, metadata);
    }
    let result: { code?: number; success?: boolean; data?: T; msg?: unknown; message?: unknown };
    try { result = await response.json() as typeof result; }
    catch { throw new UpayError(`UPay ${endpoint}: invalid response`, true, undefined, { phase: 'post_dispatched', ack: 'unconfirmed', httpStatus: response.status }); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new UpayError(`UPay ${endpoint}: invalid response`, true, undefined,
      { phase: 'post_dispatched', ack: 'unconfirmed', httpStatus: response.status });
    // Mirrors the panel's envelope check; never propagate upstream messages containing personal data.
    if (result.code !== 200 && !(result.code === 0 && result.success === true)) {
      const code = typeof result.code === 'number' && Number.isSafeInteger(result.code) ? result.code : undefined;
      throw new UpayError(`UPay ${endpoint}: request rejected (code ${code ?? 'unknown'})`,
        code !== undefined && [10020, 10011, 10021].includes(code), code,
        { phase: 'post_dispatched', ack: 'rejected_envelope', httpStatus: response.status,
          ...(method === 'POST' && endpoint === '/card/applyOpenCard' &&
            [result.msg, result.message].some(value => value === "The mobile phone area code of the customer's billing address is restricted!")
            ? { businessCategory: 'billing_phone_region_restricted' as const } : {}) });
    }
    return result.data as T;
  }
}
