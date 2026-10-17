import { randomUUID } from 'expo-crypto';
import { router, Stack } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WalletAsset } from '@gudex/shared';
import { AssetPicker } from '../../components/AssetPicker';
import { BankCard } from '../../components/BankCard';
import { AppText, Button, Loading, Notice, Row, Screen, Surface } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useConfig, useIssueCard, useWallet } from '../../lib/queries';
import { space } from '../../theme';

export default function CardIssue() {
  const fmt = useFormat();
  const { t } = useTranslation();
  const { data: config } = useConfig();
  const { data: wallet } = useWallet();
  const issue = useIssueCard();
  const [asset, setAsset] = useState<WalletAsset>('USDT');
  // Один ключ на экран: повторное нажатие или повтор запроса не выпустит вторую карту.
  const idempotencyKey = useRef(randomUUID()).current;

  if (!config) return <Loading />;
  const fee = config.card.issueFeeUsd;
  const noFunds = issue.error instanceof ApiError && issue.error.code === 'insufficient_funds';

  const submit = () =>
    issue.mutate({ asset, idempotencyKey }, { onSuccess: () => router.replace('/card') });

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: t('issue.title') }} />
      <BankCard placeholder />
      <AppText variant="heading">{config.card.productName}</AppText>

      <AppText variant="label" muted>
        {t('issue.payFrom')}
      </AppText>
      <AssetPicker wallet={wallet} value={asset} onChange={setAsset} />

      <Surface style={{ gap: space.md }}>
        <Row label={t('issue.fee')} value={fmt.amount(fee, 'USD')} />
        <Row label={t('issue.total')} value={fmt.amount(fee, asset)} strong />
      </Surface>

      {issue.error ? (
        <Notice
          tone="danger"
          text={fmt.error(issue.error)}
          action={noFunds ? <Button title={t('home.deposit')} variant="ghost" onPress={() => router.push({ pathname: '/deposit', params: { asset } })} style={{ height: 36 }} /> : undefined}
        />
      ) : null}

      <Button title={t('issue.submit', { amount: fee, asset })} icon="card" onPress={submit} loading={issue.isPending} />
    </Screen>
  );
}
