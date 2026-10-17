import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { DEPOSIT_NETWORKS, isWalletAsset, NETWORKS, type Network, type WalletAsset } from '@gudex/shared';
import { Icon } from '../../components/Icon';
import { TestModeBanner } from '../../components/TestModeBanner';
import { AppText, Button, Loading, Notice, Screen, Segmented, Surface } from '../../components/ui';
import { useConfig, useDepositAddress, useSimulateDeposit } from '../../lib/queries';
import { radius, space, useColors } from '../../theme';

export default function Deposit() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ asset?: string }>();
  const [asset, setAsset] = useState<WalletAsset>(isWalletAsset(params.asset) ? params.asset : 'USDT');
  const network: Network = DEPOSIT_NETWORKS[asset][0]!;

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: t('deposit.title') }} />
      <TestModeBanner />
      <Segmented<WalletAsset>
        options={[
          { value: 'USDT', label: 'USDT' },
          { value: 'USDC', label: 'USDC' },
        ]}
        value={asset}
        onChange={setAsset}
      />
      <AddressCard key={`${asset}-${network}`} asset={asset} network={network} />
    </Screen>
  );
}

function AddressCard({ asset, network }: { asset: WalletAsset; network: Network }) {
  const { t } = useTranslation();
  const c = useColors();
  const { data: config } = useConfig();
  const address = useDepositAddress(asset, network);
  const simulate = useSimulateDeposit();
  const [copied, setCopied] = useState(false);

  if (address.isLoading || !address.data) return <Loading />;
  const networkName = NETWORKS[network].name;

  return (
    <>
      <Surface style={{ gap: space.lg, alignItems: 'center' }}>
        <View style={{ alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'space-between' }}>
          <AppText muted>{t('deposit.network')}</AppText>
          <AppText variant="bodyMedium">{networkName}</AppText>
        </View>
        <View style={{ padding: space.md, backgroundColor: '#FFFFFF', borderRadius: radius.md }}>
          <QRCode value={address.data.address} size={200} />
        </View>
        <View style={{ alignSelf: 'stretch', gap: space.xs }}>
          <AppText variant="caption" muted>
            {t('deposit.address')}
          </AppText>
          <Pressable
            onPress={async () => {
              await Clipboard.setStringAsync(address.data.address);
              setCopied(true);
            }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}
          >
            <AppText variant="bodyMedium" style={{ flex: 1 }} selectable>
              {address.data.address}
            </AppText>
            <Icon name={copied ? 'check' : 'copy'} color={c.primary} size={20} />
          </Pressable>
        </View>
      </Surface>

      <Notice tone="warning" text={t('deposit.warning', { asset, network: networkName })} />
      <AppText variant="caption" muted>
        {t('deposit.minAmount', { amount: address.data.minAmount, asset })}
      </AppText>

      {config?.devTools ? (
        <>
          <Button
            variant="secondary"
            icon="flask"
            title={t('deposit.simulate', { asset })}
            loading={simulate.isPending}
            onPress={() => simulate.mutate({ asset, network, amount: '100' })}
          />
          {simulate.isSuccess ? <Notice icon="check" text={t('deposit.simulated', { asset })} /> : null}
        </>
      ) : null}
    </>
  );
}
