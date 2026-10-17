import { Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { CardDetails, useRevealDetails } from '../../components/CardDetails';
import { AppText, Button, Notice, Screen, Surface } from '../../components/ui';
import { useConfig } from '../../lib/queries';
import { fonts, space, useColors } from '../../theme';

// Добавление карты в Apple Pay / Google Pay вручную через приложение Wallet.
// Кнопка «Добавить в Wallet» внутри приложения требует поддержки со стороны эмитента (In-App Provisioning).
export default function WalletPay() {
  const { t } = useTranslation();
  const c = useColors();
  const { cardId } = useLocalSearchParams<{ cardId: string }>();
  const { data: config } = useConfig();
  const { details, reveal, loading } = useRevealDetails(cardId);
  const android = Platform.OS === 'android';
  const wallet = android ? 'Google Pay' : 'Apple Pay';
  const steps = android
    ? [t('walletPay.android1'), t('walletPay.android2'), t('walletPay.android3'), t('walletPay.android4')]
    : [t('walletPay.ios1'), t('walletPay.ios2'), t('walletPay.ios3'), t('walletPay.ios4')];

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: wallet }} />
      <AppText>{t('walletPay.intro', { wallet })}</AppText>

      <Surface style={{ gap: space.lg }}>
        {steps.map((step, i) => (
          <View key={step} style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
              <AppText color={c.onPrimary} style={{ fontFamily: fonts.semibold }}>
                {i + 1}
              </AppText>
            </View>
            <AppText style={{ flex: 1, paddingTop: 3 }}>{step}</AppText>
          </View>
        ))}
      </Surface>

      {details ? (
        <CardDetails details={details} />
      ) : (
        <Button title={t('walletPay.showDetails')} icon="lock" variant="secondary" onPress={reveal} loading={loading} />
      )}

      {config?.devTools ? <Notice tone="warning" icon="flask" text={t('walletPay.testCard', { wallet })} /> : null}
      <Notice text={t('walletPay.inAppNote', { wallet })} />
    </Screen>
  );
}
