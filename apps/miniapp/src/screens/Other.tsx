import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import type { ActivityItemDto } from '@gudex/shared';
import { Icon } from '../components/Icon';
import { Mascot } from '../components/Mascot';
import { ActivityRow, LanguageSwitch } from '../components/misc';
import { BIOMETRY_ICON, PinCreateFlow, useBiometricEnrollment } from '../components/security';
import { Button, Field, Loading, Notice, Page, QueryError, Segmented, Surface, Switch } from '../components/ui';
import { COUNTRIES } from '../lib/countries';
import { useFormat } from '../lib/format';
import { isKycBirthDateEligible, kycApplicantValidity, KYC_UPLOAD_MAX_BYTES, type KycDocumentType, type KycImageError, validateKycImage } from '../lib/kyc';
import { useActivity, useConfig, useKycRequirements, useMe, useRecheckKyc, useSubmitKyc, useUpdateLocale } from '../lib/queries';
import { useSession } from '../lib/session';
import { useAdminAccess } from '../lib/admin';
import { haptic, platform } from '../lib/telegram';
import { CardDetails, useRevealDetails, walletName } from './Card';

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
        {kycStatus === 'approved' ? <button className="list-item" onClick={() => navigate('/card/billing')}>
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

export function Kyc() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const meQuery = useMe();
  const recheck = useRecheckKyc();
  const { data: me, isLoading } = meQuery;
  if (meQuery.error && !me) return <Page title={t('kyc.title')}><QueryError error={meQuery.error} onRetry={() => void meQuery.refetch()} /></Page>;
  if (isLoading || !me) return <Loading />;
  const status = me.kyc.status;

  const unknown = status === 'unknown' || me.kyc.submissionState === 'unknown';
  if (status === 'pending' || status === 'approved' || unknown) {
    const approved = status === 'approved';
    return (
      <Page title={t('kyc.title')}>
        <Surface className="stack">
          <div className="stack" style={{ alignItems: 'center', textAlign: 'center', padding: '24px 0', gap: 12 }}>
            {approved ? <Mascot pose="success" size={200} motion="pop" /> : <Mascot pose="thinking" size={200} />}
            <h2 className="heading">{approved ? t('kyc.approvedTitle') : unknown ? t('kyc.unknownTitle') : t('kyc.pendingTitle')}</h2>
            <span className="muted">{approved ? t('kyc.approvedText') : unknown ? t('kyc.unknownText') :
              t(me.kyc.submissionState === 'manual_review' ? 'kyc.manualPendingText' : 'kyc.pendingText')}</span>
          </div>
        </Surface>
        {unknown ? <Button variant="secondary" title={t('common.refresh')} loading={recheck.isPending} onClick={() => recheck.mutate()} /> : null}
        {recheck.error ? <QueryError error={recheck.error} onRetry={() => recheck.mutate()} /> : null}
        {meQuery.error ? <QueryError error={meQuery.error} onRetry={() => void meQuery.refetch()} /> : null}
        {approved ? <Button title={t('home.getCard')} icon="card" onClick={() => navigate('/card/issue', { replace: true })} /> : null}
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
  const submit = useSubmitKyc();
  const config = useConfig();
  const requirements = useKycRequirements();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [citizenship, setCitizenship] = useState<string | null>(null);
  const [globalCode, setGlobalCode] = useState('+7');
  const [phone, setPhone] = useState('');
  const [documentType, setDocumentType] = useState<KycDocumentType>('passport');
  const [documentCountry, setDocumentCountry] = useState('');
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);

  if (requirements.error && !requirements.data) return <Page title={t('kyc.title')}><QueryError error={requirements.error} onRetry={() => void requirements.refetch()} /></Page>;
  if (config.error && !config.data) return <Page title={t('kyc.title')}><QueryError error={config.error} onRetry={() => void config.refetch()} /></Page>;
  if (!requirements.data || !config.data) return <Loading />;
  const rules = requirements.data;
  const type = rules.documentTypes.includes(documentType) ? documentType : rules.documentTypes[0] ?? 'passport';
  const maxBytes = Math.min(rules.maxUploadBytes, KYC_UPLOAD_MAX_BYTES);
  const enabled = config.data.integration.capabilities.kyc && rules.enabled;

  const isoDate = parseDate(birthDate);
  const birthDateEligible = isoDate !== null && isKycBirthDateEligible(isoDate);
  const ok = kycApplicantValidity({ firstName, lastName, email, phone, globalCode }, rules.live);
  const documentsValid = !rules.documentsRequired || (documentCountry !== '' && front !== null && (type !== 'id_card' || back !== null));
  const valid = ok.first && ok.last && ok.email && birthDateEligible && citizenship !== null && (!rules.live || ok.phone) && documentsValid && (!rules.selfieRequired || selfie !== null);

  return (
    <Page title={t('kyc.title')}>
      {rejectionReason ? (
        <>
          <Mascot pose="sad" size={150} motion="pop" />
          <Notice tone="danger" text={`${t('kyc.rejectedTitle')}: ${rejectionReason}`} />
        </>
      ) : null}
      {!enabled ? <Notice tone="warning" text={t('kyc.unavailable')} /> : null}
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
      {rules.live ? <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ width: 110 }}><Field label={t('kyc.globalCode')} value={globalCode} type="tel" inputMode="tel" autoComplete="tel-country-code"
          onChange={(event) => setGlobalCode(`+${event.target.value.replace(/\D/g, '').slice(0, 4)}`)} disabled={submit.isPending} placeholder="+7" /></div>
        <div className="grow"><Field label={t('kyc.phone')} value={phone} type="tel" inputMode="tel" autoComplete="tel-national"
          onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 15))} disabled={submit.isPending} placeholder="7011234567"
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
      <div className="stack-sm">
        <span className="label muted">{t('kyc.citizenship')}</span>
        <Surface flush>
          {COUNTRIES.map((country) => (
            <button
              key={country.code}
              className="list-item"
              style={country.code === citizenship ? { background: 'var(--surface-2)' } : undefined}
              onClick={() => {
                haptic.select();
                setCitizenship(country.code);
              }}
            >
              <span className="grow">{i18n.language === 'en' ? country.en : country.ru}</span>
              {country.code === citizenship ? <Icon name="check" color="var(--primary)" size={20} /> : null}
            </button>
          ))}
        </Surface>
        {touched && !citizenship ? <span className="caption danger-text">{t('errors.validation')}</span> : null}
      </div>
      {rules.documentsRequired ? <>
        <span className="label muted">{t('kyc.documentType')}</span>
        <Segmented<KycDocumentType> options={rules.documentTypes.map((value) => ({ value, label: t(`kyc.${value}`) }))} value={type} onChange={(value) => {
          if (submit.isPending || value === type) return;
          setDocumentType(value);
          setFront(null);
          setBack(null);
        }} />
        <label className="field">
          <span className="label muted">{t('kyc.documentCountry')}</span>
          <div className="select-control">
            <select className="input" value={documentCountry} disabled={submit.isPending} onChange={(event) => setDocumentCountry(event.target.value)}>
              <option value="">{t('kyc.chooseCountry')}</option>
              {COUNTRIES.map((country) => <option key={country.code} value={country.code}>{i18n.language === 'en' ? country.en : country.ru}</option>)}
            </select>
            <span className="select-chevron"><Icon name="chevronDown" size={18} color="var(--muted)" /></span>
          </div>
          {touched && !documentCountry ? <span className="caption danger-text">{t('errors.validation')}</span> : null}
        </label>
        <KycImageField key={`${type}-front`} label={type === 'passport' ? t('kyc.passportPhoto') : t('kyc.documentFront')} maxBytes={maxBytes} file={front} onChange={setFront} required touched={touched} disabled={submit.isPending} />
        {type === 'id_card' ? <KycImageField label={t('kyc.documentBack')} maxBytes={maxBytes} file={back} onChange={setBack} required touched={touched} disabled={submit.isPending} /> : null}
      </> : null}
      {rules.selfieRequired ? <KycImageField label={t('kyc.selfie')} maxBytes={maxBytes} file={selfie} onChange={setSelfie} required touched={touched} disabled={submit.isPending} selfie /> : null}
      {rules.documentsRequired || rules.selfieRequired ? <span className="caption muted">{t('kyc.photosPrivacy')}</span> : null}
      {submit.error ? <Notice tone="danger" text={fmt.error(submit.error)} /> : null}
      <Button
        title={t('kyc.submit')}
        loading={submit.isPending}
        disabled={!enabled}
        onClick={() => {
          setTouched(true);
          if (!valid) return haptic.error();
          submit.mutate({
            firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), birthDate: isoDate!, citizenship: citizenship!,
            ...(rules.live ? { phone, globalCode } : {}),
            ...(rules.documentsRequired ? { documentType: type, documentCountry } : {}),
            ...(rules.documentsRequired || rules.selfieRequired ? { documents: { ...(front ? { front } : {}), ...(type === 'id_card' && back ? { back } : {}), ...(selfie ? { selfie } : {}) } } : {}),
          });
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
