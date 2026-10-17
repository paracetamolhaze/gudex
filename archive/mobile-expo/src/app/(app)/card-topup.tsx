import { randomUUID } from 'expo-crypto';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import type { WalletAsset } from '@gudex/shared';
import { AssetPicker } from '../../components/AssetPicker';
import { AppText, Button, Field, Loading, Notice, Row, Screen, Surface } from '../../components/ui';
import { useFormat } from '../../lib/format';
import { useConfig, useTopupCard, useTopupQuote, useWallet } from '../../lib/queries';
import { space, useColors } from '../../theme';

// Запрос котировки — не на каждую цифру, а после паузы в наборе.
function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export default function CardTopup() {
  const fmt = useFormat();
  const { t } = useTranslation();
  const c = useColors();
  const { cardId } = useLocalSearchParams<{ cardId: string }>();
  const { data: config } = useConfig();
  const { data: wallet } = useWallet();
  const topup = useTopupCard(cardId);
  const [asset, setAsset] = useState<WalletAsset>('USDT');
  const [amount, setAmount] = useState('');
  const debouncedAmount = useDebounced(amount);
  const quote = useTopupQuote(asset, debouncedAmount);
  const idempotencyKey = useRef(randomUUID()).current;

  if (!config) return <Loading />;
  const available = wallet?.balances.find((b) => b.asset === asset)?.amount ?? '0';
  const quoteReady = quote.data && debouncedAmount === amount;

  const submit = () =>
    topup.mutate({ asset, amount: amount.replace(',', '.'), idempotencyKey }, { onSuccess: () => router.back() });

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: t('topup.title') }} />

      <AppText variant="label" muted>
        {t('topup.from')}
      </AppText>
      <AssetPicker wallet={wallet} value={asset} onChange={setAsset} />

      <View>
        <Field
          label={t('topup.amount')}
          value={amount}
          onChangeText={(v) => setAmount(v.replace(/[^\d.,]/g, ''))}
          keyboardType="decimal-pad"
          placeholder="0.00"
          hint={t('topup.min', { amount: config.card.minTopupUsd })}
        />
        <Pressable onPress={() => setAmount(available)} hitSlop={8} style={{ position: 'absolute', right: space.lg, top: 38 }}>
          <AppText variant="label" color={c.primary}>
            {t('topup.max')}
          </AppText>
        </Pressable>
      </View>

      <Surface style={{ gap: space.md }}>
        <Row
          label={t('topup.fee', { percent: fmt.percent(config.card.topupFeeBps / 100) })}
          value={quoteReady ? fmt.amount(quote.data!.fee, asset) : '—'}
        />
        <Row label={t('topup.receive')} value={quoteReady ? fmt.amount(quote.data!.netUsd, 'USD') : '—'} strong />
      </Surface>

      {quote.error && amount ? <Notice tone="warning" text={fmt.error(quote.error)} /> : null}
      {topup.error ? <Notice tone="danger" text={fmt.error(topup.error)} /> : null}

      <Button title={t('topup.submit')} icon="plus" onPress={submit} loading={topup.isPending} disabled={!quoteReady} />
    </Screen>
  );
}
