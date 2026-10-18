import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import type { ActivityItemDto, CardBillingAddressInput, FeeWalletDto, WalletAsset } from '@gudex/shared';
import { Icon } from '../components/Icon';
import { Mascot } from '../components/Mascot';
import { ActivityRow, AssetPicker, LanguageSwitch } from '../components/misc';
import { BIOMETRY_ICON, PinCreateFlow, useBiometricEnrollment } from '../components/security';
import { Button, Field, Loading, Notice, Page, QueryError, Row, Segmented, Surface, Switch } from '../components/ui';
import { ApiError } from '../lib/api';
import { validCardBillingAddress } from '../lib/billing';
import { countryOptions } from '../lib/countries';
import { useFormat } from '../lib/format';
import { cardIssueFunding, cardIssueQuote, fundingEnabled } from '../lib/funding';
import { isKycBirthDateEligible, kycApplicantValidity, KYC_UPLOAD_MAX_BYTES, type KycDocumentType, type KycImageError, validateKycImage } from '../lib/kyc';
import { useActivity, useCardBillingCountries, useCards, useConfig, useIssueQuote, useKycRequirements, useMe, usePayApplicationFromBalance, useRecheckKyc, useSubmitCardApplication, useSubmitKyc, useUpdateLocale, useWallet } from '../lib/queries';
import { useSession } from '../lib/session';
import { useAdminAccess } from '../lib/admin';
import { haptic, platform } from '../lib/telegram';
import { CardDetails, useRevealDetails, walletName } from './Card';
import { BillingAddressFields } from './CardBilling';
import { FeePaymentPanel } from '../components/FeePayment';

// ─── История ─────────────────────────────────────────────────────────────

function groupByDay(items: ActivityItemDto[], formatDay: (iso: string) => string) {
  const groups: { day: string; items: ActivityItemDto[] }[] = [];
  for (const item of items) {
    const day = formatDay(item.createdAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

export function History() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const activity = useActivity(100);
  return (
    <Page title={t('history.title')} tabbar>
      {activity.error ? <QueryError error={activity.error} onRetry={() => void activity.refetch()} /> : null}
      {activity.isLoading ? (
        <Loading />
      ) : activity.data?.length ? (
        groupByDay(activity.data, fmt.day).map((group) => (
          <div key={group.day} className="stack" style={{ gap: 8 }}>
            <span className="label muted">{group.day}</span>
            <Surface>
              {group.items.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </Surface>
          </div>
        ))
      ) : activity.error ? null : (
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 24 }}>
          <Mascot pose="chill" size={220} />
          <span className="muted">{t('history.empty')}</span>
        </div>
      )}
    </Page>
  );
}

// ─── Профиль ─────────────────────────────────────────────────────────────

export function Profile() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = useSession();
  const enrollment = useBiometricEnrollment();
  const fmt = useFormat();
  const [securityError, setSecurityError] = useState<unknown>(null);
  const { data: me } = useMe();
  const adminAccess = useAdminAccess();
  const { data: config } = useConfig();
  const updateLocale = useUpdateLocale();
  const kycStatus = me?.kyc.status ?? 'none';
  const tg = me?.telegram;
  const name = me?.kyc.firstName ? `${me.kyc.firstName} ${me.kyc.lastName}` : [tg?.firstName, tg?.lastName].filter(Boolean).join(' ');

  return (
    <Page title={t('profile.title')} tabbar>
      <Surface className="row">
        <span className="avatar">{tg?.photoUrl ? <img src={tg.photoUrl} alt="" /> : <Icon name="user" color="var(--primary)" />}</span>
        <div className="stack-sm grow">
          <span className="body-medium ellipsis">{name || '—'}</span>
          {tg?.username ? <span className="muted">@{tg.username}</span> : null}
        </div>
      </Surface>

      <Surface flush>
        {adminAccess.data?.isAdmin === true && !adminAccess.isError ? <button className="list-item" onClick={() => navigate('/admin')}>
          <Icon name="shield" color="var(--primary)" />
          <span className="body-medium grow">Админка GUDEX</span>
          <Icon name="chevronRight" color="var(--muted)" size={18} />
        </button> : null}
        <button className="list-item" onClick={() => navigate('/kyc')}>
          <Icon name="shield" color={kycStatus === 'approved' ? 'var(--success)' : 'var(--primary)'} />
          <span className="body-medium grow">{t('profile.verification')}</span>
          <span className="muted">{t(`profile.kyc.${kycStatus}`)}</span>
          <Icon name="chevronRight" color="var(--muted)" size={18} />
        </button>
        {/* With manual issuance the address is part of the application and is entered in UPay by the operator. */}
        {kycStatus === 'approved' && config?.integration.issuanceMode !== 'manual' ? <button className="list-item" onClick={() => navigate('/card/billing')}>
          <Icon name="globe" color="var(--primary)" />
          <span className="body-medium grow">{t('billing.title')}</span>
          <Icon name="chevronRight" color="var(--muted)" size={18} />
        </button> : null}
      </Surface>

      <Surface flush>
        <button className="list-item" onClick={() => navigate('/referral')}>
          <Icon name="gift" color="var(--primary)" />
          <span className="body-medium grow">{t('profile.invite')}</span>
          <Icon name="chevronRight" color="var(--muted)" size={18} />
        </button>
        <button className="list-item" onClick={() => navigate('/tariffs')}>
          <Icon name="percent" color="var(--primary)" />
          <span className="body-medium grow">{t('profile.tariffs')}</span>
          <Icon name="chevronRight" color="var(--muted)" size={18} />
        </button>
        <button className="list-item" onClick={() => navigate('/help')}>
          <Icon name="help" color="var(--primary)" />
          <span className="body-medium grow">{t('profile.help')}</span>
          <Icon name="chevronRight" color="var(--muted)" size={18} />
        </button>
      </Surface>

      <h2 className="heading">{t('security.section')}</h2>
      <Surface flush>
        <button className="list-item" onClick={() => navigate('/pin/change')}>
          <Icon name="lock" color="var(--primary)" />
          <span className="body-medium grow">{t('security.pinRow')}</span>
          <span className="muted">{t('security.change')}</span>
          <Icon name="chevronRight" color="var(--muted)" size={18} />
        </button>
        {session.biometry ? (
          <div className="list-item">
            <Icon name={BIOMETRY_ICON[session.biometry]} color="var(--primary)" />
            <span className="body-medium grow">{t(`security.method.${session.biometry}`)}</span>
            <Switch
              on={session.biometricsEnabled}
              onChange={async (on) => {
                setSecurityError(null);
                try {
                  if (on) await enrollment.enable(t('security.enableReason'));
                  else await session.disableBiometrics();
                } catch (error) {
                  setSecurityError(error);
                }
              }}
            />
          </div>
        ) : null}
      </Surface>

      {securityError ? <Notice tone="danger" text={fmt.error(securityError)} /> : null}
      {enrollment.element}

      <Surface className="stack">
        <div className="row">
          <Icon name="globe" color="var(--primary)" />
          <span className="body-medium">{t('profile.language')}</span>
        </div>
        <LanguageSwitch onChange={(locale) => updateLocale.mutate(locale)} />
      </Surface>

      <span className="caption muted" style={{ textAlign: 'center' }}>
        {t('profile.version', { version: '0.2.0' })}
      </span>
    </Page>
  );
}

export function PinChange() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [done, setDone] = useState(false);
  return (
    <Page>
      {done ? (
        <div className="center-screen">
          <span className="icon-circle" style={{ width: 80, height: 80 }}>
            <Icon name="check" color="var(--success)" size={40} />
          </span>
          <h1 className="title">{t('security.changed')}</h1>
          <div style={{ width: '100%', maxWidth: 320 }}>
            <Button title={t('common.continue')} onClick={() => navigate(-1)} />
          </div>
        </div>
      ) : (
        <div className="center-screen">
          <PinCreateFlow
            requireCurrent
            onDone={() => {
              haptic.success();
              setDone(true);
            }}
          />
        </div>
      )}
    </Page>
  );
}

// ─── Верификация ─────────────────────────────────────────────────────────

// "01.02.1990" → "1990-02-01"; null, если дата некорректна.
function parseDate(input: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(input);
  if (!m) return null;
  const [, d, mo, y] = m;
  const iso = `${y}-${mo}-${d}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return date.getUTCDate() === Number(d) && date.getUTCMonth() + 1 === Number(mo) ? iso : null;
}

const maskDate = (input: string) => {
  const digits = input.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('.');
};

// The fee for a saved application: from the balance when it already holds it (a refund, a payment confirmed late),
// otherwise to an app wallet address lent to this client.
function ApplicationPayment({ feeWallet, onDone }: { feeWallet: FeeWalletDto; onDone: () => void }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const wallet = useWallet();
  const pay = usePayApplicationFromBalance();
  if (wallet.error && !wallet.data) return <Page title={t('fee.payTitle')}><QueryError error={wallet.error} onRetry={() => void wallet.refetch()} /></Page>;
  if (!wallet.data) return <Loading />;
  const covering = wallet.data.balances.find(balance => Number(balance.amount) >= Number(feeWallet.fee));
  return <Page title={t('fee.payTitle')}>
    {covering ? <>
      <Notice text={t('fee.balanceReady', { amount: feeWallet.fee, asset: covering.asset })} />
      {pay.error ? <Notice tone="danger" text={fmt.error(pay.error)} /> : null}
      <Button title={t('fee.payFromBalance', { amount: feeWallet.fee, asset: covering.asset })} loading={pay.isPending}
        onClick={() => pay.mutate(covering.asset, { onSuccess: () => { haptic.success(); onDone(); }, onError: () => haptic.error() })} />
    </> : <>
      <Notice text={t('fee.payText')} />
      <FeePaymentPanel wallet={feeWallet} onPaid={onDone} />
    </>}
  </Page>;
}

export function Kyc() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const meQuery = useMe();
  const recheck = useRecheckKyc();
  const cards = useCards();
  const { data: config } = useConfig();
  const { data: me, isLoading } = meQuery;
  if (meQuery.error && !me) return <Page title={t('kyc.title')}><QueryError error={meQuery.error} onRetry={() => void meQuery.refetch()} /></Page>;
  if (isLoading || !me) return <Loading />;
  const status = me.kyc.status;
  const feeWallet = config?.integration.feeWallet ?? null;
  // A saved application waits for the fee: until it arrives there is no reserved card yet.
  if (feeWallet && status === 'pending' && me.kyc.submissionState === 'manual_review') {
    if (!cards.data) return cards.error ? <Page title={t('kyc.applicationTitle')}><QueryError error={cards.error} onRetry={() => void cards.refetch()} /></Page> : <Loading />;
    if (!cards.data.some(card => card.status === 'pending' && card.pendingFulfillmentMode === 'manual')) {
      return <ApplicationPayment feeWallet={feeWallet} onDone={() => { void cards.refetch(); void meQuery.refetch(); }} />;
    }
  }

  const unknown = status === 'unknown' || me.kyc.submissionState === 'unknown';
  if (status === 'pending' || status === 'approved' || unknown) {
    const approved = status === 'approved';
    // Every client has one card: once it exists there is nothing more to issue.
    const hasCard = Boolean(cards.data?.some(card => card.status === 'pending' || card.status === 'active' || card.status === 'frozen'));
    // A manual application is complete for the client: an operator issues the card.
    const sent = !approved && !unknown && me.kyc.submissionState === 'manual_review';
    return (
      <Page title={t(sent ? 'kyc.applicationTitle' : 'kyc.title')}>
        <Surface className="stack">
          <div className="stack" style={{ alignItems: 'center', textAlign: 'center', padding: '24px 0', gap: 12 }}>
            {approved ? <Mascot pose="success" size={200} motion="pop" /> : sent ? <Mascot pose="card" size={200} motion="pop" /> : <Mascot pose="thinking" size={200} />}
            <h2 className="heading">{approved ? t('kyc.approvedTitle') : unknown ? t('kyc.unknownTitle') : sent ? t('kyc.applicationSentTitle') : t('kyc.pendingTitle')}</h2>
            <span className="muted">{approved ? t('kyc.approvedText') : unknown ? t('kyc.unknownText') : sent ? t('kyc.applicationSentText') : t('kyc.pendingText')}</span>
          </div>
        </Surface>
        {unknown ? <Button variant="secondary" title={t('common.refresh')} loading={recheck.isPending} onClick={() => recheck.mutate()} /> : null}
        {recheck.error ? <QueryError error={recheck.error} onRetry={() => recheck.mutate()} /> : null}
        {meQuery.error ? <QueryError error={meQuery.error} onRetry={() => void meQuery.refetch()} /> : null}
        {approved && !hasCard ? <Button title={t('home.getCard')} icon="card" onClick={() => navigate('/card/issue', { replace: true })} /> : null}
        {approved && hasCard ? <Button title={t('home.card')} icon="card" variant="secondary" onClick={() => navigate('/card', { replace: true })} /> : null}
        {sent ? <Button title={t('home.card')} icon="card" variant="secondary" onClick={() => navigate('/card', { replace: true })} /> : null}
      </Page>
    );
  }
  return <KycForm rejectionReason={status === 'rejected' ? me.kyc.rejectionReason : null} />;
}

function KycImageField({ label, maxBytes, file, onChange, required, touched, disabled, selfie }: {
  label: string;
  maxBytes: number;
  file: File | null;
  onChange: (file: File | null) => void;
  required: boolean;
  touched: boolean;
  disabled: boolean;
  selfie?: boolean;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<KycImageError | null>(null);
  const selection = useRef(0);
  return <Field
    label={label}
    type="file"
    accept="image/jpeg,image/png"
    capture={selfie ? 'user' : undefined}
    disabled={disabled}
    hint={t('kyc.fileHint', { size: Math.floor(maxBytes / 1024 / 1024) })}
    error={error ? t(`kyc.${error}`) : touched && required && !file ? t('kyc.fileRequired') : null}
    onChange={async (event) => {
      const input = event.currentTarget;
      const selected = input.files?.[0] ?? null;
      const version = ++selection.current;
      onChange(null);
      setError(null);
      if (!selected) return;
      let invalid: KycImageError | null;
      try { invalid = await validateKycImage(selected, maxBytes); }
      catch { invalid = 'fileContent'; }
      if (version !== selection.current) return;
      setError(invalid);
      if (invalid) input.value = '';
      else onChange(selected);
    }}
  />;
}

function KycForm({ rejectionReason }: { rejectionReason: string | null }) {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const submit = useSubmitKyc();
  const apply = useSubmitCardApplication();
  const config = useConfig();
  const requirements = useKycRequirements();
  // Manual issuance: the same form also takes the billing address and reserves the issuance fee.
  const application = config.data?.integration.issuanceMode === 'manual';
  const wallet = useWallet();
  const [asset, setAsset] = useState<WalletAsset>('USDT');
  const quoteQuery = useIssueQuote(asset, application);
  const billingCountries = useCardBillingCountries(application);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const countries = useMemo(() => countryOptions(language), [language]);
  const idempotencyKey = useRef(crypto.randomUUID()).current;
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [citizenship, setCitizenship] = useState<string | null>(null);
  const [globalCode, setGlobalCode] = useState('+7');
  const [phone, setPhone] = useState('');
  const [documentType, setDocumentType] = useState<KycDocumentType>('passport');
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [billing, setBilling] = useState<CardBillingAddressInput>({ countryId: '', postalCode: '', address: '' });
  const [touched, setTouched] = useState(false);
  const fee = application ? config.data?.integration.feeWallet?.fee ?? null : null;
  useEffect(() => {
    // Only when this coin would be paid from the wallet: a broker-covered issuance stays as it is.
    if (!fee || !wallet.data || !quoteQuery.data || quoteQuery.data.asset !== asset || quoteQuery.data.fundingSource === 'broker') return;
    const covers = (coin: WalletAsset) => Number(wallet.data!.balances.find(balance => balance.asset === coin)?.amount ?? 0) >= Number(fee);
    if (covers(asset)) return;
    const other = wallet.data.balances.map(balance => balance.asset).find(covers);
    if (other) setAsset(other);
  }, [fee, wallet.data, quoteQuery.data]);

  if (requirements.error && !requirements.data) return <Page title={t('kyc.title')}><QueryError error={requirements.error} onRetry={() => void requirements.refetch()} /></Page>;
  if (config.error && !config.data) return <Page title={t('kyc.title')}><QueryError error={config.error} onRetry={() => void config.refetch()} /></Page>;
  if (!requirements.data || !config.data) return <Loading />;
  if (application && billingCountries.error && !billingCountries.data) return <Page title={t('kyc.applicationTitle')}><QueryError error={billingCountries.error} onRetry={() => void billingCountries.refetch()} /></Page>;
  if (application && wallet.error && !wallet.data) return <Page title={t('kyc.applicationTitle')}><QueryError error={wallet.error} onRetry={() => void wallet.refetch()} /></Page>;
  if (application && (!billingCountries.data || !wallet.data)) return <Loading />;
  const rules = requirements.data;
  const type = rules.documentTypes.includes(documentType) ? documentType : rules.documentTypes[0] ?? 'passport';
  const maxBytes = Math.min(rules.maxUploadBytes, KYC_UPLOAD_MAX_BYTES);
  const enabled = config.data.integration.capabilities.kyc && rules.enabled;
  const contactsRequired = rules.live || application;
  const pending = submit.isPending || apply.isPending;

  const isoDate = parseDate(birthDate);
  const birthDateEligible = isoDate !== null && isKycBirthDateEligible(isoDate);
  const ok = kycApplicantValidity({ firstName, lastName, email, phone, globalCode }, contactsRequired);
  const documentsValid = !rules.documentsRequired || (front !== null && (type === 'passport' || back !== null));
  // One country answers citizenship, the document's country and the address country.
  const billingInput = { countryId: citizenship ?? '', postalCode: billing.postalCode.trim(), address: billing.address.trim() };
  const billingValid = !application || (billingCountries.data!.length ? billingCountries.data!.some(country => country.id === billingInput.countryId) : billingInput.countryId !== '')
    && validCardBillingAddress(billingInput);
  const quote = application ? cardIssueQuote(asset, quoteQuery.data) : null;
  const quoteReady = quote !== null && !quoteQuery.isFetching && !quoteQuery.isStale && !quoteQuery.error;
  const brokerFunded = quoteReady && quote.fundingSource === 'broker';
  const funding = application ? cardIssueFunding(wallet.data!, asset, quoteQuery.data) : { enough: true, shortage: null };
  const noFunds = apply.error instanceof ApiError && apply.error.code === 'insufficient_funds';
  const needsFunds = application && quoteReady && !brokerFunded && (!funding.enough || noFunds);
  const canDeposit = fundingEnabled(config.data.integration.deposits);
  // Manual issuance: a balance that covers the fee pays at once; otherwise the app wallet address comes after submitting.
  const feeWallet = application ? config.data.integration.feeWallet ?? null : null;
  const payFromBalance = application && quoteReady && (brokerFunded || funding.enough);
  const paymentReady = !application || payFromBalance || feeWallet !== null;
  const valid = ok.first && ok.last && ok.email && birthDateEligible && citizenship !== null && (!contactsRequired || ok.phone) && documentsValid
    && (!rules.selfieRequired || selfie !== null) && billingValid;
  const error = application ? apply.error : submit.error;
  const fundsNotice = needsFunds ? <Notice tone="warning"
    text={funding.shortage && funding.shortage !== '0' ? t('kyc.applicationFunds', { amount: funding.shortage, asset }) : t('errors.insufficient_funds')}
    action={canDeposit ? <Button small variant="ghost" title={t('home.deposit')}
      onClick={() => navigate(`/deposit?asset=${asset}&amount=${encodeURIComponent(funding.shortage ?? '')}&returnTo=issue`)} /> : undefined} /> : null;

  const countryField = <label className="field">
    <span className="label muted">{t('kyc.citizenship')}</span>
    <div className="select-control">
      <select className="input" value={citizenship ?? ''} disabled={pending} onChange={(event) => { haptic.select(); setCitizenship(event.target.value || null); }}>
        <option value="">{t('kyc.chooseCountry')}</option>
        {countries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
      </select>
      <span className="select-chevron"><Icon name="chevronDown" size={18} color="var(--muted)" /></span>
    </div>
    {touched && !citizenship ? <span className="caption danger-text">{t('kyc.chooseCountry')}</span> : null}
  </label>;

  return (
    <Page title={t(application ? 'kyc.applicationTitle' : 'kyc.title')}>
      {rejectionReason ? (
        <>
          <Mascot pose="sad" size={150} motion="pop" />
          <Notice tone="danger" text={`${t('kyc.rejectedTitle')}: ${rejectionReason}`} />
        </>
      ) : null}
      {!enabled ? <Notice tone="warning" text={t('kyc.unavailable')} /> : null}
      {feeWallet ? null : <>
        {fundsNotice}
        {needsFunds && !canDeposit ? <Notice tone="warning" text={t('deposit.unavailable')} /> : null}
      </>}
      {application ? <h2 className="heading">{t('kyc.applicationPersonal')}</h2> : null}
      <Field
        label={t('kyc.firstName')}
        value={firstName}
        onChange={(e) => setFirstName(e.target.value.toUpperCase())}
        autoCapitalize="characters"
        autoCorrect="off"
        placeholder="IVAN"
        error={touched && !ok.first ? t('kyc.invalidName') : null}
      />
      <Field
        label={t('kyc.lastName')}
        value={lastName}
        onChange={(e) => setLastName(e.target.value.toUpperCase())}
        autoCapitalize="characters"
        autoCorrect="off"
        placeholder="IVANOV"
        error={touched && !ok.last ? t('kyc.invalidName') : null}
      />
      <Field
        label={t('kyc.email')}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        error={touched && !ok.email ? t('kyc.invalidEmail') : null}
      />
      {contactsRequired ? <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ width: 110 }}><Field label={t('kyc.globalCode')} value={globalCode} type="tel" inputMode="tel" autoComplete="tel-country-code"
          onChange={(event) => setGlobalCode(`+${event.target.value.replace(/\D/g, '').slice(0, 4)}`)} disabled={pending} placeholder="+7" /></div>
        <div className="grow"><Field label={t('kyc.phone')} value={phone} type="tel" inputMode="tel" autoComplete="tel-national"
          onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 15))} disabled={pending} placeholder="7011234567"
          error={touched && !ok.phone ? t('kyc.invalidPhone') : null} /></div>
      </div> : null}
      <Field
        label={t('kyc.birthDate')}
        value={birthDate}
        onChange={(e) => setBirthDate(maskDate(e.target.value))}
        inputMode="numeric"
        placeholder={t('kyc.birthDatePlaceholder')}
        error={touched && !isoDate ? t('kyc.invalidDate') : touched && !birthDateEligible ? t('kyc.invalidAge') : null}
      />
      {rules.documentsRequired ? null : countryField}
      {application ? <BillingAddressFields value={billing} countries={billingCountries.data!} touched={touched} disabled={pending} withCountry={false}
        onChange={(next) => { apply.reset(); setBilling(next); }} /> : null}
      {rules.documentsRequired ? <>
        {application ? <h2 className="heading">{t('kyc.applicationDocuments')}</h2> : null}
        {countryField}
        <span className="label muted">{t('kyc.documentType')}</span>
        <Segmented<KycDocumentType> options={rules.documentTypes.map((value) => ({ value, label: t(`kyc.${value}`) }))} value={type} onChange={(value) => {
          if (pending || value === type) return;
          setDocumentType(value);
          setFront(null);
          setBack(null);
        }} />
        <KycImageField key={`${type}-front`} label={type === 'passport' ? t('kyc.passportPhoto') : type === 'driving_license' ? t('kyc.licenseFront') : t('kyc.documentFront')} maxBytes={maxBytes} file={front} onChange={setFront} required touched={touched} disabled={pending} />
        {type !== 'passport' ? <KycImageField key={`${type}-back`} label={type === 'driving_license' ? t('kyc.licenseBack') : t('kyc.documentBack')} maxBytes={maxBytes} file={back} onChange={setBack} required touched={touched} disabled={pending} /> : null}
      </> : null}
      {rules.selfieRequired ? <KycImageField label={t('kyc.selfie')} maxBytes={maxBytes} file={selfie} onChange={setSelfie} required touched={touched} disabled={pending} selfie /> : null}
      {application ? <>
        <h2 className="heading">{t('kyc.applicationPayment')}</h2>
        {feeWallet && !payFromBalance ? <Notice text={t('fee.payLater', { fee: feeWallet.fee })} /> : <>
        {brokerFunded ? <Notice text={t('issue.brokerFunded')} /> : <>
          <span className="label muted">{t('issue.payFrom')}</span>
          <AssetPicker wallet={wallet.data} value={asset} onChange={(value) => { apply.reset(); setAsset(value); }} />
        </>}
        <Surface className="stack">
          <Row label={t('issue.fee')} value={quoteReady ? fmt.amount(quote.fee, 'USD') : '—'} />
          <Row label={t('issue.total')} value={quoteReady ? fmt.amount(quote.customerCharge, asset) : '—'} strong />
        </Surface>
        <span className="caption muted">{t('kyc.applicationPaymentHint')}</span>
        {quoteQuery.error ? <QueryError error={quoteQuery.error} onRetry={() => void quoteQuery.refetch()} /> : null}
        {feeWallet ? null : fundsNotice}
        </>}
      </> : null}
      {error && !(application && noFunds && !brokerFunded) ? <Notice tone="danger" text={fmt.error(error)} /> : null}
      <Button
        title={application ? payFromBalance && !brokerFunded ? t('kyc.applicationSubmit', { amount: quote!.customerCharge, asset }) : t('kyc.applicationSubmitFree') : t('kyc.submit')}
        loading={pending || (application && quoteQuery.isFetching)}
        disabled={!enabled || !paymentReady}
        onClick={() => {
          setTouched(true);
          if (!valid) return haptic.error();
          const kyc = {
            firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), birthDate: isoDate!, citizenship: citizenship!,
            ...(contactsRequired ? { phone, globalCode } : {}),
            ...(rules.documentsRequired ? { documentType: type, documentCountry: citizenship! } : {}),
            ...(rules.documentsRequired || rules.selfieRequired ? { documents: { ...(front ? { front } : {}), ...(type !== 'passport' && back ? { back } : {}), ...(selfie ? { selfie } : {}) } } : {}),
          };
          if (!application) return submit.mutate(kyc);
          apply.mutate({ kyc, billing: billingInput, asset, idempotencyKey, ...(payFromBalance ? { expectedFundingSource: quote!.fundingSource, expectedCustomerCharge: quote!.customerCharge } : {}) },
            { onSuccess: () => haptic.success(), onError: () => haptic.error() });
        }}
      />
    </Page>
  );
}

// ─── Apple Pay / Google Pay ──────────────────────────────────────────────

export function WalletPay() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { data: config } = useConfig();
  const reveal = useRevealDetails(params.get('cardId') ?? '');
  const fmt = useFormat();
  const android = platform === 'android';
  const steps = android
    ? [t('walletPay.android1'), t('walletPay.android2'), t('walletPay.android3'), t('walletPay.android4')]
    : [t('walletPay.ios1'), t('walletPay.ios2'), t('walletPay.ios3'), t('walletPay.ios4')];

  return (
    <Page title={walletName}>
      <Mascot pose="pay" size={200} motion="pop" />
      <span>{t('walletPay.intro', { wallet: walletName })}</span>
      <Surface className="stack">
        {steps.map((step, i) => (
          <div key={step} className="row" style={{ alignItems: 'flex-start' }}>
            <span className="step-number">{i + 1}</span>
            <span style={{ paddingTop: 3 }}>{step}</span>
          </div>
        ))}
      </Surface>
      {reveal.details ? (
        <CardDetails details={reveal.details} />
      ) : (
        <Button title={t('walletPay.showDetails')} icon="lock" variant="secondary" loading={reveal.loading} onClick={reveal.reveal} />
      )}
      {config?.devTools ? <Notice tone="warning" icon="flask" text={t('walletPay.testCard', { wallet: walletName })} /> : null}
      {reveal.error ? <Notice tone="danger" text={fmt.error(reveal.error)} /> : null}
      <Notice text={t('walletPay.inAppNote', { wallet: walletName })} />
      {reveal.element}
    </Page>
  );
}
