// Справочник активов и сетей. Единый для backend и приложения.

export const WALLET_ASSETS = ['USDT', 'USDC'] as const;
export type WalletAsset = (typeof WALLET_ASSETS)[number];

// Валюта карточного баланса у партнёра.
export const CARD_CURRENCY = 'USD' as const;
export type CardCurrency = typeof CARD_CURRENCY;

export type Asset = WalletAsset | CardCurrency;

// Количество знаков после запятой. Суммы везде хранятся в минимальных единицах (bigint).
export const ASSET_DECIMALS: Record<Asset, number> = {
  USDT: 6,
  USDC: 6,
  USD: 2,
};

export const NETWORK_IDS = ['TON', 'TRC20', 'BEP20', 'POLYGON', 'ERC20'] as const;
export type Network = (typeof NETWORK_IDS)[number];

export interface NetworkInfo {
  id: Network;
  name: string;
  // Короткое название — для переключателей, где мало места.
  short: string;
  // Пример адреса — нужен заглушке депозитов и подсказкам в UI.
  addressPrefix: string;
}

export const NETWORKS: Record<Network, NetworkInfo> = {
  TON: { id: 'TON', name: 'TON', short: 'TON', addressPrefix: 'UQ' },
  TRC20: { id: 'TRC20', name: 'TRON (TRC20)', short: 'TRC20', addressPrefix: 'T' },
  BEP20: { id: 'BEP20', name: 'BNB Chain (BEP20)', short: 'BEP20', addressPrefix: '0x' },
  POLYGON: { id: 'POLYGON', name: 'Polygon', short: 'Polygon', addressPrefix: '0x' },
  ERC20: { id: 'ERC20', name: 'Ethereum (ERC20)', short: 'ERC20', addressPrefix: '0x' },
};

// Какие сети доступны для пополнения и вывода каждого актива. Первая — сеть по умолчанию:
// TRC20 — самая популярная для USDT. Правила Telegram о TON касаются выпуска токенов и подключения
// кошельков (TON Connect), а не приёма переводов на наш адрес.
// TODO: сверить с сетями, которые реально принимает UPay (Fund Control).
export const DEPOSIT_NETWORKS: Record<WalletAsset, Network[]> = {
  USDT: ['TRC20', 'TON', 'BEP20', 'POLYGON', 'ERC20'],
  USDC: ['BEP20', 'POLYGON', 'ERC20'],
};

export const isEvmNetwork = (network: Network) => network === 'BEP20' || network === 'POLYGON' || network === 'ERC20';

// Проверка формата адреса до отправки. Контрольную сумму не проверяем — только форму,
// чтобы поймать опечатку и адрес из чужой сети (например, TRON-адрес в сети BEP20).
const ADDRESS_RE: Record<'TON' | 'TRC20' | 'EVM', RegExp> = {
  TON: /^(?:[UEk0]Q[A-Za-z0-9_-]{46}|-?[01]:[0-9a-fA-F]{64})$/,
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  EVM: /^0x[0-9a-fA-F]{40}$/,
};

export function isValidAddress(network: Network, address: string): boolean {
  const re = isEvmNetwork(network) ? ADDRESS_RE.EVM : ADDRESS_RE[network as 'TON' | 'TRC20'];
  return re.test(address.trim());
}

export function isWalletAsset(value: unknown): value is WalletAsset {
  return typeof value === 'string' && (WALLET_ASSETS as readonly string[]).includes(value);
}
