import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../lib/errors';

// Card number and CVV entered by an operator for a manually issued card. Sealed with
// AES-GCM to this exact user and card, so a row copied to another card cannot be opened.
export interface CardRequisites { pan: string; cvv: string }

export function luhnValid(pan: string): boolean {
  if (!/^\d{13,19}$/.test(pan)) return false;
  let sum = 0;
  for (let index = 0; index < pan.length; index++) {
    let digit = Number(pan[pan.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

export class CardRequisitesVault {
  private readonly key: Buffer;
  constructor(appSecret: string) { this.key = createHmac('sha256', appSecret).update('gudex:card-requisites:v1').digest(); }

  seal(userId: string, cardId: string, value: CardRequisites): { requisitesCiphertext: string; requisitesIv: string; requisitesTag: string } {
    if (!luhnValid(value.pan) || !/^\d{3,4}$/.test(value.cvv)) throw new AppError('validation', 'Invalid card number or CVV');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${userId}:${cardId}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { requisitesCiphertext: ciphertext.toString('base64'), requisitesIv: iv.toString('base64'), requisitesTag: cipher.getAuthTag().toString('base64') };
  }

  open(userId: string, cardId: string, row: { requisitesCiphertext: string | null; requisitesIv: string | null; requisitesTag: string | null }): CardRequisites | null {
    if (!row.requisitesCiphertext || !row.requisitesIv || !row.requisitesTag) return null;
    try {
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.requisitesIv, 'base64'));
      cipher.setAAD(Buffer.from(`${userId}:${cardId}`));
      cipher.setAuthTag(Buffer.from(row.requisitesTag, 'base64'));
      const value = JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.requisitesCiphertext, 'base64')), cipher.final()]).toString('utf8')) as CardRequisites;
      if (!luhnValid(value.pan) || !/^\d{3,4}$/.test(value.cvv)) throw new Error('shape');
      return value;
    } catch { throw new AppError('provider_unavailable', 'Saved card details cannot be read'); }
  }
}
