import { ISO_COUNTRY_CODES } from '@gudex/shared';

function regionNames(locale: string): ((code: string) => string) {
  try {
    const names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'code' });
    return code => names.of(code) ?? code;
  } catch { return code => code; }
}

/** Country name in the interface language; the code stays as is if the device has no name for it. */
export const countryName = (code: string, locale: string) => regionNames(locale)(code);

/** All countries for citizenship, document and address pickers, in alphabetical order of the interface language. */
export function countryOptions(locale: string): { code: string; name: string }[] {
  const name = regionNames(locale);
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return ISO_COUNTRY_CODES.map(code => ({ code, name: name(code) })).sort((a, b) => collator.compare(a.name, b.name));
}
