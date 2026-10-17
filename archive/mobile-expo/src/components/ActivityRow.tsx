import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ActivityItemDto } from '@gudex/shared';
import { useFormat } from '../lib/format';
import { space, useColors } from '../theme';
import { Icon, type IconName } from './Icon';
import { AppText } from './ui';

const ICON: Record<ActivityItemDto['kind'], IconName> = {
  deposit: 'arrowDown',
  card_issue: 'card',
  card_topup: 'arrowUp',
  card_purchase: 'bag',
  card_refund: 'arrowDown',
};

export function ActivityRow({ item }: { item: ActivityItemDto }) {
  const fmt = useFormat();
  const c = useColors();
  const { t } = useTranslation();
  const incoming = item.amount.startsWith('+');
  const title =
    item.kind === 'card_purchase' && item.merchant
      ? item.merchant
      : t(`activity.${item.kind}`, { asset: item.asset });
  const details = [
    fmt.time(item.createdAt),
    item.cardLast4 ? `•• ${item.cardLast4}` : null,
    item.network,
    item.status === 'pending' ? t('activity.pending') : null,
    item.status === 'failed' ? t('activity.failed') : null,
  ].filter(Boolean);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm }}>
      <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={ICON[item.kind]} color={incoming ? c.success : c.primary} size={20} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="bodyMedium" numberOfLines={1}>
          {title}
        </AppText>
        <AppText variant="caption" muted numberOfLines={1} style={item.status === 'failed' ? { color: c.danger } : undefined}>
          {details.join(' · ')}
        </AppText>
      </View>
      <AppText
        variant="bodyMedium"
        color={item.status === 'failed' ? c.textSecondary : incoming ? c.success : c.text}
        style={item.status === 'failed' ? { textDecorationLine: 'line-through' } : undefined}
      >
        {fmt.amount(item.amount, item.asset, { sign: true })}
      </AppText>
    </View>
  );
}
