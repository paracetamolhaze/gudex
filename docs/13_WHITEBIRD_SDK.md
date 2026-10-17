# Интеграция обменника WhiteBird (SDK)

Источник — публичные репозитории и живой SDK WhiteBird (разведка 2026-10-16). Их сайт whitebird.io из нашей сети не
открывается (TLS reset), но `sdk.whitebird.io` и `api.whitebird.io` доступны.

## Главное
- **SDK публичный.** Репозитории: `github.com/wb-io/sdk-wrapper` (web JS + Android + iOS), `github.com/whitebird-roman-gruzd/docs`
  (рус.), `whitebird-en-docs` (англ.). Презентация врала, что документации нет.
- **CDN скрипта:** `https://sdk.whitebird.io/v2.0/integration/wbExchangeSdk-v001.js`. У ответов нет X-Frame-Options —
  iframe встраивается. Есть DEV/QA хосты `*.wbdevel.net` (из нашей сети не отвечают).
- **Глобал:** `window.wbExchangeSdk = { mode, setup, cleanup }`. `setup(config)` вставляет iframe в `config.el`
  (контейнер шириной ≥ 360px). `cleanup()` убирает iframe.
- **Режимы (`wbExchangeSdk.mode`):**
  - `AuthMode` — вход + регистрация + KYC внутри iframe. **Для старта — этот.** Ключей, кроме `merchantId`, не требует.
  - `LoginMode` — только вход, без регистрации.
  - `TokensMode` — бесшовный вход без экрана WhiteBird: партнёр заранее получает токены клиента на сервере
    (`POST https://api.whitebird.io/api/v2/auth/merchant/client/token/generate`, заголовок `x-api-key`, тело `{clientId}`).
    **Требует статуса «агент идентификации»: AML-аудит и договор.** Это путь к «одной верификации», но не на старте.
- **Telegram Mini App — из коробки.** `isTgBot` ставится сам при `window.Telegram.WebApp`. Ссылки на оплату открываются
  через `tg.openLink`, экраны KYC/liveness — через `window.location.replace`.
- **Параметры setup (главные):** `el`, `merchantId`, `mode`, `merchantPass` (это НЕ серверный секрет — basic-токен, видимый
  клиенту), `cryptoWallet` (куда отправить купленную крипту), `currencyFrom`/`currencyTo` (сеть зашита в код валюты),
  `email`, `externalClientId`, `themeMode` 'light'|'dark', `color`, `showBackButtonOnHomePage`, `redirectUrl`.
- **Колбэки:** `onLogin({email, accessToken, refreshToken, isUserVerified})`, `onOrderCreated({orderId, internalCryptoAddress})`,
  `onOrderCompleted({orderId, status})`, `onPayment({orderId, transactionId})`, `onExit()`.
- **Коды валют (сеть внутри кода):** `USDT_TRC` (TRC-20), `USDT` (ERC-20), `USDT_TON`, `USDC` (ERC-20), плюс BTC/ETH/TRX/TON
  и фиат BYN/RUB/USD/EUR. USDT также на BEP-20 (код не подтверждён).

## Альтернатива SDK — серверный session flow
`POST https://api.whitebird.io/api/v3/exchange/merchant/session` (заголовок `x-api-key`), тело
`{fromAsset, fromAmount, toAsset, destinationCryptoAddress, externalClientId, redirectUrl}` → возвращает котировку и `sdk.url`
для открытия. **Вебхуки:** `order.processing`, `order.completed`, `order.expired`, `order.error`. Это чище всего: мы задаём
адрес получателя и получаем вебхук о зачислении. Но тоже требует `x-api-key`, то есть договора.

## Важные ограничения и факты
- **Крипта уходит только на «свои» кошельки клиента** (documented restriction). Наш адрес пополнения закреплён за конкретным
  клиентом и зачисляется на его баланс — формально его, но это точка для согласования с WhiteBird.
- **KYC — не Sumsub, а Cyberity/IDnGO** (рос. оператор ООО «КАБУТЕК», форк технологии Sumsub) + МСИ для Беларуси. Переиспользование
  верификации у Cyberity есть на уровне платформы (shareToken), но нет данных, что WhiteBird отдаёт его партнёрам. То есть
  «одна верификация на UPay и WhiteBird» из коробки недоступна.
- **Покупка картой РФ недоступна** — только продажа. Покупка у россиян идёт через СБП (~3,2%), SberPay (2,99%), MTS (2,5%),
  перевод по счёту (1,5%). Карты РБ 2,3–4,9%.
- **Партнёрские 0,4%** — только в PDF, публично нигде. Публичная реферальная ставка 0,3%.
- **Нужен `merchantId`** (а для session/tokens — `x-api-key`). Без него обменник не включится. Получить: b2b@whitebird.by,
  whitebird.io/b2b-info-page, в Telegram @Whitebird_official. Интеграция по их словам бесплатна, 2 недели–месяц.
- **Живые партнёры** (SDK/встраивание): Альфа-Банк (Беларусь, INSNC), БелВЭБ (UP Online), Wildberries BY, Хайс (РФ-финтех),
  Bitcash. Значит, продукт рабочий.
- **Риск:** 11.10.2026 у WhiteBird были сбои верификации новых клиентов из-за стороннего сервиса — KYC их слабое место.

## Что нужно от WhiteBird, чтобы включить
1. `WHITEBIRD_MERCHANT_ID` (боевой и тестовый).
2. Для бесшовной одной верификации (TokensMode/session) — `x-api-key` и статус агента идентификации (AML-аудит, договор).
3. Подтверждение, что можно слать купленную крипту на наш адрес пополнения клиента (cryptoWallet).
4. Разрешение на наш домен и работу в Telegram (камера для KYC уже разрешена в их iframe).
5. Условия: ставка партнёра, комиссии клиенту, лимиты, по каким странам (РФ, РБ, КЗ, УЗ, КГ).
