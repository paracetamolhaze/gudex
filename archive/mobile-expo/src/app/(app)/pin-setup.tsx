import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../components/Icon';
import { PinPad } from '../../components/PinPad';
import { AppText, Button } from '../../components/ui';
import { BIOMETRY_ICON, useSecurity } from '../../lib/security';
import { space, useColors } from '../../theme';

type Step = 'current' | 'new' | 'confirm' | 'biometrics';

// Создание код-пароля после входа (обязательный шаг) и его смена из профиля.
export default function PinSetup() {
  const { t } = useTranslation();
  const c = useColors();
  const security = useSecurity();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const changing = mode === 'change';
  const [step, setStep] = useState<Step>(changing ? 'current' : 'new');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const done = () => (changing ? router.back() : router.replace('/home'));

  const afterPinSaved = () => {
    if (!changing && security.biometry) setStep('biometrics');
    else done();
  };

  if (step === 'biometrics' && security.biometry) {
    const kind = security.biometry;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: c.background, padding: space.xl, justifyContent: 'space-between' }}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg }}>
          <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={BIOMETRY_ICON[kind]} color={c.primary} size={48} />
          </View>
          <AppText variant="title" style={{ textAlign: 'center' }}>
            {t(`security.bioTitle.${kind}`)}
          </AppText>
          <AppText muted style={{ textAlign: 'center' }}>
            {t('security.bioText')}
          </AppText>
        </View>
        <View style={{ gap: space.md }}>
          <Button
            title={t('security.enable')}
            onPress={async () => {
              await security.setBiometricsEnabled(true);
              done();
            }}
          />
          <Button title={t('security.notNow')} variant="ghost" onPress={done} />
        </View>
      </SafeAreaView>
    );
  }

  const titles: Record<Exclude<Step, 'biometrics'>, string> = {
    current: t('security.currentTitle'),
    new: t('security.createTitle'),
    confirm: t('security.confirmTitle'),
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.background, padding: space.lg, justifyContent: 'center' }}>
      <Stack.Screen options={{ headerShown: changing, title: '' }} />
      <PinPad
        key={step}
        title={titles[step as Exclude<Step, 'biometrics'>]}
        subtitle={step === 'new' ? t('security.createSubtitle') : undefined}
        error={error}
        onComplete={async (pin) => {
          if (step === 'current') {
            const result = await security.checkPin(pin);
            if (!result.ok) {
              setError(result.attemptsLeft > 0 ? t('security.wrong', { count: result.attemptsLeft }) : t('security.lockedOut'));
              return false;
            }
            setError(null);
            setStep('new');
            return;
          }
          if (step === 'new') {
            setError(null);
            setFirstPin(pin);
            setStep('confirm');
            return;
          }
          if (pin !== firstPin) {
            setError(t('security.mismatch'));
            setFirstPin('');
            setStep('new');
            return false;
          }
          await security.createPin(pin);
          afterPinSaved();
        }}
      />
    </SafeAreaView>
  );
}
