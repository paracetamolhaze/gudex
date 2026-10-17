import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeSecret(input: string): Buffer {
  let secret = input;
  if (input.startsWith('otpauth://')) {
    const uri = new URL(input);
    if (uri.hostname !== 'totp' || (uri.searchParams.get('algorithm') ?? 'SHA1').toUpperCase() !== 'SHA1' ||
        (uri.searchParams.get('period') ?? '30') !== '30' || (uri.searchParams.get('digits') ?? '6') !== '6') {
      throw new Error('UPay requires SHA1 TOTP with six digits and a 30 second period');
    }
    secret = uri.searchParams.get('secret') ?? '';
  }
  secret = secret.replace(/[\s=-]/g, '').toUpperCase();
  if (secret.length < 16 || !/^[A-Z2-7]+$/.test(secret)) throw new Error('Invalid UPAY_TOTP_SECRET format');
  let value = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  return Buffer.from(bytes);
}

// RFC 6238. The seed and generated codes must never be logged.
export function totp(secret: string, nowMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30000)));
  const digest = createHmac('sha1', decodeSecret(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
