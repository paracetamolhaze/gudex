# Внутреннее API broker-admin (UPay)

Источник — запись запросов (HAR) из админки под администратором, 2026-10-16. В документе только адреса и названия полей:
значений, данных клиентов и токенов здесь нет. Ниже описаны служебные запросы самой админки. У UPay также есть отдельное [официальное Merchant/White-label API](https://upay-api-en.readme.io/reference/api-basic); доступ нашего broker-аккаунта к нему не подтверждён.

## Карточные коды и официальные уведомления (проверено 2026-10-17)

- Официальный [формат карточных webhook](https://upay-api-en.readme.io/reference/push-data-format) предусматривает события `3DS_OTP`, `3DS_CONFIRM` (код или ссылка) и `NE_VERIFY` (активация, блокировка/разблокировка, установка/смена PIN, просмотр карты). Это подтверждает возможность доставки соответствующих кодов на сервер интегратора, но не текущий канал доставки нашего карточного продукта или доступность событий на broker-аккаунте.
- По [правилам подключения](https://upay-api-en.readme.io/reference/request-explanation) webhook задаётся в white-label backend, а адрес передаётся UPay для проверки. Нужны ключи подписи и шифрования; логин, пароль, TOTP и Payment Password панели их не заменяют.
- В текущем GUDEX приём этих уведомлений и показ кодов клиенту не реализованы. Текущий номер/email назначения не подтверждены. Физические SMS на SIM-карту не становятся доступными серверу лишь из-за наличия номера в анкете клиента.
- Публичный JS broker-admin содержит раздел `MessageManagement` (`/card-manage/notice-manage`, permission `notice-manage`, просмотр `notice-manage-detail`). Его таблица использует `GET /api/v1/agent/callback/list`: `msgType=2` означает Verification Code; колонка `typeName` называется Notification Method. Статусы Not Pushed/Pushing/Completed/Failed и поле `lastTime` относятся к отправке уведомлений; это не доказанный inbox клиентского приложения UPay. Enum доставки SMS/email/APP в компоненте не найден. Содержимое сообщений при разведке не запрашивалось. В меню исходной HAR-записи permission `notice-manage` отсутствует; native router блокирует прямой переход без этого права.
- У наблюдаемого callback-list запроса только фильтры `pageNo`, `pageSize`, `orderNo`, `state`, `msgType`, `businessType`. Поля `cardId`/`customerNo` в его форме отсутствуют, а `body` приходит сразу в списке. Поддержка сервером фильтра только собственных карточных кодов не подтверждена; общий опрос сообщений брокера не реализовывать на основании этого контракта.
- Владелец уточнил, что на работающей карте код появляется в **UP Business**, а не в новом UPay Wallet. Это пользовательское наблюдение, не подтверждение конкретного native endpoint. `copyEmail`/`copyPhone` в форме выпуска являются копиями уже сохранённых контактов, а не настройкой пересылки кодов.
- В публичных UP Business bundles (`https://business.upay.com/_nuxt/DSOHkCxm.js`, `C6-mOj7E.js`, `CujEUTX8.js`) есть личный inbox: `GET /api/v1/app/message/list` (`pageNo`, `pageSize`, `onlyUnread`) и `GET /api/v1/app/message/{id}` с клиентским `token`, `Source: Web` и `DeviceID`. Отрисовываются `title`, `body`, `url`, `updateTime`; чтение карточного OTP и доступ брокерской учётки этим не подтверждены. Реальные сообщения не запрашивались.
- **Веб-вход найден и проверен без авторизации:** `https://business.upay.com/loginRM` отображает форму Login с email/телефоном и паролем. Компонент `sKzh5izC.js` и route-table подтверждают `/loginRM`. Первоначально проверенный `/login` отсутствует в route-table и ведёт на `/404`; это не доказывает недоступность всей клиентской веб-версии. Фактический вход и получение карточных кодов через неё ещё не проверены.
- В изученном клиентском коде сессия хранится в cookie `token`; серверный TTL не установлен. Наличие этой клиентской сессии не даёт оснований подменять её брокерским `brokerToken`. Автоматический перевход/refreshToken в прочитанном main не найден.
- Экран сообщения UP Business после загрузки вызывает отдельный `GET /api/v1/app/message/read?msgId=...`; есть и `message/read/all`. Открытие сообщения через UI может отмечать его прочитанным. Для пассивной диагностики отделять получение тела от отметки прочтения; эти методы не добавлять в список безопасного чтения.
- Broker `GET /validate/getMsgCode` **отправляет** email-код для установки/смены Payment Password (`FundPass-CEbl74St.js`, `codeType=13/14`, `security=1`); это не чтение карточного OTP. GET-метод сам по себе не означает отсутствие побочного эффекта.
- Найденный `POST /v1/card/reap/confirm3Ds` подтверждает операцию, а не читает код; он не вызывался. Quick Link связывает карту с клиентским аккаунтом, но не подтверждает пересылку кодов оплаты. Для дальнейшей проверки требуется разрешённая личная сессия UP Business владельца работающей карты и установление реального источника его уведомлений; один broker-login не объявлять достаточным.
- **Подтверждение по ссылке имеет побочный эффект при открытии.** В публичном `https://business.upay.com/_nuxt/DpH7pNv2.js` маршрут `/confirm/:id` во время setup вызывает подтверждение с `state=1` и `validateCode` из URL; основной клиент отправляет это через POST `confirm3Ds`. Не открывать, не префетчить и не создавать исполняемое превью таких ссылок при сборе уведомлений. Ни одна реальная ссылка подтверждения при разведке не открывалась.
- Проверена статически официальная Android-сборка UP Business `com.upay.best`, версия `1.7.12`, build `812`, из каталога `https://business.upay.best/api/v1/app/down?isOld=true`. SHA-256 APK: `6d6930f03ef1680e502280a23b151de0886023e0a73cdf44ad46f94f2b4cf725`. В ARM64 AOT есть строки `/api/v1/card/opc/info`, `/api/v1/card/reap/generateOps`, `confirm3Ds`, методы сообщений и Firebase. Приложение не устанавливалось и не запускалось. Эти строки не устанавливают HTTP-метод, параметры, назначение ответа, отсутствие побочного эффекта или серверные права. `opc/info` и `generateOps` не найдены в 261 JS-asset, перечисленных проверенным публичным веб-клиентом; пробные запросы к ним не выполнялись. Наличие Firebase/email-строк не доказывает канал доставки карточных OTP.
- Контракт `GET /api/v1/agentSetting/getSetting` предусматривает `type`, `webhook` и ключи. UI Access Management показывает API/webhook для `type=1` или `3`, `authUrl` только для `3`. Наличие этого кода не подтверждает тип/возможности конкретного аккаунта. Ответ настройки может содержать секреты: допустима только обработка в памяти с закрытой проекцией наличия полей.
- Будущая реализация должна проверять подпись и привязку `cardId`/`customerNo` к авторизованному владельцу, ограничивать срок хранения кодов и исключать OTP, полные номера карт и тела webhook из журналов.

## Номера под управлением GUDEX: результаты проверки 2026-10-17

Владелец уточнил: клиенты живут за рубежом, GUDEX остаётся на UPay; рассматривается предоставление клиентам номеров под управлением GUDEX с показом входящих кодов в Mini App. Это предложение архитектуры, а не разрешение менять существующие контакты, покупать номера или выпускать карты.

- В native customer-create телефон условно необязателен на уровне формы: правила включаются при непустом `phone`. Приём пустого номера сервером не проверен. Отдельный primary `/kyc/submit` отправляет документы, `nationalityCode` и `customerNo`, без телефона. Это не доказывает возможность пройти весь выпуск без контакта: публичный [OpenAPI customer/add](https://upay-api-en.readme.io/reference/post_api-v1-customer-add) требует `globalCode` и `phone`.
- В native выпуске контакт берётся из клиента, а billing address имеет собственные обязательные `intlDialCode`/`phone`. GUDEX сейчас берёт их из KYC-профиля; отдельный `notificationPhone` не обнаружен. Для предоставляемого номера потребуется отдельная модель назначения номера клиенту и согласованное использование контакта, а не подмена страны документа или проживания.
- В проверенных [общих условиях](https://upay.com/terms) не найдено явного требования регистрации SIM на паспорт держателя, но также не найдено явного разрешения на номера брокера/VoIP. Требуются достоверные сведения и доступность по указанным контактам. [Google Pay Terms](https://support.upay.com/hc/en-us/articles/15103597913628-Google-Pay-Terms-and-Conditions) предусматривают полномочия разрешать сообщения/звонки на предоставленный номер; для некоторых сценариев добавления карты описан SMS OTP. Это не подтверждает доставку 3DS конкретной брокерской карты по SMS.
- Публикация [Restricted & Prohibited Countries List](https://support.upay.com/hc/en-us/articles/26613460878620-Restricted-Prohibited-Countries-List) прямо описывает ограничения по гражданству для Premier BIN `446614` и Platinum BIN `493875`; в обоих списках есть RU, BY и UA. Казахстан в этих опубликованных списках отсутствует. Проживание за рубежом и иностранный контакт сами по себе не отменяют ограничения по гражданству. Соответствие нашего продукта `2040769880440840193` одному из этих цифровых BIN по имеющимся материалам не установлено; не распространять список автоматически на все продукты UPay.
- Кандидат для технической реализации: постоянный выделенный номер на клиента → приём SMS → серверная привязка номера к владельцу → показ кода только в его авторизованной Mini App. Не использовать один общий номер для маршрутизации кодов разных клиентов без доказанного идентификатора получателя. Срок хранения ограничивать, содержимое SMS и OTP не журналировать. Поддержка входящих SMS у оператора не доказывает принятие номера эмитентом или доставку банковских сообщений.
- Если нужный код доставляется только в UP Business, SMS-приёмник его не получит. Для этой ветки требуется проверка личной сессии владельца работающей карты и фактического формата уведомления; broker login не считать эквивалентом такой сессии.
- В публичных UP Business bundles `CoPuZxkB.js` и `DVIRSA9T.js` есть отдельный личный выпуск (`card/apply/submit`, `card/apply/pay`) с KYC, адресом, контактом и PIN; в наблюдаемом direct-pay контракте `bindingCode` отсутствует. Это наличие реализации, а не подтверждение доступности потока после входа, связи с нашим брокером или действующего тарифа. Регистрация email/phone и наличие личного выпуска не означают автоматическую привязку брокерской карты.

## Общее
- Базовый адрес: `https://broker-admin.upay.plus/api/v1`.
- Ответ всегда `{ success, code, msg, ts, data }`; списки — `data: { pageNo, pageSize, totalSize, totalPages, list }`.
- Заголовки каждого запроса: `token` (сессия входа), `deviceid`, `datetime` (`YYYY-MM-DD HH:mm:ss`), `pretreatment: true`,
  `language: en-US`, `x-b3-traceid` / `x-b3-spanid`.
- ⚠️ Chrome при экспорте HAR вырезает только cookies и Authorization — заголовок `token` остаётся в файле. Такой файл
  содержит действующую сессию: после записи нужно выйти из админки и удалить файл.

## Справочники (значения из записи)
- Статусы карты (`/card/state/list`): 1 Normal, 2 Pending Activation, 3 Frozen, 4 Locked, 5 Deactivated, 7 Activating,
  8 Locking, 9 Unlocking, 10 Deactivating, 13 Rejected, 14 Cancelled, 15 Replacing, 16 Replaced. Заморозка в UPay есть.
- Статусы KYC клиента: 4 Unverified, 3 Pending, 1 Approved, 2 Rejected.
- Статусы транзакций по карте: 1 Success, 2 Failed, 3 Processing, 4 Posted, 5 Unposted, 6 Payment failed, 7 Cancelled, 8 Partial Posting.
- Статусы выпуска карты (`/card/getCardOperateStatus?operateType=5`): 1 Successful, 2 Pending Documents, 3 Under Initial Review,
  6 Card Making, 7 Pending Activation, 8 Review Failed, 9 Cancelled, 10 Activating, 11 Pending, 12 Binding Success,
  13 Final Review Failed, 14 Rejected, 15 Card Fee Refunded, 57 Deactivated, 64 Replaced.
- Типы операций с картой: 1 Open Card, 2 Top Up.
- Продукты (`/card/getPageToMayApplyCard`): Premier Virtual Card `2040769880440840193`, Premier Physical Card
  `2040770116521435138`, VIP Premier Metal Card `2104504506824716289`; валюта карты USD, пополнение в USDT.
- Группы клиентов и тарифы: Default Group (без тарифа), Martin «1.7% 20 and 120$», GudEx Bot «GudEx bot 1.5% 20$ and 120$»,
  0.7 «0.7%». Фактически выпуск виртуальной карты в истории — 10 USDT, физической — 70 USDT, пополнение — 0,7%.

## Тарифы (Card Rate Details, 3 группы)

Колонки «Customer …» — цена для того, кто в группе. Себестоимость брокера из истории операций: выпуск виртуальной 10 USDT,
физической 70 USDT, пополнение 0,7%. Значит, в цене группы заложена наценка UPay над себестоимостью, разница возвращается
брокеру («Commission Rebate» в Merchant Bills).

| Группа | Карта | Customer Issuance Fee | Customer Recharge Rate |
|---|---|---|---|
| 0.7% | Premier Virtual | 20.00 | 0.70% |
| 0.7% | Premier Physical | 120.00 | 0.70% |
| GudEx Bot 1.5% | Premier Virtual | 20.00 | 1.50% |
| GudEx Bot 1.5% | Premier Physical | 120.00 | 1.50% |
| 1.7% (Martin) | Premier Virtual | 20.00 | 1.70% |
| 1.7% (Martin) | Premier Physical | 120.00 | 1.70% |

Вывод: выпуск (20 вирт. / 120 физ.) одинаков во всех группах, различается только процент пополнения (0,7 / 1,5 / 1,7).
Группы — это просто разные ценовые уровни, кто-то их завёл в кабинете. Для нашего приложения цену клиенту задаём мы сами
(в нашем конфиге), UPay платим себестоимость. Открытый вопрос: платит ли брокер при выпуске из своего баланса себестоимость
(10/70/0,7%) или цену группы (20/120/%). Проверяется по Merchant Bills → Commission Rebate после первого реального выпуска.

## Что ещё не записано
Вход/TOTP восстановлены по публичному JS и проверены в production 2026-10-16; статические контракты финансовых форм описаны в [15_UPAY_PROTOCOL_EVIDENCE.md](15_UPAY_PROTOCOL_EVIDENCE.md). Следующий список относится именно к исходной HAR-записи, а не к текущей реализации.

Вход (логин, 2FA), создание клиента, загрузка KYC, выпуск карты, пополнение, заморозка/разморозка, реквизиты карты.
Записать при оформлении реального клиента с открытой вкладкой «Сеть».

## Запросы из записи
| Метод | Путь | Параметры | Поля ответа |
|---|---|---|---|
| GET | `/address/getPage` | pageNo, pageSize | id, no, name, intlDialCode, phone, email, countryId, countryName, provinceId, provinceName, cityId, cityName, postalCode, address |
| GET | `/agent/info` |  | id, companyName, contacts, email, globalCode, phone, country, countryName, address, state, createTime, merchantNo |
| GET | `/agentOperateLog/getPage` | pageNo, pageSize, operatedTimeBegin, operatedTimeEnd | pageNo, pageSize, totalSize, totalPages, list, prevPage, nextPage |
| GET | `/asset/coin/list` |  | coinName, symbol, logo, decimals, coinId, inMinAmount, depositRate, internalOutMinAmount, internalOutMaxAmount, chainListRes, isSupportQuickDeposit, ditchInfos |
| GET | `/asset/convert` |  | symbol, totalBalance, assetList |
| GET | `/asset/list` | pageNo, pageSize | id, userId, symbol, balance, frozenBalance, riskFrozenBalance, manualFrozenBalance, swapFrozenBalance, borrowFrozenBalance, remitFrozenBalance, frozenBalanceTotal, amlBalance, createTime, updateTime |
| GET | `/bill/list` | pageNo, pageSize, orderType, type, startTime, endTime | id, orderNo, amount, symbol, createTime, tradeTime, type, state, dataClass, inOut, selfType, selfId, last4, ditchCardName |
| GET | `/card/customerGroupOptions` |  | value, label, status, statusName |
| GET | `/card/deposit/choose/type` |  | code, nameZh, nameEn |
| POST | `/card/deposit/statistical` | pageSize, pageNo, operateType | totalOpenFee, totalDeposit |
| POST | `/card/getCardBalanceTotal` |  | symbol, balanceTotal |
| GET | `/card/getCardOperateStatus` | operateType | value, label, status, statusName |
| GET | `/card/getCurrencyInfo` |  | value, label, status, statusName |
| POST | `/card/getPageToCardOperateRecord` | pageSize, pageNo, operateType | cardName, cancelSourceName, openCardType, issuanceTime, maskedCardNumber, operateAt, paymentAmount, rechargeFeeRate, exchangeRate, statusName, currency, currencyId, customerGroupNo, openCardAmount |
| GET | `/card/getPageToMayApplyCard` | pageSize, pageNo | agentCardId, cardName, cardBin, type, cardImage, organization, cardCurrency, rechargeCurrency, kycLevel, cardModel |
| POST | `/card/getPageToTransaction` | pageSize, pageNo, transactionBeginTime, transactionEndTime, transactionType | billId, orderNo, cardNumber, type, typeName, status, statusName, amount, direction, directionName, merchantName, transactionTime, currency, createTime |
| GET | `/card/getSelectCardInfo` |  | value, label, status, statusName |
| GET | `/card/getTransactionStatus` |  | value, label, status, statusName |
| GET | `/card/list` | pageSize, pageNo | agentCustomerCardId, accountCardId, customerNo, brokerCardId, cardNumber, symbol, balance, cardMark, cardType, cardName, state, stateName, email, cardSignatureName |
| GET | `/card/listOriginalCurrency` |  | value, label, status, statusName |
| GET | `/card/rate/list` | pageNo, pageSize | batchNo, name, customerGroupName, customerGroupNo |
| GET | `/card/state/list` |  | code, name |
| GET | `/customer/group/list` | pageNo, pageSize | id, no, name, remark, rateBatchNo, cardRateName, isDefault |
| GET | `/customer/kyc/status/select` |  | value, label, status, statusName |
| GET | `/customer/list` | pageNo, pageSize | customerId, accountId, no, email, globalCode, phone, givenName, lastName, groupId, groupName, groupNo, state, createTime, source |
| GET | `/deposit/aml/apply/status/select` |  | value, label, status, statusName |
| GET | `/deposit/aml/frozen/status/select` |  | value, label, status, statusName |
| GET | `/deposit/aml/material/status/select` |  | value, label, status, statusName |
| GET | `/deposit/aml/order/status/select` |  | value, label, status, statusName |
| POST | `/deposit/aml/page` | pageNo, pageSize | id, createTime, agentType, exportCreateTime, customerNo, depositType, depositTypeName, orderNo, symbol, chainTag, from, to, txHash, receiptType |
| GET | `/deposit/aml/receipt/type/select` |  | value, label, status, statusName |
| GET | `/deposit/aml/refund/status/select` |  | value, label, status, statusName |
| GET | `/deposit/aml/return/method/select` |  | value, label, status, statusName |
| GET | `/deposit/aml/risk/level/select` |  | value, label, status, statusName |
| POST | `/deposit/aml/stats` |  | pendingApplyCount, materialReviewingCount, materialPassedCount, pendingAppealCount, appealReviewingCount, appealPassedCount |
| GET | `/earn/bill/detail/coin` |  | coinId, symbol, coinLogoUrl |
| GET | `/earn/bill/detail/income` | pageNo, pageSize | cumulativeIncome, currency, pageResult |
| GET | `/earn/bill/detail/opType` |  | code, name |
| POST | `/fiat/asset/bill/page` | pageNo, pageSize, type, state, orderNo | pageNo, pageSize, totalSize, totalPages, list, prevPage, nextPage |
| GET | `/fiat/asset/bill/status/select` |  | value, label, status, statusName |
| GET | `/fiat/asset/coin/select` |  | value, label, status, statusName |
| POST | `/sys/member/list` | pageNo, pageSize, name, status | id, name, email, roleName, createTime, teamName, status, teamId, roleId, isAgent |
| GET | `/sys/permission/homeMenu` |  | id, name, type, title, route, parentId |
| POST | `/sys/role/list` | pageSize, pageNo | id, name, status, source, sourceName, code, createTime |
| GET | `/team/list` | pageSize, pageNo | id, no, name, leaderName, createTime, isDefault |
