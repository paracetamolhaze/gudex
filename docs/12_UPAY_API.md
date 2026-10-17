# Внутреннее API broker-admin (UPay)

Источник — запись запросов (HAR) из админки под администратором, 2026-10-16. В документе только адреса и названия полей:
значений, данных клиентов и токенов здесь нет. Официального API у UPay нет — это служебные запросы самой админки.

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
