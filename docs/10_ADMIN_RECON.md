# Разведка broker-admin (UPay Business)

Статус: в процессе. Источник — скриншоты владельца от 2026-10-07 (два раунда).

## Общее
- Адрес: `broker-admin.upay.plus`, бренд «UP Business». Merchant ID 10206, компания GudEx Crypto.
- Панель — SPA с hash-роутингом. Данные подгружаются с сервера внутренними HTTP-запросами — это и есть путь для автоматизации. Эндпоинты ещё не сняты (нужен DevTools → Network).
- В изученном broker-admin раздел Settings → Access Management показывает только Merchant ID и название компании; ключи и вебхуки там не обнаружены. У UPay есть отдельное [официальное Merchant/White-label API](https://upay-api-en.readme.io/reference/api-basic), но доступ нашего broker-аккаунта к нему не подтверждён. Учётные данные входа в панель не заменяют API Key и Secret Key.

## Карта меню
| Раздел | Подраздел | Маршрут | Изучено |
|---|---|---|---|
| Home | — | `#/` | ✅ |
| Account Management | Account Management | `#/account-manage/account` | ✅ |
| | Merchant Bills | `#/account-manage/merchant-bills` | ✅ |
| Wallet Management | Fund Control | ? | ❌ |
| Card Management | Quick Card Issuance | `#/card-manage/quick-card` | ✅ |
| | Card List | `#/card-manage/card-list` | ✅ |
| | Transaction History | ? | ❌ |
| | Card Open/Recharge Records | ? | ❌ |
| | Customer Management | `#/card-manage/customer-manage` | ✅ |
| | ↳ Add Customer | `#/card-manage/new-customers` | ✅ |
| | ↳ KYC Certification | `#/card-manage/kyc-certification/<customerId>` | ✅ |
| | ↳ Card Issuance Application | `#/card-manage/quick-card/<productId>` | ✅ |
| | Customer Group Mgmt. | ? | ❌ |
| | Card Rate Management | ? | ❌ |
| | Address Management | `#/card-manage/address-manage` | ✅ |
| Team Management | Merchant Information | ? | ❌ |
| | Role/Permission Mgmt. | ? | ❌ |
| | Team Management | ? | ❌ |
| | Member Management | ? | ❌ |
| | Operation Logs | ? | ❌ |
| Settings | Access Management | `#/setting/access-manage` | ✅ |
| Профиль (Personal Center) | — | `#/user-center` | ✅ |

## Модель данных UPay (как видно из панели)

```
Customer (клиент брокера)  ──KYC──▶  Card (одна или несколько)  ──▶  Recharge / Collateral
   │                                   │
   └── Address (адрес держателя)       └── Transactions
```

### Customer Management — клиенты
- Customer ID — число вида `1020601100xx`.
- Колонки: Primary Verification, Advanced Verification, KYC Verification Result, Email, Phone Number, Customer Group, Status.
- Действия: Details, Edit, Linked to customer groups, Card Information, **KYC certification**.
- **KYC проводит UPay** (Primary Verification). Advanced Verification у всех «Unverified» — для виртуальной карты, видимо, не нужна.
- Все текущие клиенты в группе «GudEx Bot».

### Address Management — адреса держателей
- Это **не криптоадреса**, а адресная книга держателей карт: Name, Phone, Email, Address, Tag. ID адреса — `1020604100xx`.
- Вероятно, адрес нужен при выпуске карты (billing address). Проверить по форме Apply for Card.

### Add Customer — создание клиента (`#/card-manage/new-customers`)
Обязательные поля (со звёздочкой) — только **Customer Group** и **Email**. Остальные необязательны:
- Phone Number (код страны + номер);
- Last Name / First Name (English). В UPay перепутаны подсказки: в поле фамилии написано «first name»;
- Signature — фото рукописной подписи (JPG/PNG до 2 МБ);
- Company Name, Occupation, Position, Annual Income (в 10 000 юаней, USD), Years of Work Experience;
- Address — выбор из Address Management;
- Remarks.

**Гражданства и даты рождения в форме нет.** Гражданство UPay, видимо, берёт из документа при проверке KYC.

### KYC Certification (`#/card-manage/kyc-certification/<customerId>`)
Два независимых блока, у каждого своя кнопка Submit и свой статус:
| Блок | Что загрузить | Ограничения |
|---|---|---|
| **ID Card** | Holding ID Card Front Photo + Back Photo | JPG/PNG до 2 МБ каждое |
| **Living** | Live Photo (Selfie), обязательно | JPG/PNG до 4 МБ |

Общий итог — Customer Verification Result. У клиента [customer ID omitted]: ID Card — Approved, Living — Unverified, итог — Approved. То есть **для одобрения хватает документа**, селфи — дополнительная проверка (Advanced Verification).

### Card Issuance Application — выпуск карты (`#/card-manage/quick-card/<productId>`)
Premier Virtual Card: productId `2040769880440840193`, BIN Standard, Visa, Standard Card.

| Поле | Значение |
|---|---|
| Customer ID | обязательно |
| Card Issuance Quantity | 1 |
| Card Currency | USD (фиксировано) |
| **Card Issuance Fee** | **10.00 USDT** |
| Initial Recharge Amount | в USDT, по умолчанию 0 — можно пополнить сразу при выпуске |
| **Recharge Fee** | **0.70%** |
| Recharge Exchange Rate | 1 USDT ≈ 1.0000 USD |
| Estimated Amount Posted | USD, считается автоматически |
| Payment Account | счёт брокера в USDT (Available 169.84 USDT) |
| Email, Phone Number | контакты держателя |

**Себестоимость для GUDEX:** выпуск 10 USDT, пополнение 0,70%. Сейчас в `apps/api/.env` стоят заглушки: выпуск 10 USD (наценка 0) и пополнение 1,5% (наценка 0,8%). Тарифы задаёт владелец.

### Quick Card Issuance — продукты
| Продукт | Тип | Режим |
|---|---|---|
| Premier Virtual Card | Virtual | Standard Card |
| Premier Physical Card | Physical | Standard Card |
| VIP Premier Metal Card | Physical | Standard Card |

Все — Visa. Для MVP берём **Premier Virtual Card**.

### Card List — карты
- Колонки: Customer ID, Card ID (32 hex-символа), Card Number (маска, последние 4), Card Name, Currency (USD), Card Balance, Consume Amount (USD), Card Mode, Card Organization (Visa).
- Действия: **Recharge** (виртуальные) / **Collateral** (физические), Details.
- Сверху — Total Card Balance по всем картам: готовая цифра для сверки с нашим счётом `system:card_issuer:USD`.

### Безопасность аккаунта (Personal Center)
- Вход по email и паролю, есть 2FA и отдельный **Payment Password** (вероятно, для финансовых операций).
- Боту понадобятся логин, пароль, 2FA и payment password — только в менеджере секретов.

### Счёт брокера (Account Management → Crypto Account)
- Мультивалютный: USDT, ETH, BTC, USDC, XUSD. Колонки AML Asset и Frozen Balance — UPay проверяет входящие средства по AML.
- XUSD — непонятный актив. Уточнить.

### Merchant Bills — журнал операций брокера
- Вкладки: Crypto Bills / Fiat Bills / Financial Statement.
- Типы: Deposit, Withdrawal, Card Issuance, Recharge/Collateral, Refund, Deactivate, Replace, **Remittance**, **Commission Rebate**.

## Выводы для архитектуры
1. **Текущая интеграция — через внутренний API панели.** Отдельное официальное Merchant/White-label API существует; его доступность для нашего аккаунта не подтверждена. Текущее состояние реализации см. в `apps/api/src/partner`; описание первоначальной разведки не является отчётом о готовности production.
2. **Цепочка у партнёра повторена в коде:** создать клиента → KYC у партнёра → выпустить карту на клиента → пополнить.
3. **Депозиты пользователей принимаем сами.** UPay не выдаёт отдельные криптоадреса клиентам, поэтому нужны свои адреса (свой HD-кошелёк или кастоди-провайдер) и перевод собранных средств на счёт брокера в Fund Control. Нужна и своя AML-проверка входящих: «грязный» USDT заморозят уже на стороне UPay.
4. **Отдельная учётка для бота** через Team Management + Role/Permission.
5. **Remittance** есть среди типов операций — возможно, путь для переводов (вопрос Kaspi).
6. **Модель дохода:** Card Rate Management + Customer Group + Commission Rebate.

7. **KYC в приложении надо переделать под UPay:** вместо даты рождения и гражданства — телефон и фото документа (лицевая и обратная сторона), селфи — по желанию. Фото документов — чувствительные данные: хранение только в зашифрованном виде и с удалением после передачи партнёру.
8. **Выпуск и первое пополнение можно делать одной операцией** (Initial Recharge Amount).

## Что ещё нужно (следующий раунд скринов)
- Окно **Recharge** у карты (комиссия, минимум). Не подтверждать.
- **Card Rate Management** (себестоимость и наши наценки).
- **Fund Control** (как пополняется счёт брокера: сети, минимум).
- DevTools → Network при открытии Card List и Customer Management (без заголовков Authorization/Cookie).
- Тип 2FA и срок жизни сессии.
