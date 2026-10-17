import type { ExchangeSessionDto, Locale, Network, WalletAsset } from '@gudex/shared';
import type { Config } from '../config';
import type { WalletService } from './wallet';

// Коды валют WhiteBird (сеть зашита в код). Порядок = порядок в виджете; TRC-20 первым.
// TODO(WhiteBird): коды для BEP-20/Polygon уточнить, когда появятся в договоре.
const OPTIONS: { asset: WalletAsset; network: Network; currency: string }[] = [
  { asset: 'USDT', network: 'TRC20', currency: 'USDT_TRC' },
  { asset: 'USDT', network: 'TON', currency: 'USDT_TON' },
  { asset: 'USDT', network: 'ERC20', currency: 'USDT' },
  { asset: 'USDC', network: 'ERC20', currency: 'USDC' },
];

// Обменник WhiteBird внутри приложения: клиент покупает крипту, она приходит на его адрес пополнения GUDEX
// (cryptoWallet в виджете) и зачисляется обычным путём, как любой входящий перевод.
// Пока не задан merchantId — ready=false, экран показывает «скоро».
export class ExchangeService {
  readonly ready: boolean;

  constructor(
    private readonly config: Config,
    private readonly wallet: WalletService,
  ) {
    this.ready = Boolean(config.WHITEBIRD_MERCHANT_ID) && wallet.depositMode === 'live';
  }

  async session(userId: string, locale: Locale): Promise<ExchangeSessionDto> {
    const base = {
      sdkUrl: this.config.WHITEBIRD_SDK_URL,
      mode: this.config.WHITEBIRD_MODE,
      themeMode: 'dark' as const,
      color: this.config.WHITEBIRD_COLOR ?? null,
      locale,
    };
    if (!this.ready) {
      return { ...base, ready: false, merchantId: null, merchantPass: null, options: [] };
    }
    const options = await Promise.all(
      OPTIONS.map(async ({ asset, network, currency }) => {
        const { address } = await this.wallet.getDepositAddress(userId, asset, network);
        return { asset, network, address, currency };
      }),
    );
    return {
      ...base,
      ready: true,
      merchantId: this.config.WHITEBIRD_MERCHANT_ID ?? null,
      merchantPass: this.config.WHITEBIRD_MERCHANT_PASS ?? null,
      options,
    };
  }
}
