# Функции приложения

## MVP
### Home
- общий баланс;
- USDT/USDC;
- последние операции;
- Add money;
- Send;
- Card.

### Card
- выпуск виртуальной карты;
- отображение статуса;
- доступный баланс;
- freeze/unfreeze, если поддерживается партнёром;
- лимиты, если поддерживаются;
- история карточных транзакций;
- реквизиты карты — только с безопасной архитектурой.

### Wallet
- receive;
- send;
- QR;
- transaction history.

### Exchange
- swap USDT/USDC и других поддерживаемых активов;
- курсы;
- комиссия;
- quote до подтверждения.

### Profile/Security
- KYC;
- Face ID / biometrics;
- device/session management;
- support.

## Позже
- on-ramp;
- off-ramp;
- P2P;
- internal transfers между пользователями GUDEX;
- bank transfer/remittance;
- physical card;
- Apple Pay / Google Pay, если программа партнёра это позволяет;
- cashback/rewards;
- scheduled payments;
- address book.

## Kaspi / card-to-card
Прямой Visa-to-Kaspi P2P нельзя считать доступным, пока партнёр не подтвердит card-to-card/remittance capability.
Реалистичные варианты:
- crypto withdrawal → off-ramp → KZT → Kaspi;
- remittance/bank transfer, если доступен у партнёра.
