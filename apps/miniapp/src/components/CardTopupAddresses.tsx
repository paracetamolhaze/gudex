import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CardTopupAddressDto } from '@gudex/shared';
import { CopyRow } from './FeePayment';
import { Notice, Segmented, Surface } from './ui';

const networkNames: Record<CardTopupAddressDto['network'], string> = { TRC20: 'Tron (TRC20)', ERC20: 'Ethereum (ERC20)', BEP20: 'BNB Chain (BEP20)' };

// The crypto addresses UPay gives this card: the client sends USDT or USDC there to top it up.
export function CardTopupAddresses({ addresses }: { addresses: CardTopupAddressDto[] }) {
  const { t } = useTranslation();
  const assets = [...new Set(addresses.map(item => item.asset))];
  const [asset, setAsset] = useState(assets[0]!);
  const networks = addresses.filter(item => item.asset === asset).map(item => item.network);
  const [network, setNetwork] = useState(networks[0]!);
  const selected = addresses.find(item => item.asset === asset && item.network === network) ?? addresses.find(item => item.asset === asset)!;
  const [qr, setQr] = useState('');
  useEffect(() => {
    let cancelled = false;
    setQr('');
    void QRCode.toString(selected.address, { type: 'svg', margin: 0 }).then(svg => { if (!cancelled) setQr(svg); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected.address]);

  return <Surface className="stack">
    {assets.length > 1 ? <Segmented options={assets.map(value => ({ value, label: value }))} value={asset}
      onChange={value => { setAsset(value); setNetwork(addresses.find(item => item.asset === value)!.network); }} /> : null}
    <span className="label muted">{t('fee.network')}</span>
    <Segmented options={networks.map(value => ({ value, label: value }))} value={selected.network} onChange={setNetwork} />
    <div style={{ display: 'flex', justifyContent: 'center' }}><div className="qr" dangerouslySetInnerHTML={{ __html: qr }} /></div>
    <span className="caption muted">{t('topup.cardAddress')}</span>
    <CopyRow value={selected.address} label={t('fee.copyAddress')} />
    <Notice tone="warning" text={t('topup.cardAddressWarning', { asset: selected.asset, network: networkNames[selected.network] })} />
  </Surface>;
}
