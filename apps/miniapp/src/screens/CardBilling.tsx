import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CardBillingAddressDto } from '@gudex/shared';
import { Icon } from '../components/Icon';
import { Button, Field, Loading, Notice, Page, QueryError } from '../components/ui';
import { validCardBillingAddress } from '../lib/billing';
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
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const countries = useCardBillingCountries();
  const save = useSaveCardBillingAddress();
  const [countryId, setCountryId] = useState(value.address?.countryId ?? '');
  const [postalCode, setPostalCode] = useState(value.address?.postalCode ?? '');
  const [address, setAddress] = useState(value.address?.address ?? '');
  const [touched, setTouched] = useState(false);
  const input = { countryId, postalCode: postalCode.trim(), address: address.trim() };
  const knownCountry = countries.data?.some(country => country.id === countryId) ?? false;
  const valid = knownCountry && validCardBillingAddress(input);
  const pending = value.status === 'pending';
  const postalValid = /^[A-Za-z0-9 .-]{4,10}$/.test(input.postalCode);
  const addressValid = input.address.length > 0 && input.address.length <= 200 && /^[\x20-\x7E]+$/.test(input.address);

  if (pending) return <div className="stack">
    <Notice text={t('billing.pending')} />
    <Button title={t('common.refresh')} variant="secondary" onClick={onRefresh} />
  </div>;
  if (countries.error) return <QueryError error={countries.error} onRetry={() => void countries.refetch()} />;
  if (!countries.data) return <Loading />;
  const collator = new Intl.Collator(i18n.resolvedLanguage ?? i18n.language, { sensitivity: 'base' });
  const countryOptions = [...countries.data].sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id, 'en'));

  return <div className="stack">
    <span className="muted">{t('billing.intro')}</span>
    {value.status === 'ready' && value.address ? <Notice text={t('billing.saved')} /> : null}
    <label className="field">
      <span className="label muted">{t('billing.country')}</span>
      <div className="select-control">
        <select className="input" value={countryId} disabled={save.isPending} onChange={event => { save.reset(); setCountryId(event.target.value); }}>
          <option value="">{t('billing.chooseCountry')}</option>
          {countryOptions.map(country => <option key={country.id} value={country.id}>{country.name}</option>)}
        </select>
        <span className="select-chevron"><Icon name="chevronDown" size={18} color="var(--muted)" /></span>
      </div>
      {touched && !knownCountry ? <span className="caption danger-text">{t('billing.chooseCountry')}</span> : null}
    </label>
    <Field label={t('billing.postalCode')} value={postalCode} autoComplete="postal-code" maxLength={10} disabled={save.isPending}
      onChange={event => { save.reset(); setPostalCode(event.target.value); }} error={touched && !postalValid ? t('billing.invalidPostal') : null} />
    <Field label={t('billing.address')} value={address} autoComplete="street-address" maxLength={200} placeholder={t('billing.addressPlaceholder')}
      disabled={save.isPending} onChange={event => { save.reset(); setAddress(event.target.value); }}
      hint={t('billing.addressHint')} error={touched && !addressValid ? t('billing.invalidAddress') : null} />
    {save.error ? <Notice tone="danger" text={fmt.error(save.error)} /> : null}
    <Button title={t('billing.save')} loading={save.isPending} onClick={() => {
      setTouched(true);
      if (!valid) return;
      save.mutate(input, { onSuccess: () => haptic.success(), onError: () => haptic.error() });
    }} />
  </div>;
}
