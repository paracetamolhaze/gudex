import { afterEach, describe, expect, it, vi } from 'vitest';
import { isKycBirthDateEligible, kycApplicantValidity, KYC_UPLOAD_MAX_BYTES, kycImageBase64, sendKycSubmission, type KycUploadCache, validateKycImage } from '../../../miniapp/src/lib/kyc';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const image = (bytes = jpeg, type = 'image/jpeg') => new File([bytes], 'verification-image', { type });
const applicant = { firstName: 'IVAN', lastName: 'IVANOV', email: 'example@example.test', birthDate: '1990-01-01', citizenship: 'KZ' };
const receipt = (body: { clientDocumentId: string; kind: string; mimeType: string }) => ({ id: body.clientDocumentId, kind: body.kind,
  mimeType: body.mimeType, size: 8, expiresAt: new Date(Date.now() + 3600_000).toISOString() });

afterEach(() => vi.unstubAllGlobals());

describe('verification image validation', () => {
  it('accepts JPEG and PNG only when their signatures match the declared MIME type', async () => {
    expect(await validateKycImage(image(), KYC_UPLOAD_MAX_BYTES)).toBeNull();
    expect(await validateKycImage(image(png, 'image/png'), KYC_UPLOAD_MAX_BYTES)).toBeNull();
    expect(await validateKycImage(image(png, 'image/jpeg'), KYC_UPLOAD_MAX_BYTES)).toBe('fileContent');
    expect(await validateKycImage(image(jpeg, 'image/png'), KYC_UPLOAD_MAX_BYTES)).toBe('fileContent');
    expect(await validateKycImage(image(jpeg, 'application/pdf'), KYC_UPLOAD_MAX_BYTES)).toBe('fileType');
  });

  it('rejects empty images, the configured limit, and images exceeding the serverless upload ceiling', async () => {
    expect(await validateKycImage(image(new Uint8Array()), KYC_UPLOAD_MAX_BYTES)).toBe('fileSize');
    expect(await validateKycImage(image(), jpeg.length - 1)).toBe('fileSize');
    const tooLarge = image(new Uint8Array(KYC_UPLOAD_MAX_BYTES + 1));
    expect(await validateKycImage(tooLarge, 4 * 1024 * 1024)).toBe('fileSize');
  });

  it('encodes the selected bytes without changing the photo', async () => {
    expect(Buffer.from(await kycImageBase64(image()), 'base64')).toEqual(Buffer.from(jpeg));
  });

  it('checks the age on calendar birthdays and rejects impossible or future dates', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    expect(isKycBirthDateEligible('2008-10-16', now)).toBe(true);
    expect(isKycBirthDateEligible('2008-10-17', now)).toBe(false);
    expect(isKycBirthDateEligible('2027-01-01', now)).toBe(false);
    expect(isKycBirthDateEligible('1906-10-16', now)).toBe(false);
    expect(isKycBirthDateEligible('1990-02-31', now)).toBe(false);
  });
});

describe('explicit verification submission', () => {
  it('uses the same live contact boundaries in the form and upload guard without rewriting identity', () => {
    const contact = { ...applicant, firstName: 'IVAN PETR', phone: '13912345678', globalCode: '+86' };
    expect(kycApplicantValidity(contact, true)).toEqual({ first: true, last: true, email: true, phone: true });
    expect(kycApplicantValidity({ ...contact, firstName: 'A'.repeat(49), phone: '1234567890123', globalCode: '+7' }, true).first).toBe(true);
    expect(kycApplicantValidity({ ...contact, phone: '1234567890123', globalCode: '+7' }, true).phone).toBe(true);
    expect(kycApplicantValidity({ ...contact, phone: '123456', globalCode: '+7' }, true).phone).toBe(false);
    expect(kycApplicantValidity({ ...contact, firstName: "O'NEIL" }, false).first).toBe(true);
    expect(contact.firstName).toBe('IVAN PETR');
  });
  it.each([
    { firstName: "O'NEIL" }, { lastName: 'IVAN-IVANOV' }, { firstName: 'A'.repeat(50) },
    { email: '.ivan@example.test' }, { email: 'ivan..ivan@example.test' },
    { phone: '12345678901234' }, { globalCode: '+86', phone: '12345678901' },
  ])('rejects live contact details that cannot issue a card before uploading any photo', async invalid => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (path, options) => Response.json(String(path).endsWith('/documents')
      ? receipt(JSON.parse(String(options?.body))) : { status: 'pending', submissionState: 'queued' }));
    vi.stubGlobal('fetch', fetch);
    await expect(sendKycSubmission({ ...applicant, phone: '7011234567', globalCode: '+7', ...invalid,
      documents: { front: image() } })).rejects.toMatchObject({ code: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uploads photos individually and submits only document references with applicant details', async () => {
    const requests: { path: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (path, options) => {
      const body = JSON.parse(String(options?.body));
      requests.push({ path: String(path), body });
      return Response.json(String(path).endsWith('/documents') ? receipt(body) : { status: 'pending', submissionState: 'queued' });
    }));

    const result = await sendKycSubmission({ ...applicant, phone: '7011234567', globalCode: '+7', documentType: 'id_card', documentCountry: 'KZ',
      documents: { front: image(), back: image(png, 'image/png'), selfie: image() } });

    expect(requests.map(({ path }) => path)).toEqual(['/v1/kyc/documents', '/v1/kyc/documents', '/v1/kyc/documents', '/v1/kyc']);
    expect(requests.slice(0, 3).map(({ body }) => body.kind)).toEqual(['front', 'back', 'selfie']);
    expect(requests[3]?.body).toEqual({ ...applicant, phone: '7011234567', globalCode: '+7', documentType: 'id_card', documentCountry: 'KZ',
      documentIds: { front: requests[0]?.body.clientDocumentId, back: requests[1]?.body.clientDocumentId, selfie: requests[2]?.body.clientDocumentId } });
    expect(result.status).toBe('pending');
  });

  it('checks every selected image before any upload', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(sendKycSubmission({ ...applicant, documents: { front: image(), back: image(png, 'image/jpeg') } })).rejects.toMatchObject({ code: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not upload documents or add optional live metadata for a demo applicant', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: 'pending' }));
    vi.stubGlobal('fetch', fetch);
    await sendKycSubmission(applicant);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/v1/kyc');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(applicant);
  });

  it('does not automatically repeat an upload after a lost response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('response lost'); });
    vi.stubGlobal('fetch', fetch);
    await expect(sendKycSubmission({ ...applicant, documents: { front: image() } })).rejects.toMatchObject({ code: 'network' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the final submission after a lost response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (path, options) => {
      if (String(path).endsWith('/documents')) return Response.json(receipt(JSON.parse(String(options?.body))));
      throw new Error('response lost');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(sendKycSubmission({ ...applicant, documents: { front: image() } })).rejects.toMatchObject({ code: 'network' });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/v1/kyc/documents', '/v1/kyc']);
  });

  it('rejects an ineligible date of birth before uploading any photos', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(sendKycSubmission({ ...applicant, birthDate: new Date().toISOString().slice(0, 10), documents: { front: image() } })).rejects.toMatchObject({ code: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reuses staged photo references on an explicit retry after a final validation failure', async () => {
    const uploads: KycUploadCache = new Map();
    const file = image();
    const fetch = vi.fn<typeof globalThis.fetch>(async (path, options) => String(path).endsWith('/documents')
      ? Response.json(receipt(JSON.parse(String(options?.body))))
      : Response.json({ error: { code: 'validation', message: 'Check applicant data' } }, { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(sendKycSubmission({ ...applicant, documents: { front: file } }, uploads)).rejects.toMatchObject({ code: 'validation' });
    }
    expect(fetch.mock.calls.filter(([path]) => path === '/v1/kyc/documents')).toHaveLength(1);
    expect(fetch.mock.calls.filter(([path]) => path === '/v1/kyc')).toHaveLength(3);
  });

  it('reuses the same document id after an upload response is lost', async () => {
    const uploads: KycUploadCache = new Map();
    const file = image();
    let uploadCount = 0;
    const ids: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (path, options) => {
      if (String(path).endsWith('/documents')) {
        const body = JSON.parse(String(options?.body));
        ids.push(body.clientDocumentId);
        if (++uploadCount === 1) throw new Error('Upload accepted but response lost');
        return Response.json(receipt(body));
      }
      return Response.json({ status: 'pending' });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(sendKycSubmission({ ...applicant, documents: { front: file } }, uploads)).rejects.toMatchObject({ code: 'network' });
    await sendKycSubmission({ ...applicant, documents: { front: file } }, uploads);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('deletes an unused stage before uploading a replacement photo', async () => {
    const uploads: KycUploadCache = new Map();
    const fetch = vi.fn<typeof globalThis.fetch>(async (path, options) => {
      if (options?.method === 'DELETE') return Response.json({ ok: true });
      if (String(path).endsWith('/documents')) return Response.json(receipt(JSON.parse(String(options?.body))));
      return Response.json({ error: { code: 'validation', message: 'Check applicant data' } }, { status: 400 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(sendKycSubmission({ ...applicant, documents: { front: image() } }, uploads)).rejects.toMatchObject({ code: 'validation' });
    const previousId = uploads.get('front')!.clientDocumentId;
    await expect(sendKycSubmission({ ...applicant, documents: { front: image() } }, uploads)).rejects.toMatchObject({ code: 'validation' });
    expect(fetch.mock.calls.map(([path, options]) => `${options?.method} ${path}`)).toEqual([
      'POST /v1/kyc/documents', 'POST /v1/kyc', `DELETE /v1/kyc/documents/${previousId}`, 'POST /v1/kyc/documents', 'POST /v1/kyc',
    ]);
  });

  it('stops a retry when the previous photo is already part of an active verification', async () => {
    const uploads: KycUploadCache = new Map([['front', { file: image(), clientDocumentId: 'previous-document' }]]);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { code: 'validation', message: 'Active verification' } }, { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    await expect(sendKycSubmission({ ...applicant, documents: { front: image() } }, uploads)).rejects.toMatchObject({ code: 'validation' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('generates document UUIDs securely in a webview without randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(0x11) });
    const uploads: KycUploadCache = new Map();
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (path, options) => String(path).endsWith('/documents')
      ? Response.json(receipt(JSON.parse(String(options?.body)))) : Response.json({ status: 'pending' })));
    await sendKycSubmission({ ...applicant, documents: { front: image() } }, uploads);
    expect(uploads.get('front')?.clientDocumentId).toBe('11111111-1111-4111-9111-111111111111');
  });
});
