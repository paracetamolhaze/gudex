import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Icon } from '../../components/Icon';
import { AppText, Button, Field, Loading, Notice, Screen, Surface } from '../../components/ui';
import { COUNTRIES } from '../../lib/countries';
import { useFormat } from '../../lib/format';
import { useMe, useSubmitKyc } from '../../lib/queries';
import { space, useColors } from '../../theme';

const LATIN = /^[A-Za-z][A-Za-z '-]{0,48}$/;

// "01.02.1990" → "1990-02-01"; null, если дата некорректна.
function parseDate(input: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(input);
  if (!m) return null;
  const [, d, mo, y] = m;
  const iso = `${y}-${mo}-${d}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return date.getUTCDate() === Number(d) && date.getUTCMonth() + 1 === Number(mo) ? iso : null;
}

// Маска ДД.ММ.ГГГГ: точки подставляются сами.
function maskDate(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('.');
}

export default function Kyc() {
  const { t } = useTranslation();
  const c = useColors();
  const { data: me, isLoading } = useMe();

  if (isLoading || !me) return <Loading />;
  const status = me.kyc.status;

  if (status === 'pending' || status === 'approved') {
    const approved = status === 'approved';
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: t('kyc.title') }} />
        <Surface style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xxl }}>
          {approved ? <Icon name="shield" color={c.success} size={48} /> : <ActivityIndicator color={c.primary} size="large" />}
          <AppText variant="heading">{approved ? t('kyc.approvedTitle') : t('kyc.pendingTitle')}</AppText>
          <AppText muted style={{ textAlign: 'center' }}>
            {approved ? t('kyc.approvedText') : t('kyc.pendingText')}
          </AppText>
        </Surface>
        {approved ? <Button title={t('home.getCard')} icon="card" onPress={() => router.replace('/card-issue')} /> : null}
      </Screen>
    );
  }

  return <KycForm rejectionReason={status === 'rejected' ? me.kyc.rejectionReason : null} />;
}

function KycForm({ rejectionReason }: { rejectionReason: string | null }) {
  const fmt = useFormat();
  const { t, i18n } = useTranslation();
  const c = useColors();
  const submit = useSubmitKyc();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [citizenship, setCitizenship] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const isoDate = parseDate(birthDate);
  const firstNameOk = LATIN.test(firstName.trim());
  const lastNameOk = LATIN.test(lastName.trim());
  const valid = firstNameOk && lastNameOk && isoDate !== null && citizenship !== null;

  const onSubmit = () => {
    setTouched(true);
    if (!valid) return;
    submit.mutate({ firstName: firstName.trim(), lastName: lastName.trim(), birthDate: isoDate!, citizenship: citizenship! });
  };

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: t('kyc.title') }} />
      {rejectionReason ? <Notice tone="danger" text={`${t('kyc.rejectedTitle')}: ${rejectionReason}`} /> : null}
      <AppText muted>{t('kyc.intro')}</AppText>

      <Field
        label={t('kyc.firstName')}
        value={firstName}
        onChangeText={setFirstName}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="IVAN"
        error={touched && !firstNameOk ? t('kyc.invalidName') : null}
      />
      <Field
        label={t('kyc.lastName')}
        value={lastName}
        onChangeText={setLastName}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="IVANOV"
        error={touched && !lastNameOk ? t('kyc.invalidName') : null}
      />
      <Field
        label={t('kyc.birthDate')}
        value={birthDate}
        onChangeText={(v) => setBirthDate(maskDate(v))}
        keyboardType="number-pad"
        placeholder={t('kyc.birthDatePlaceholder')}
        error={touched && !isoDate ? t('kyc.invalidDate') : null}
      />

      <View style={{ gap: space.xs }}>
        <AppText variant="label" muted>
          {t('kyc.citizenship')}
        </AppText>
        <Surface padded={false} style={touched && !citizenship ? { borderColor: c.danger } : undefined}>
          {COUNTRIES.map((country, i) => {
            const selected = country.code === citizenship;
            return (
              <Pressable
                key={country.code}
                onPress={() => setCitizenship(country.code)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: space.lg,
                  paddingVertical: space.md,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: c.border,
                  backgroundColor: selected ? c.surfaceAlt : undefined,
                }}
              >
                <AppText style={{ flex: 1 }}>{i18n.language === 'en' ? country.en : country.ru}</AppText>
                {selected ? <Icon name="check" color={c.primary} size={20} /> : null}
              </Pressable>
            );
          })}
        </Surface>
      </View>

      {submit.error ? <Notice tone="danger" text={fmt.error(submit.error)} /> : null}
      <Button title={t('kyc.submit')} onPress={onSubmit} loading={submit.isPending} />
    </Screen>
  );
}
