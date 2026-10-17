# GitHub / open-source референсы

## 1. DOK Wallet
Роль: основной кандидат на базу мобильного приложения.

Что полезно:
- React Native;
- multi-chain;
- buy/sell/swap;
- WalletConnect;
- biometrics;
- QR;
- transaction history;
- scheduled/batch payments;
- white-label подход.

Репозиторий:
https://github.com/KM-opensource-crypto-wallet/mobile_app

## 2. Gem Wallet
Роль: референс production wallet/exchange architecture.

Что полезно:
- native iOS/Android;
- Rust core;
- swaps;
- fiat on/off-ramp;
- market data;
- alerts;
- WalletConnect.

Репозиторий:
https://github.com/gemwalletcom/wallet

## 3. Coinbase Onramp V2 Mobile Demo
Роль: пример on-ramp/cash-out UX.

Что полезно:
- React Native / Expo;
- embedded wallet;
- Apple Pay purchase flow;
- transaction lifecycle;
- push;
- sandbox.

Репозиторий:
https://github.com/coinbase/onramp-v2-mobile-demo

## 4. BitPay Card Wallet
Роль: карточный UX/архитектурный референс.

Что полезно:
- card dashboard;
- card controls;
- transaction activity;
- front/back card UI;
- card settings.

Репозиторий:
https://github.com/Bitpay-Card/bitpay-card-wallet

Важно: отдельно проверить происхождение, актуальность и лицензию перед использованием кода.

## 5. Tether WDK UI Kit
Роль: UI-компоненты для wallet/mobile.

Что полезно:
- React Native;
- wallet UI;
- transaction lists;
- light/dark;
- branded components.

Репозиторий:
https://github.com/tetherto/wdk-uikit-react-native

## 6. Bull Bitcoin Mobile
Роль: UX обмена и wallet + exchange.

Что полезно:
- Buy / Sell / Pay / Swap;
- wallet UX;
- exchange integration patterns.

Репозиторий:
https://github.com/SatoshiPortal/bullbitcoin-mobile

## 7. QvaPay Mobile
Роль: финтех UX, instant transfers, P2P marketplace.

Что полезно:
- balance;
- deposits;
- internal transfers;
- transaction history;
- P2P marketplace;
- receipts.

Репозиторий:
https://github.com/qvapay/mobile_app

## Рабочая комбинация
- DOK Wallet — основа;
- BitPay — Card UX reference;
- Coinbase Onramp — fiat on/off-ramp reference;
- QvaPay — transfers/P2P reference;
- Tether WDK — UI components;
- наш backend — partner automation.
