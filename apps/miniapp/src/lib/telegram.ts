// Обёртка над Telegram WebApp API (скрипт telegram-web-app.js подключён в index.html).
// Вне Telegram (в обычном браузере при разработке) все вызовы безопасно ничего не делают.

type HapticStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';

interface TgBiometricManager {
  isInited: boolean;
  isBiometricAvailable: boolean;
  biometricType: 'finger' | 'face' | 'unknown';
  isAccessGranted: boolean;
  isBiometricTokenSaved: boolean;
  init(callback?: () => void): void;
  requestAccess(params: { reason?: string }, callback?: (granted: boolean) => void): void;
  authenticate(params: { reason?: string }, callback?: (success: boolean, token?: string) => void): void;
  updateBiometricToken(token: string, callback?: (updated: boolean) => void): void;
}

interface TgWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name?: string; language_code?: string } };
  version: string;
  platform: string;
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  disableVerticalSwipes?(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  setBottomBarColor?(color: string): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback: {
    impactOccurred(style: HapticStyle): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  BiometricManager?: TgBiometricManager;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

const webApp: TgWebApp | null = window.Telegram?.WebApp ?? null;

export const inTelegram = Boolean(webApp?.initData);
export const initData = webApp?.initData ?? '';
export const platform = webApp?.platform ?? 'web';
export const tgUser = webApp?.initDataUnsafe.user ?? null;

const BACKGROUND = '#07090F';

export function setupTelegram(): void {
  if (!webApp) return;
  webApp.ready();
  webApp.expand();
  try {
    webApp.setHeaderColor(BACKGROUND);
    webApp.setBackgroundColor(BACKGROUND);
    webApp.setBottomBarColor?.(BACKGROUND);
    // Иначе свайп вниз по длинной странице сворачивает приложение.
    if (webApp.isVersionAtLeast('7.7')) webApp.disableVerticalSwipes?.();
  } catch {
    // Старые клиенты Telegram поддерживают не всё — это не критично.
  }
}

const supports = (version: string) => Boolean(webApp?.isVersionAtLeast(version));

export const haptic = {
  tap: () => supports('6.1') && webApp!.HapticFeedback.impactOccurred('light'),
  success: () => supports('6.1') && webApp!.HapticFeedback.notificationOccurred('success'),
  error: () => supports('6.1') && webApp!.HapticFeedback.notificationOccurred('error'),
  select: () => supports('6.1') && webApp!.HapticFeedback.selectionChanged(),
};

// Внешние ссылки открываются во встроенном браузере Telegram, ссылки t.me — внутри самого Telegram.
export function openLink(url: string): void {
  if (inTelegram) webApp!.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function openTelegramLink(url: string): void {
  if (inTelegram && supports('6.1')) webApp!.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

// Окно «Поделиться» Telegram со ссылкой и текстом.
export function shareLink(url: string, text: string): void {
  openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
}

export const backButton = {
  show(onClick: () => void): () => void {
    if (!inTelegram || !supports('6.1')) return () => {};
    webApp!.BackButton.onClick(onClick);
    webApp!.BackButton.show();
    return () => {
      webApp!.BackButton.offClick(onClick);
      webApp!.BackButton.hide();
    };
  },
};

// ─── Биометрия Telegram (Face ID / Touch ID / отпечаток) ─────────────────
// Токен разблокировки хранится в защищённом хранилище устройства и выдаётся только после биометрии.

export type BiometryKind = 'faceId' | 'touchId' | 'fingerprint' | 'face';

const manager = (): TgBiometricManager | null => (inTelegram && supports('7.2') ? (webApp!.BiometricManager ?? null) : null);

export const biometrics = {
  async init(): Promise<{ kind: BiometryKind | null; tokenSaved: boolean }> {
    const bm = manager();
    if (!bm) return { kind: null, tokenSaved: false };
    if (!bm.isInited) await new Promise<void>((resolve) => bm.init(resolve));
    if (!bm.isBiometricAvailable) return { kind: null, tokenSaved: false };
    const ios = platform === 'ios' || platform === 'macos';
    const kind: BiometryKind =
      bm.biometricType === 'face' ? (ios ? 'faceId' : 'face') : ios ? 'touchId' : 'fingerprint';
    return { kind, tokenSaved: bm.isBiometricTokenSaved };
  },

  // Сохраняет токен за биометрией. Первый раз Telegram спросит разрешение у пользователя.
  async saveToken(token: string, reason: string): Promise<boolean> {
    const bm = manager();
    if (!bm) return false;
    if (!bm.isAccessGranted) {
      const granted = await new Promise<boolean>((resolve) => bm.requestAccess({ reason }, resolve));
      if (!granted) return false;
    }
    return new Promise<boolean>((resolve) => bm.updateBiometricToken(token, resolve));
  },

  async authenticate(reason: string): Promise<string | null> {
    const bm = manager();
    if (!bm?.isBiometricTokenSaved) return null;
    return new Promise<string | null>((resolve) => bm.authenticate({ reason }, (ok, token) => resolve(ok && token ? token : null)));
  },

  async clear(): Promise<void> {
    const bm = manager();
    if (bm?.isBiometricTokenSaved) await new Promise<boolean>((resolve) => bm.updateBiometricToken('', resolve));
  },
};
