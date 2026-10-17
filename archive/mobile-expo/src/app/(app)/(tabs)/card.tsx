import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, RefreshControl, View } from 'react-native';
import type { CardDto } from '@gudex/shared';
import { ActivityRow } from '../../../components/ActivityRow';
import { BankCard } from '../../../components/BankCard';
import { CardDetails, useRevealDetails } from '../../../components/CardDetails';
import { ConfirmSheet } from '../../../components/ConfirmSheet';
import { Icon } from '../../../components/Icon';
import { KycBanner } from '../../../components/KycBanner';
import { TestModeBanner } from '../../../components/TestModeBanner';
import { ActionButton, AppText, Button, Loading, Notice, SectionTitle, Screen, Surface } from '../../../components/ui';
import { useFormat } from '../../../lib/format';
import {
  useActivity,
  useCards,
  useConfig,
  useMe,
  useOperation,
  useSetFrozen,
  useSimulatePurchase,
} from '../../../lib/queries';
import { space, useColors } from '../../../theme';

export default function CardTab() {
  const { t } = useTranslation();
  const cards = useCards();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (cards.isLoading) return <Loading />;
  const list = cards.data ?? [];
  if (list.length === 0) return <NoCard />;

  const card = list.find((c) => c.id === selectedId) ?? list[0]!;
  return (
    <Screen refreshControl={<RefreshControl refreshing={cards.isRefetching} onRefresh={() => cards.refetch()} />}>
      <AppText variant="title">{t('card.title')}</AppText>
      <TestModeBanner />
      {list.length > 1 ? (
        <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
          {list.map((c) => (
            <Button
              key={c.id}
              title={c.last4 ? `•• ${c.last4}` : '••••'}
              variant={c.id === card.id ? 'primary' : 'secondary'}
              onPress={() => setSelectedId(c.id)}
              style={{ height: 36 }}
            />
          ))}
        </View>
      ) : null}
      <CardView key={card.id} card={card} />
    </Screen>
  );
}

function CardView({ card }: { card: CardDto }) {
  const fmt = useFormat();
  const { t } = useTranslation();
  const c = useColors();
  const { data: config } = useConfig();
  const activity = useActivity(50);
  const setFrozen = useSetFrozen(card.id);
  const purchase = useSimulatePurchase(card.id);
  const { details, reveal, hide, error: detailsError } = useRevealDetails(card.id);
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  // Действие фиксируется при открытии окна, чтобы текст не менялся, пока окно закрывается.
  const [freezeAction, setFreezeAction] = useState<'freeze' | 'unfreeze'>('freeze');
  const [statusOpId, setStatusOpId] = useState<string | null>(null);
  const statusOp = useOperation(statusOpId);
  const cards = useCards();

  useEffect(() => {
    if (statusOp.data?.status === 'succeeded' || statusOp.data?.status === 'failed') {
      cards.refetch();
      setStatusOpId(null);
    }
  }, [statusOp.data?.status]);

  const active = card.status === 'active';
  const frozen = card.status === 'frozen';
  const busy = statusOpId !== null || setFrozen.isPending;
  const cardActivity = (activity.data ?? []).filter((a) => a.kind !== 'deposit' && a.cardLast4 === card.last4);
  const walletName = Platform.OS === 'android' ? 'Google Pay' : 'Apple Pay';

  const toggleFrozen = async () => {
    const op = await setFrozen.mutateAsync({ frozen: freezeAction === 'freeze', idempotencyKey: randomUUID() }).catch(() => null);
    setConfirmFreeze(false);
    if (op) setStatusOpId(op.id);
  };

  return (
    <>
      <BankCard card={card} sensitive={details} />

      {card.status === 'pending' ? (
        <Notice icon="history" text={t('card.issuingHint')} />
      ) : (
        <>
          <View style={{ gap: space.xs }}>
            <AppText variant="label" muted>
              {t('card.balance')}
            </AppText>
            <AppText variant="display">{fmt.amount(card.balance, 'USD')}</AppText>
          </View>

          <View style={{ flexDirection: 'row' }}>
            <ActionButton
              icon="plus"
              label={t('card.topup')}
              disabled={!active}
              onPress={() => router.push({ pathname: '/card-topup', params: { cardId: card.id } })}
            />
            <ActionButton icon={details ? 'eyeOff' : 'eye'} label={details ? t('card.hideDetails') : t('card.details')} onPress={details ? hide : reveal} />
            <ActionButton
              icon="snowflake"
              label={busy ? t('card.processing') : frozen ? t('card.unfreeze') : t('card.freeze')}
              disabled={busy}
              onPress={() => {
                setFreezeAction(frozen ? 'unfreeze' : 'freeze');
                setConfirmFreeze(true);
              }}
            />
            <ActionButton
              icon="wallet"
              label={walletName}
              disabled={!active}
              onPress={() => router.push({ pathname: '/wallet-pay', params: { cardId: card.id } })}
            />
          </View>
        </>
      )}

      {details ? <CardDetails details={details} /> : null}
      {detailsError ? <Notice tone="danger" text={fmt.error(detailsError)} /> : null}

      {config?.devTools && active ? (
        <Button
          variant="secondary"
          icon="flask"
          title={t('card.simulatePurchase')}
          loading={purchase.isPending}
          onPress={() => purchase.mutate({ amount: '15', merchant: 'Netflix' })}
        />
      ) : null}
      {purchase.error ? <Notice tone="danger" text={(purchase.error as Error).message} /> : null}

      <SectionTitle title={t('card.transactions')} />
      <Surface>
        {cardActivity.length ? (
          cardActivity.map((item) => <ActivityRow key={item.id} item={item} />)
        ) : (
          <AppText muted>{t('card.noTransactions')}</AppText>
        )}
      </Surface>

      <ConfirmSheet
        visible={confirmFreeze}
        icon="snowflake"
        title={freezeAction === 'unfreeze' ? t('card.unfreezeTitle') : t('card.freezeTitle')}
        message={freezeAction === 'unfreeze' ? t('card.unfreezeText') : t('card.freezeText')}
        confirmLabel={freezeAction === 'unfreeze' ? t('card.unfreeze') : t('card.freeze')}
        cancelLabel={t('common.cancel')}
        loading={setFrozen.isPending}
        onConfirm={toggleFrozen}
        onCancel={() => setConfirmFreeze(false)}
      />
    </>
  );
}

function NoCard() {
  const fmt = useFormat();
  const { t } = useTranslation();
  const c = useColors();
  const { data: me } = useMe();
  const { data: config } = useConfig();
  const points = [t('card.emptyPoint1'), t('card.emptyPoint2'), t('card.emptyPoint3')];
  return (
    <Screen>
      <AppText variant="title">{t('card.title')}</AppText>
      <TestModeBanner />
      <BankCard placeholder />
      <AppText variant="heading">{config?.card.productName ?? t('card.emptyTitle')}</AppText>
      <View style={{ gap: space.md }}>
        {points.map((p) => (
          <View key={p} style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
            <Icon name="check" color={c.primary} size={20} />
            <AppText style={{ flex: 1 }}>{p}</AppText>
          </View>
        ))}
      </View>
      {config ? (
        <Surface>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <AppText muted>{t('card.issueFee')}</AppText>
            <AppText variant="bodyMedium">{fmt.amount(config.card.issueFeeUsd, 'USD')}</AppText>
          </View>
        </Surface>
      ) : null}
      <KycBanner />
      <Button
        title={t('home.getCard')}
        icon="card"
        onPress={() => router.push(me?.kyc.status === 'approved' ? '/card-issue' : '/kyc')}
      />
    </Screen>
  );
}
