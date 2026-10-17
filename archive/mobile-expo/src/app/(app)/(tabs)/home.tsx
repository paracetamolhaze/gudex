import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, RefreshControl, View } from 'react-native';
import { ActivityRow } from '../../../components/ActivityRow';
import { AssetIcon } from '../../../components/AssetIcon';
import { BankCard } from '../../../components/BankCard';
import { KycBanner } from '../../../components/KycBanner';
import { LogoBadge } from '../../../components/Logo';
import { TestModeBanner } from '../../../components/TestModeBanner';
import { ActionButton, AppText, Button, SectionTitle, Screen, Surface } from '../../../components/ui';
import { useFormat } from '../../../lib/format';
import { useActivity, useCards, useMe, useWallet } from '../../../lib/queries';
import { space, useColors } from '../../../theme';

export default function Home() {
  const fmt = useFormat();
  const { t } = useTranslation();
  const c = useColors();
  const wallet = useWallet();
  const cards = useCards();
  const activity = useActivity(5);
  const me = useMe();
  const card = cards.data?.[0];

  const refreshing = wallet.isRefetching || activity.isRefetching;
  const refresh = () => Promise.all([wallet.refetch(), cards.refetch(), activity.refetch(), me.refetch()]);
  const openCardFlow = () => router.push(me.data?.kyc.status === 'approved' ? '/card-issue' : '/kyc');

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.primary} />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <LogoBadge size={36} />
        <AppText variant="heading">GUDEX</AppText>
      </View>

      <TestModeBanner />

      <View style={{ gap: space.xs }}>
        <AppText variant="label" muted>
          {t('home.totalBalance')}
        </AppText>
        <AppText variant="display">{wallet.data ? fmt.amount(wallet.data.totalUsd, 'USD') : '—'}</AppText>
      </View>

      {card ? (
        <Pressable onPress={() => router.push('/card')}>
          <BankCard card={card} />
        </Pressable>
      ) : (
        <Surface style={{ gap: space.md }}>
          <AppText variant="heading">{t('home.getCardTitle')}</AppText>
          <AppText muted>{t('home.getCardText')}</AppText>
          <Button title={t('home.getCard')} icon="card" onPress={openCardFlow} />
        </Surface>
      )}

      <View style={{ flexDirection: 'row' }}>
        <ActionButton icon="arrowDown" label={t('home.deposit')} onPress={() => router.push('/deposit')} />
        <ActionButton icon="card" label={t('home.card')} onPress={() => router.push('/card')} />
        <ActionButton icon="history" label={t('home.history')} onPress={() => router.push('/history')} />
      </View>

      <KycBanner />

      <SectionTitle title={t('home.assets')} />
      <Surface padded={false}>
        {(wallet.data?.balances ?? []).map((b, i) => (
          <Pressable
            key={b.asset}
            onPress={() => router.push({ pathname: '/deposit', params: { asset: b.asset } })}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              padding: space.lg,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: c.border,
            }}
          >
            <AssetIcon asset={b.asset} />
            <View style={{ flex: 1 }}>
              <AppText variant="bodyMedium">{b.asset}</AppText>
              <AppText variant="caption" muted>
                {b.asset === 'USDT' ? 'Tether' : 'USD Coin'}
              </AppText>
            </View>
            <AppText variant="bodyMedium">{fmt.amount(b.amount, b.asset)}</AppText>
          </Pressable>
        ))}
      </Surface>

      <SectionTitle
        title={t('home.recent')}
        action={
          activity.data?.length ? (
            <Pressable onPress={() => router.push('/history')} hitSlop={8}>
              <AppText variant="label" color={c.primary}>
                {t('common.all')}
              </AppText>
            </Pressable>
          ) : null
        }
      />
      <Surface>
        {activity.data?.length ? (
          activity.data.map((item) => <ActivityRow key={item.id} item={item} />)
        ) : (
          <AppText muted>{t('home.noActivity')}</AppText>
        )}
      </Surface>
    </Screen>
  );
}
