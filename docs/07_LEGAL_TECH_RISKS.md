# Технические и юридические моменты

## Проверить у партнёра
- разрешён ли white-label;
- разрешён ли resale/issuance конечным пользователям;
- разрешена ли автоматизация broker-admin;
- есть ли скрытый/отдельно выдаваемый API;
- можно ли хранить partner credentials на сервере;
- какие данные можно показывать пользователю;
- доступны ли webhooks;
- поддерживаются ли Apple Pay/Google Pay;
- поддерживается ли card-to-card/remittance.

## KYC/AML
Нельзя обещать мгновенный выпуск всем пользователям, если финальное решение принимает issuer/partner.
Нужны статусы pending/rejected/approved.

## Card transaction lifecycle
Учитывать:
- authorization;
- capture;
- reversal;
- refund;
- chargeback;
- offline/adjusted transactions.

## Ledger
Баланс в UI не должен быть единственным источником истины.
Каждое движение должно иметь запись:
- deposit;
- withdrawal;
- swap;
- card funding;
- authorization;
- settlement;
- reversal;
- refund;
- fee.

## PCI / PAN / CVV
По возможности не пропускать полный PAN/CVV через собственный backend и не хранить чувствительные карточные данные без необходимости.

## Personal data
KYC-документы, selfie, address и phone требуют строгого доступа, шифрования, логирования и политики хранения/удаления.

## Browser automation
Нужны:
- idempotency;
- retries;
- queues;
- monitoring;
- manual fallback;
- session/2FA strategy;
- защита от duplicate issuance.
