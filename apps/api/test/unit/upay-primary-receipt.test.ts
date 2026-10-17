import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectPrimaryCardMirror, inspectPrimaryReceipt, primaryNationalityCodeHash, primaryVerificationStatus } from '../../src/partner/upay/primary-customer-kyc';
import type { UpaySubmission } from '../../src/partner/upay/submissions';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(documentType: 1 | 2 = 1) {
  const submission: UpaySubmission = { reference: 'kyc:PRIVATE-submission', kind: 'kyc', requestHash: 'PRIVATE-request', state: 'acknowledged',
    partnerReceiptId: null, partnerCardId: null, evidence: { kycProtocol: 'customer_primary', documentType, customerNo: 'PRIVATE-customer',
      nationalityCodeHash: primaryNationalityCodeHash('KZ'), documentFrontHash: hash('PRIVATE-front'), documentBackHash: hash(documentType === 1 ? 'PRIVATE-back' : '*') } };
  const item = { documentType, level: 1, status: 1, nationalityCode: 'KZ', frontPhoto: 'PRIVATE-front', backPhoto: documentType === 1 ? 'PRIVATE-back' : '*' };
  return { submission, item, info: { items: [item] } };
}

describe('safe primary receipt diagnostics', () => {
  it('reports the exact terminal comparisons without returning values or hashes', () => {
    const { submission, info } = fixture();
    expect(inspectPrimaryReceipt(info, submission, 1)).toEqual({ protocolMatches: true, documentTypeMatches: true, itemUnique: true,
      itemLevelMatches: true, itemStatusSupported: true, countryType: 'string', countryHashMatches: true, frontHashMatches: true, backHashMatches: true,
      frontPhoto: { shape: 'rawstring', knownKeys: [] }, backPhoto: { shape: 'rawstring', knownKeys: [] } });
    expect(primaryVerificationStatus(info, submission, 1)).toEqual({ status: 'approved' });
    const serialized = JSON.stringify(inspectPrimaryReceipt(info, submission, 1));
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain(submission.evidence.documentFrontHash);
    expect(serialized).not.toContain('KZ');
  });

  it('distinguishes country value types while preserving strict submitted type hashing', () => {
    const { submission, info, item } = fixture();
    submission.evidence.nationalityCodeHash = primaryNationalityCodeHash('398');
    Object.assign(item, { nationalityCode: 398 });
    expect(inspectPrimaryReceipt(info, submission, 1)).toMatchObject({ countryType: 'number', countryHashMatches: false, frontHashMatches: true, backHashMatches: true });
    expect(() => primaryVerificationStatus(info, submission, 1)).toThrow();
  });

  it.each([
    ['json', JSON.stringify({ data: { fileUri: 'PRIVATE-front' }, fullUrl: 'PRIVATE-preview', PRIVATE_KEY: 'PRIVATE-value' }), ['data', 'fileUri', 'fullUrl']],
    ['object', { result: { path: 'PRIVATE-front' }, url: 'PRIVATE-preview', PRIVATE_KEY: 'PRIVATE-value' }, ['path', 'result', 'url']],
    ['array', [{ uri: 'PRIVATE-front' }], []],
    ['null', null, []],
  ] as const)('reports %s photo shape with only known field names', (shape, frontPhoto, knownKeys) => {
    const { submission, info, item } = fixture();
    Object.assign(item, { frontPhoto });
    const diagnostic = inspectPrimaryReceipt(info, submission, 1);
    expect(diagnostic.frontPhoto).toEqual({ shape, knownKeys });
    expect(diagnostic.frontHashMatches).toBe(shape === 'json' || shape === 'object');
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE');
  });

  it('does not mistake a preview URL for the submitted document URI', () => {
    const { submission, info, item } = fixture();
    Object.assign(item, { frontPhoto: { fullUrl: 'PRIVATE-front' } });
    expect(inspectPrimaryReceipt(info, submission, 1)).toMatchObject({ frontHashMatches: false, frontPhoto: { shape: 'object', knownKeys: ['fullUrl'] } });
    expect(() => primaryVerificationStatus(info, submission, 1)).toThrow();
  });

  it.each([undefined, null, '', '*', { uri: '*' }])('uses the same passport empty-back rule as terminal matching', backPhoto => {
    const { submission, info, item } = fixture(2);
    Object.assign(item, { backPhoto });
    expect(inspectPrimaryReceipt(info, submission, 2)).toMatchObject({ backHashMatches: true });
    expect(primaryVerificationStatus(info, submission, 2)).toEqual({ status: 'approved' });
  });

  it('reports duplicate or absent selected items without inspecting an arbitrary candidate', () => {
    const { submission, item } = fixture();
    for (const items of [[item, { ...item }], [], [{ ...item, documentType: 2 }]]) {
      expect(inspectPrimaryReceipt({ items }, submission, 1)).toMatchObject({ itemUnique: false, itemLevelMatches: false,
        itemStatusSupported: false, countryHashMatches: false, frontHashMatches: false, backHashMatches: false,
        frontPhoto: { shape: 'null', knownKeys: [] } });
      expect(() => primaryVerificationStatus({ items }, submission, 1)).toThrow();
    }
  });

  it('keeps protocol, document type, item level and terminal evidence failures independent', () => {
    const { submission, info, item } = fixture();
    submission.evidence.kycProtocol = 'card'; submission.evidence.documentType = 2;
    Object.assign(item, { level: 2, nationalityCode: null, frontPhoto: 'PRIVATE-other-front', backPhoto: 'PRIVATE-other-back' });
    expect(inspectPrimaryReceipt(info, submission, 1)).toMatchObject({ protocolMatches: false, documentTypeMatches: false, itemUnique: true,
      itemLevelMatches: false, itemStatusSupported: true, countryType: 'null', countryHashMatches: false, frontHashMatches: false, backHashMatches: false });
    expect(() => primaryVerificationStatus(info, submission, 1)).toThrow();
  });
});

describe('safe primary card mirror diagnostics', () => {
  const customerNo = 'PRIVATE-customer';
  const idMirror = () => ({ customerNo, certifiedDocumentType: [1], idCardCountryCode: 'KZ', idCardFrontPath: 'PRIVATE-front', idCardBackPath: 'PRIVATE-back' });

  it('compares only the fixed ID mirror fields and does not change the primary status decision', () => {
    const { submission, info, item } = fixture();
    Object.assign(item, { nationalityCode: null, frontPhoto: null, backPhoto: null });
    const mirror = inspectPrimaryCardMirror(idMirror(), submission, 1, customerNo);
    expect(mirror).toMatchObject({ protocolMatches: true, documentTypeMatches: true, customerMatches: true,
      certifiedDocumentTypeMatches: true, certifiedDocumentTypeShape: 'array', countryType: 'string', countryHashMatches: true,
      frontHashMatches: true, backHashMatches: true, backPlaceholder: false,
      frontPhoto: { shape: 'rawstring', knownKeys: [] }, backPhoto: { shape: 'rawstring', knownKeys: [] } });
    expect(() => primaryVerificationStatus(info, submission, 1)).toThrow();
    expect(JSON.stringify(mirror)).not.toContain('PRIVATE');
    expect(JSON.stringify(mirror)).not.toContain(submission.evidence.nationalityCodeHash);
  });

  it.each(['response', 'journal'] as const)('requires the exact expected customer on the %s side', side => {
    const { submission } = fixture();
    const mirror = idMirror();
    if (side === 'response') mirror.customerNo = 'PRIVATE-other';
    else submission.evidence.customerNo = 'PRIVATE-other';
    expect(inspectPrimaryCardMirror(mirror, submission, 1, customerNo)).toMatchObject({ customerMatches: false, frontHashMatches: true });
  });

  it.each([
    [[1], 'array', true], [['1'], 'array', false], [1, 'number', false], ['1', 'string', false], [null, 'null', false],
  ] as const)('reports certified document shape without coercing an unexpected representation', (certifiedDocumentType, shape, matches) => {
    const { submission } = fixture();
    expect(inspectPrimaryCardMirror({ ...idMirror(), certifiedDocumentType }, submission, 1, customerNo))
      .toMatchObject({ certifiedDocumentTypeShape: shape, certifiedDocumentTypeMatches: matches });
  });

  it('preserves raw country type and does not accept unrelated country or document aliases', () => {
    const { submission } = fixture();
    submission.evidence.nationalityCodeHash = primaryNationalityCodeHash('398');
    expect(inspectPrimaryCardMirror({ ...idMirror(), idCardCountryCode: 398 }, submission, 1, customerNo))
      .toMatchObject({ countryType: 'number', countryHashMatches: false });
    expect(inspectPrimaryCardMirror({ customerNo, certifiedDocumentType: [1], nationalityCode: '398',
      documentFrontPath: 'PRIVATE-front', documentBackPath: 'PRIVATE-back' }, submission, 1, customerNo))
      .toMatchObject({ countryType: 'null', countryHashMatches: false, frontHashMatches: false, backHashMatches: false });
  });

  it('uses the same strict URI extractor and sanitized shape labels for mirror photos', () => {
    const { submission } = fixture();
    expect(inspectPrimaryCardMirror({ ...idMirror(), idCardFrontPath: JSON.stringify({ data: { uri: 'PRIVATE-front' }, url: 'PRIVATE-preview' }),
      idCardBackPath: { fullUrl: 'PRIVATE-back' } }, submission, 1, customerNo)).toMatchObject({
      frontHashMatches: true, backHashMatches: false, frontPhoto: { shape: 'json', knownKeys: ['data', 'uri', 'url'] },
      backPhoto: { shape: 'object', knownKeys: ['fullUrl'] },
    });
  });

  it('compares a passport back only with the submitted placeholder and labels it explicitly', () => {
    const { submission } = fixture(2);
    const mirror = { customerNo, certifiedDocumentType: [2], passportCountryCode: 'KZ', passportFrontPath: 'PRIVATE-front',
      idCardCountryCode: 'PRIVATE-other', idCardFrontPath: 'PRIVATE-other', idCardBackPath: 'PRIVATE-other' };
    expect(inspectPrimaryCardMirror(mirror, submission, 2, customerNo)).toMatchObject({ customerMatches: true,
      certifiedDocumentTypeMatches: true, countryHashMatches: true, frontHashMatches: true, backHashMatches: true,
      backPlaceholder: true, backPhoto: { shape: 'null', knownKeys: [] } });
    submission.evidence.documentBackHash = hash('PRIVATE-other');
    expect(inspectPrimaryCardMirror(mirror, submission, 2, customerNo)).toMatchObject({ backHashMatches: false });
  });

  it('reports signed HTTP URL path matches without exposing the URL, path, query or hash', () => {
    const { submission, info, item } = fixture();
    submission.evidence.documentFrontHash = hash('/PRIVATE-front.png');
    submission.evidence.documentBackHash = hash('PRIVATE-back.png');
    const diagnostic = inspectPrimaryCardMirror({ ...idMirror(), idCardFrontPath: 'https://PRIVATE.example/PRIVATE-front.png?signature=PRIVATE-token',
      idCardBackPath: 'https://PRIVATE.example/PRIVATE-back.png?signature=PRIVATE-token' }, submission, 1, customerNo);
    expect(diagnostic).toMatchObject({ frontHashMatches: false, backHashMatches: false,
      frontPhotoPath: { empty: false, placeholder: false, absoluteHttpUrl: true, pathnameHashMatches: true,
        pathnameWithoutLeadingSlashHashMatches: false, decodedPathnameHashMatches: true, decodedPathnameWithoutLeadingSlashHashMatches: false },
      backPhotoPath: { absoluteHttpUrl: true, pathnameHashMatches: false, pathnameWithoutLeadingSlashHashMatches: true,
        decodedPathnameHashMatches: false, decodedPathnameWithoutLeadingSlashHashMatches: true } });
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE');
    expect(JSON.stringify(diagnostic)).not.toContain(submission.evidence.documentFrontHash);
    Object.assign(item, { nationalityCode: null, frontPhoto: null, backPhoto: null });
    expect(() => primaryVerificationStatus(info, submission, 1)).toThrow();
  });

  it('compares one-pass decoded URL paths only as diagnostic evidence', () => {
    const { submission } = fixture();
    submission.evidence.documentFrontHash = hash('/PRIVATE-folder/PRIVATE-front.png');
    submission.evidence.documentBackHash = hash('PRIVATE-folder/PRIVATE-back.png');
    expect(inspectPrimaryCardMirror({ ...idMirror(), idCardFrontPath: 'https://PRIVATE.example/PRIVATE-folder%2FPRIVATE-front.png',
      idCardBackPath: 'https://PRIVATE.example/PRIVATE-folder%2FPRIVATE-back.png' }, submission, 1, customerNo)).toMatchObject({
      frontHashMatches: false, backHashMatches: false,
      frontPhotoPath: { pathnameHashMatches: false, pathnameWithoutLeadingSlashHashMatches: false,
        decodedPathnameHashMatches: true, decodedPathnameWithoutLeadingSlashHashMatches: false },
      backPhotoPath: { pathnameHashMatches: false, pathnameWithoutLeadingSlashHashMatches: false,
        decodedPathnameHashMatches: false, decodedPathnameWithoutLeadingSlashHashMatches: true } });
  });

  it.each(['', '*'] as const)('distinguishes empty and placeholder redaction without returning their values', value => {
    const { submission } = fixture();
    expect(inspectPrimaryCardMirror({ ...idMirror(), idCardCountryCode: value, idCardFrontPath: value, idCardBackPath: value }, submission, 1, customerNo))
      .toMatchObject({ countryEmpty: value === '', countryPlaceholder: value === '*', countryHashMatches: false,
        frontPhotoPath: { empty: value === '', placeholder: value === '*', absoluteHttpUrl: false, pathnameHashMatches: false },
        backPhotoPath: { empty: value === '', placeholder: value === '*', absoluteHttpUrl: false, decodedPathnameHashMatches: false } });
  });

  it.each(['PRIVATE-relative/path', 'ftp://PRIVATE.example/path', JSON.stringify({ uri: 'https://PRIVATE.example/path' }), { fullUrl: 'https://PRIVATE.example/path' }])(
    'does not treat non-HTTP strings or metadata as raw signed URLs', front => {
      const { submission } = fixture();
      expect(inspectPrimaryCardMirror({ ...idMirror(), idCardFrontPath: front }, submission, 1, customerNo)).toMatchObject({
        frontPhotoPath: { absoluteHttpUrl: false, pathnameHashMatches: false, pathnameWithoutLeadingSlashHashMatches: false,
          decodedPathnameHashMatches: false, decodedPathnameWithoutLeadingSlashHashMatches: false } });
    });

  it('leaves malformed percent encoding unconfirmed without changing the raw pathname diagnostic', () => {
    const { submission } = fixture();
    submission.evidence.documentFrontHash = hash('/PRIVATE%ZZ');
    expect(inspectPrimaryCardMirror({ ...idMirror(), idCardFrontPath: 'https://PRIVATE.example/PRIVATE%ZZ' }, submission, 1, customerNo))
      .toMatchObject({ frontHashMatches: false, frontPhotoPath: { absoluteHttpUrl: true, pathnameHashMatches: true,
        decodedPathnameHashMatches: false, decodedPathnameWithoutLeadingSlashHashMatches: false } });
  });

  it.each(['null', 'undefined', '**', 'XXX', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY'])('classifies a redacted string without exposing it', value => {
    const { submission } = fixture();
    expect(inspectPrimaryCardMirror({ ...idMirror(), idCardCountryCode: value, idCardFrontPath: value, idCardBackPath: value }, submission, 1, customerNo))
      .toMatchObject({ countryNullLiteral: value === 'null', countryUndefinedLiteral: value === 'undefined', countryMaskedStars: value === '**',
        frontPhotoPath: { nullLiteral: value === 'null', undefinedLiteral: value === 'undefined', maskedStars: value === '**', maskedX: value === 'XXX',
          looksBase64Envelope: value === 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY' },
        backPhotoPath: { nullLiteral: value === 'null', undefinedLiteral: value === 'undefined', maskedStars: value === '**', maskedX: value === 'XXX' } });
  });
});
