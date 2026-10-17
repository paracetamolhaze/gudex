import type { ExchangeSessionDto } from '@gudex/shared';

// Виджет обменника WhiteBird. Реальный API из их публичного SDK (github.com/wb-io/sdk-wrapper):
// глобал window.wbExchangeSdk = { mode, setup, cleanup }. setup() вставляет iframe в el,
// cleanup() убирает. Telegram Mini App определяется сам (isTgBot). См. docs/13_WHITEBIRD_SDK.md.

const scripts = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let promise = scripts.get(src);
  if (!promise) {
    promise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scripts.delete(src);
        reject(new Error(`Failed to load ${src}`));
      };
      document.head.appendChild(script);
    });
    scripts.set(src, promise);
  }
  return promise;
}

type SdkMode = Record<'AuthMode' | 'LoginMode' | 'TokensMode', unknown>;

interface WhiteBirdSdk {
  mode: SdkMode;
  setup(config: Record<string, unknown>): void;
  cleanup(): void;
}

export interface MountOptions {
  session: ExchangeSessionDto;
  // Какую валюту/сеть получить: адрес пополнения GUDEX клиента и код WhiteBird.
  option: ExchangeSessionDto['options'][number];
  // Вызывается, когда обмен оплачен/завершён — чтобы обновить баланс (крипта придёт на наш адрес).
  onArrived?: () => void;
}

// Монтирует виджет в контейнер и возвращает функцию, которая его убирает.
export async function mountWhiteBird(container: HTMLElement, { session, option, onArrived }: MountOptions): Promise<() => void> {
  if (!session.merchantId) throw new Error('WhiteBird is not configured');
  await loadScript(session.sdkUrl);
  const sdk = (window as unknown as { wbExchangeSdk?: WhiteBirdSdk }).wbExchangeSdk;
  if (!sdk?.setup) throw new Error('WhiteBird SDK did not load');

  const mode = sdk.mode[session.mode as keyof SdkMode] ?? sdk.mode.AuthMode;
  sdk.setup({
    el: container,
    merchantId: session.merchantId,
    mode,
    merchantPass: session.merchantPass ?? undefined,
    // Купленная крипта уходит на адрес пополнения GUDEX этого клиента.
    cryptoWallet: option.address,
    currencyTo: option.currency,
    themeMode: session.themeMode,
    color: session.color ?? undefined,
    showBackButtonOnHomePage: true,
    onOrderCompleted: () => onArrived?.(),
    onPayment: () => onArrived?.(),
    onExit: () => sdk.cleanup(),
  });

  return () => {
    try {
      sdk.cleanup();
    } catch {
      // Виджет мог уже убраться сам.
    }
    container.replaceChildren();
  };
}
