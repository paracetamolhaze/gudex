import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { WalletAsset, WalletDto } from '@gudex/shared';
import { useFormat } from '../lib/format';
import { radius, space, useColors } from '../theme';
import { AssetIcon } from './AssetIcon';
import { AppText } from './ui';

// Выбор, с какого баланса списывать: USDT или USDC, с остатком.
export function AssetPicker({ wallet, value, onChange }: { wallet?: WalletDto; value: WalletAsset; onChange: (asset: WalletAsset) => void }) {
  const fmt = useFormat();
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: space.md }}>
      {(wallet?.balances ?? []).map((b) => {
        const selected = b.asset === value;
        return (
          <Pressable
            key={b.asset}
            onPress={() => onChange(b.asset)}
            style={{
              flex: 1,
              gap: space.sm,
              padding: space.md,
              borderRadius: radius.md,
              borderWidth: 2,
              borderColor: selected ? c.primary : c.border,
              backgroundColor: c.surface,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <AssetIcon asset={b.asset} size={28} />
              <AppText variant="bodyMedium">{b.asset}</AppText>
            </View>
            <AppText variant="caption" muted>
              {t('issue.available', { amount: fmt.amount(b.amount, b.asset) })}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
