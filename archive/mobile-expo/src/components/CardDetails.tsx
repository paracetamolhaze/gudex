import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import type { CardSensitiveDto } from '@gudex/shared';
import { useCardSensitive } from '../lib/queries';
import { useSecurity } from '../lib/security';
import { space, useColors } from '../theme';
import { Icon } from './Icon';
import { AppText, Surface } from './ui';

const DETAILS_VISIBLE_MS = 30_000;

// Реквизиты карты: запрашиваются только после код-пароля / биометрии и скрываются через 30 секунд.
export function useRevealDetails(cardId: string) {
  const { t } = useTranslation();
  const security = useSecurity();
  const sensitive = useCardSensitive(cardId);
  const [details, setDetails] = useState<CardSensitiveDto | null>(null);

  useEffect(() => {
    if (!details) return;
    const timer = setTimeout(() => setDetails(null), DETAILS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [details]);

  const reveal = async () => {
    if (!(await security.verify(t('security.revealReason')))) return;
    setDetails(await sensitive.mutateAsync().catch(() => null));
  };

  return { details, reveal, hide: () => setDetails(null), loading: sensitive.isPending, error: sensitive.error };
}

export function CardDetails({ details }: { details: CardSensitiveDto }) {
  const { t } = useTranslation();
  const c = useColors();
  const [copied, setCopied] = useState<string | null>(null);
  const rows = [
    { label: t('card.number'), value: details.pan.replace(/(\d{4})(?=\d)/g, '$1 '), copy: details.pan },
    {
      label: t('card.expiry'),
      value: `${String(details.expiryMonth).padStart(2, '0')}/${String(details.expiryYear).slice(-2)}`,
      copy: `${String(details.expiryMonth).padStart(2, '0')}/${String(details.expiryYear).slice(-2)}`,
    },
    { label: t('card.cvv'), value: details.cvv, copy: details.cvv },
    { label: t('card.holder'), value: details.holderName, copy: details.holderName },
  ];
  return (
    <Surface style={{ gap: space.md }}>
      {rows.map((row) => (
        <View key={row.label} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ flex: 1, gap: 2 }}>
            <AppText variant="caption" muted>
              {row.label}
            </AppText>
            <AppText variant="bodyMedium">{row.value}</AppText>
          </View>
          <Pressable
            hitSlop={10}
            onPress={async () => {
              await Clipboard.setStringAsync(row.copy);
              setCopied(row.label);
            }}
          >
            <Icon name={copied === row.label ? 'check' : 'copy'} color={c.primary} size={20} />
          </Pressable>
        </View>
      ))}
      <AppText variant="caption" muted>
        {t('card.detailsHint')}
      </AppText>
    </Surface>
  );
}
