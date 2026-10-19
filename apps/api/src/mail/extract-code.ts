// Finds a confirmation code in a letter. The answer is a code only when exactly one candidate stands
// next to words like «код» / "code" and nothing around it looks like a date, time, amount, card or order
// number. Anything uncertain returns null: the client then gets only "a new letter arrived".

const MAX_TEXT = 50_000;
const KEYWORD = /(code|код|otp|passcode|one[\s-]?time|verification|verify|подтвержд|одноразов|пароль|password)/i;
// The last word right before a number that makes it something other than a code.
const NOT_A_CODE = /^(order|orders|заказ|заказа|номер|number|no|invoice|счёт|счет|счета|card|карта|карты|карту|ending|transaction|транзакция|транзакции|amount|сумма|суммы|balance|баланс|id|ref|reference|tel|phone|телефон|ticket|account|аккаунт|года|год|year)$/i;
const MONTH = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек|©|copyright)/i;
const CURRENCY_AFTER = /^\s?(%|usd|usdt|usdc|eur|rub|kzt|руб|₽|\$|€|£|тг|₸)/i;
const CANDIDATE = /(?<![\p{L}\p{N}*•xх#№$€£₽_])(?:\d{4,8}|(?=[A-Z0-9]{4,10}(?![\p{L}\p{N}]))(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,10})(?![\p{L}\p{N}_])/gu;

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', mdash: '—', ndash: '–', copy: '©', reg: '®', trade: '™', zwnj: '', zwj: '' };

export function htmlToText(html: string): string {
  return html.slice(0, MAX_TEXT * 4)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|header|footer|blockquote)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => safeChar(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeChar(code: number): string {
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
}

function clean(text: string): string {
  return text.slice(0, MAX_TEXT).replace(/[​-‍⁠﻿­͏]/g, '').replace(/[   ]/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

function plausible(text: string, index: number, value: string): boolean {
  const before = text.slice(Math.max(0, index - 80), index);
  const after = text.slice(index + value.length, index + value.length + 40);
  if (!KEYWORD.test(before) && !KEYWORD.test(after)) return false;
  // Parts of a date, time, decimal amount or a grouped long number.
  if (/\d\s?[.,:/-]\s?$/.test(before) || /^\s?[.,:/-]\s?\d/.test(after) || /\d $/.test(before) || /^ \d/.test(after)) return false;
  if (/[+$€£₽]\s?$/.test(before) || CURRENCY_AFTER.test(after)) return false;
  const lastWord = /([\p{L}]+)[\s:.#№*•-]*$/u.exec(before.slice(-14))?.[1];
  if (lastWord && NOT_A_CODE.test(lastWord)) return false;
  if (/^\d{4}$/.test(value) && Number(value) >= 1950 && Number(value) <= 2099
    && MONTH.test(text.slice(Math.max(0, index - 20), index + value.length + 20))) return false;
  return true;
}

function fromPattern(pattern: string, text: string): string | null {
  let expression: RegExp;
  try { expression = new RegExp(pattern, 'iu'); } catch { return null; }
  const match = expression.exec(text);
  const value = (match?.[1] ?? match?.[0])?.trim();
  return value && /^[A-Za-z0-9-]{3,12}$/.test(value) ? value : null;
}

/** Returns the code, or null when there is none or more than one candidate. */
export function extractCode(input: { subject?: string | null; text?: string | null; html?: string | null; codePattern?: string | null }): string | null {
  const body = input.text?.trim() ? input.text : input.html ? htmlToText(input.html) : '';
  const parts = [clean(input.subject ?? ''), clean(body ?? '')].filter(Boolean);
  if (input.codePattern) {
    for (const part of parts) {
      const value = fromPattern(input.codePattern, part);
      if (value) return value;
    }
  }
  const found = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(CANDIDATE)) {
      if (plausible(part, match.index, match[0])) found.add(match[0]);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}
