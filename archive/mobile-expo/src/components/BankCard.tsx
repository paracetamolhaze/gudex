import { LinearGradient } from 'expo-linear-gradient';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { CardDto, CardSensitiveDto } from '@gudex/shared';
import { fonts, radius, space, useColors } from '../theme';
import { Icon } from './Icon';
import { LogoMark } from './Logo';
import { AppText } from './ui';

function groupPan(pan: string): string {
  return pan.replace(/(\d{4})(?=\d)/g, '$1 ');
}

// Визуал виртуальной карты в цветах GudExchange.
export function BankCard({ card, sensitive, placeholder }: { card?: CardDto; sensitive?: CardSensitiveDto | null; placeholder?: boolean }) {
  const c = useColors();
  const { t } = useTranslation();
  const pending = card?.status === 'pending';
  const frozen = card?.status === 'frozen';
  const number = sensitive ? groupPan(sensitive.pan) : `••••  ••••  ••••  ${card?.last4 ?? '••••'}`;
  const expiry = sensitive
    ? `${String(sensitive.expiryMonth).padStart(2, '0')}/${String(sensitive.expiryYear).slice(-2)}`
    : card?.expiryMonth
      ? `${String(card.expiryMonth).padStart(2, '0')}/${String(card.expiryYear).slice(-2)}`
      : '••/••';

  return (
    <View style={styles.wrap}>
      <LinearGradient colors={c.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.card, frozen && { opacity: 0.55 }]}>
        <View style={styles.top}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <LogoMark size={26} />
            <AppText variant="heading" color="#FFFFFF" style={{ fontFamily: fonts.bold, letterSpacing: 1 }}>
              GUDEX
            </AppText>
          </View>
          {sensitive ? (
            <AppText variant="label" color="#FFFFFF">
              CVV {sensitive.cvv}
            </AppText>
          ) : null}
        </View>

        <AppText variant="heading" color="#FFFFFF" style={{ fontFamily: fonts.medium, letterSpacing: 1.5, fontSize: 19 }}>
          {placeholder ? '••••  ••••  ••••  ••••' : number}
        </AppText>

        <View style={styles.bottom}>
          <View style={{ gap: 2, flexShrink: 1 }}>
            <AppText variant="caption" color="rgba(255,255,255,0.75)">
              {expiry}
            </AppText>
            <AppText variant="label" color="#FFFFFF" numberOfLines={1}>
              {sensitive?.holderName ?? card?.holderName ?? 'GUDEX CARD'}
            </AppText>
          </View>
          <AppText color="#FFFFFF" style={{ fontFamily: fonts.bold, fontSize: 24, fontStyle: 'italic', letterSpacing: 1 }}>
            VISA
          </AppText>
        </View>
      </LinearGradient>

      {pending || frozen ? (
        <View style={styles.overlay}>
          <View style={styles.badge}>
            {pending ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Icon name="snowflake" color="#FFFFFF" size={18} />}
            <AppText variant="label" color="#FFFFFF">
              {pending ? t('card.issuing') : t('card.frozen')}
            </AppText>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', aspectRatio: 1.586 },
  card: { flex: 1, borderRadius: radius.lg, padding: space.xl, justifyContent: 'space-between' },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: space.md },
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: 'rgba(10,15,28,0.55)',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: 999,
  },
});
