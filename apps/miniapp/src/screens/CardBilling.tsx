import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CardBillingAddressDto, CardBillingAddressInput, CardBillingCountryDto } from '@gudex/shared';
import { Icon } from '../components/Icon';
import { Button, Field, Loading, Notice, Page, QueryError } from '../components/ui';
import { validCardBillingAddress } from '../lib/billing';
import { countryName } from '../lib/countries';
import { useFormat } from '../lib/format';
import { useCardBillingAddress, useCardBillingCountries, useSaveCardBillingAddress } from '../lib/queries';
import { haptic } from '../lib/telegram';

export function CardBilling() {
  const { t } = useTranslation();
  const billing = useCardBillingAddress();
  if (billing.error) return <Page title={t('billing.title')}><QueryError error={billing.error} onRetry={() => void billing.refetch()} /></Page>;
  if (!billing.data || billing.isFetching) return <Loading />;
  return <Page title={t('billing.title')}>
    <CardBillingEditor key={JSON.stringify(billing.data.address)} value={billing.data} onRefresh={() => void billing.refetch()} />
  </Page>;
}

export function CardBillingEditor({ value, onRefresh }: { value: CardBillingAddressDto; onRefresh: () => void }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const countries = useCardBillingCountries();
  const save = useSaveCardBillingAddress();
  const [input, setInput] = useState<CardBillingAddressInput>({ countryId: value.address?.countryId ?? '', postalCode: value.address?.postalCode ?? '', address: value.address?.address ?? '' });
  const [touched, setTouched] = useState(false);
  const trimmed = { countryId: input.countryId, postalCode: input.postalCode.trim(), address: input.address.trim() };
  const knownCountry = countries.data?.some(country => country.id === input.countryId) ?? false;
  const valid = knownCountry && validCardBillingAddress(trimmed);

  if (value.status === 'pending') return <div className="stack">
    <Notice text={t('billing.pending')} />
    <Button title={t('common.refresh')} variant="secondary" onClick={onRefresh} />
  </div>;
  if (countries.error) return <QueryError error={countries.error} onRetry={() => void countries.refetch()} />;
  if (!countries.data) return <Loading />;

  return <div className="stack">
    <span className="muted">{t('billing.intro')}</span>
    {value.status === 'ready' && value.address ? <Notice text={t('billing.saved')} /> : null}
    <BillingAddressFields value={input} countries={countries.data} touched={touched} disabled={save.isPending}
      onChange={next => { save.reset(); setInput(next); }} />
    {save.error ? <Notice tone="danger" text={fmt.error(save.error)} /> : null}
    <Button title={t('billing.save')} loading={save.isPending} onClick={() => {
      setTouched(true);
      if (!valid) return;
      save.mutate(trimmed, { onSuccess: () => haptic.success(), onError: () => haptic.error() });
    }} />
  </div>;
}

export const billingPostalValid = (value: string) => /^[A-Za-z0-9 .-]{4,10}$/.test(value.trim());
export const billingAddressValid = (value: string) => value.trim().length > 0 && value.trim().length <= 200 && /^[\x20-\x7E]+$/.test(value.trim());

// Shared by the address screen and the manual card application. An empty
// country list means demo mode, where the country code is typed by hand.
export function BillingAddressFields({ value, countries, touched, disabled, onChange, withCountry = true }: {
  value: CardBillingAddressInput; countries: CardBillingCountryDto[]; touched: boolean; disabled: boolean;
  onChange: (value: CardBillingAddressInput) => void;
  /** The verification form asks the country once, with the documents. */
  withCountry?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const collator = new Intl.Collator(language, { sensitivity: 'base' });
  // ISO codes (manual issuance) are named in the interface language; provider ids keep the provider's name.
  const countryOptions = countries.map(country => /^[A-Z]{2}$/.test(country.id) ? { ...country, name: countryName(country.id, language) } : country)
    .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id, 'en'));
  const knownCountry = countries.length ? countries.some(country => country.id === value.countryId) : /^[A-Za-z0-9_-]{1,128}$/.test(value.countryId);
  return <>
    {!withCountry ? null : countries.length ? <label className="field">
      <span className="label muted">{t('billing.country')}</span>
      <div className="select-control">
        <select className="input" value={value.countryId} disabled={disabled} onChange={event => onChange({ ...value, countryId: event.target.value })}>
          <option value="">{t('billing.chooseCountry')}</option>
          {countryOptions.map(country => <option key={country.id} value={country.id}>{country.name}</option>)}
        </select>
        <span className="select-chevron"><Icon name="chevronDown" size={18} color="var(--muted)" /></span>
      </div>
      {touched && !knownCountry ? <span className="caption danger-text">{t('billing.chooseCountry')}</span> : null}
    </label> : <Field label={t('billing.country')} value={value.countryId} maxLength={128} disabled={disabled}
      onChange={event => onChange({ ...value, countryId: event.target.value.trim() })} error={touched && !knownCountry ? t('billing.chooseCountry') : null} />}
    <Field label={t('billing.postalCode')} value={value.postalCode} autoComplete="postal-code" maxLength={10} disabled={disabled}
      onChange={event => onChange({ ...value, postalCode: event.target.value })} error={touched && !billingPostalValid(value.postalCode) ? t('billing.invalidPostal') : null} />
    <Field label={t('billing.address')} value={value.address} autoComplete="street-address" maxLength={200} placeholder={t('billing.addressPlaceholder')}
      disabled={disabled} onChange={event => onChange({ ...value, address: event.target.value })}
      hint={t('billing.addressHint')} error={touched && !billingAddressValid(value.address) ? t('billing.invalidAddress') : null} />
  </>;
}
