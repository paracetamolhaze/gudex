# Примерные инфраструктурные расходы MVP

Оценки ориентировочные и зависят от нагрузки/провайдеров.

| Компонент | Ориентир / месяц |
|---|---:|
| Backend/API | $10–40 |
| Browser automation worker | $20–60 |
| PostgreSQL/Redis | $0–30 |
| Object storage | $5–20 |
| Monitoring/logging | $0–50 |
| Email | $0–20 |
| Push | обычно $0 на старте |
| SMS/OTP | зависит от страны, обычно поштучно |

Примерный технический MVP: около $50–150/мес на раннем этапе, без учёта карточных/KYC/финансовых комиссий.

## Store accounts
- Apple Developer: около $99/год.
- Google Play: около $25 единоразово.

## Главные переменные бизнеса
Не серверы, а:
- стоимость выпуска карты;
- recharge fee;
- transaction fee;
- FX fee;
- KYC cost;
- chargeback/reversal costs;
- broker rebate/markup;
- on-ramp/off-ramp fees.
