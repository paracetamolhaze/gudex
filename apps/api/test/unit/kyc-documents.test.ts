import { describe, expect, it } from 'vitest';
import { validateKycDocumentUpload } from '../../src/kyc/document-store';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1kAAAAASUVORK5CYII=', 'base64');

describe('KYC photo upload boundary', () => {
  it('accepts a real PNG and returns only the decoded image', () => {
    const image = validateKycDocumentUpload({ kind: 'front', mimeType: 'image/png', base64: png.toString('base64') });
    expect(image.bytes).toEqual(png);
    expect(image.mimeType).toBe('image/png');
  });

  it('rejects a disguised file and mismatched declared MIME', () => {
    expect(() => validateKycDocumentUpload({ kind: 'front', mimeType: 'image/png', base64: Buffer.from('<script>private</script>').toString('base64') })).toThrow('JPEG or PNG');
    expect(() => validateKycDocumentUpload({ kind: 'selfie', mimeType: 'image/jpeg', base64: png.toString('base64') })).toThrow('does not match');
  });

  it('rejects noncanonical base64 and oversized selfies before storage', () => {
    expect(() => validateKycDocumentUpload({ kind: 'front', mimeType: 'image/png', base64: `${png.toString('base64')}!` })).toThrow('base64');
    const large = Buffer.alloc(2 * 1024 * 1024 + 1);
    png.copy(large);
    expect(() => validateKycDocumentUpload({ kind: 'selfie', mimeType: 'image/png', base64: large.toString('base64') })).toThrow('2 MiB');
  });

  it('handles a full 2 MiB JPEG upload without recursive base64 parsing', () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024);
    bytes.set([255, 216, 255, 224]);
    bytes.set([255, 217], bytes.length - 2);
    const image = validateKycDocumentUpload({ kind: 'selfie', mimeType: 'image/jpeg', base64: bytes.toString('base64') });
    expect(image.bytes.length).toBe(2097152);
  });
});
