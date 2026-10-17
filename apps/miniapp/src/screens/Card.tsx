import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import type { CardDto, CardSensitiveDto } from '@gudex/shared';
import { BankCard } from '../components/BankCard';
import { AdditionalAttemptEntry } from '../components/AdditionalAttemptEntry';
import { Icon } from '../components/Icon';
import { Celebrate, Mascot } from '../components/Mascot';
import { ActivityRow, KycBanner, ServiceNotice, TestModeBanner } from '../components/misc';
import { useConfirmation } from '../components/security';
import { ActionButton, Button, ConfirmSheet, Loading, Notice, Page, QueryError, SectionTitle, Surface } from '../components/ui';
import { useFormat } from '../lib/format';
import { useActivity, useCardSensitive, useCards, useConfig, useMe, useOperation, useSetFrozen, useSimulatePurchase } from '../lib/queries';
import { haptic, platform } from '../lib/telegram';

const DETAILS_VISIBLE_MS = 30_000;
export const walletName = platform === 'android' ? 'Google Pay' : 'Apple Pay';

// Реквизиты карты: только после кода-пароля или биометрии, скрываются через 30 секунд.
export function useRevealDetails(cardId: string) {
  const { t } = useTranslation();
  const { confirm, element } = useConfirmation();
  const sensitive = useCardSensitive(cardId);
  const [details, setDetails] = useState<CardSensitiveDto | null>(null);

  useEffect(() => {
    if (!details) return;
    const timer = setTimeout(() => setDetails(null), DETAILS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [details]);

  const reveal = async () => {
    const token = await confirm(t('security.revealReason'));
    if (!token) return;
    const result = await sensitive.mutateAsync(token).catch(() => null);
    if (result) haptic.success();
    setDetails(result);
  };

  return { details, reveal, hide: () => setDetails(null), loading: sensitive.isPending, error: sensitive.error, element };
}

export function CardScreen() {
  const { t } = useTranslation();
  const cards = useCards();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (cards.isLoading) return <Loading />;
  if (cards.error && !cards.data) return <Page title={t('card.title')} tabbar><QueryError error={cards.error} onRetry={() => void cards.refetch()} /></Page>;
  const list = cards.data ?? [];
  if (list.length === 0) return <NoCard />;
  const card = list.find((c) => c.id === selectedId) ?? list[0]!;

  return (
    <Page title={t('card.title')} tabbar>
      <ServiceNotice />
      <TestModeBanner />
      {cards.error ? <QueryError error={cards.error} onRetry={() => void cards.refetch()} /> : null}
      {list.length > 1 ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {list.map((c) => (
            <Button
              key={c.id}
              small
              title={c.last4 ? `•• ${c.last4}` : '••••'}
              variant={c.id === card.id ? 'primary' : 'secondary'}
              onClick={() => setSelectedId(c.id)}
            />
          ))}
        </div>
      ) : null}
      <CardView key={card.id} card={card} />
    </Page>
  );
}

function CardView({ card }: { card: CardDto }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const activity = useActivity(50);
  const setFrozen = useSetFrozen(card.id);
  const purchase = useSimulatePurchase(card.id);
  const reveal = useRevealDetails(card.id);
  const cards = useCards();
  const [sheetOpen, setSheetOpen] = useState(false);
  // Действие фиксируется при открытии окна, чтобы текст не менялся, пока окно закрывается.
  const [freezeAction, setFreezeAction] = useState<'freeze' | 'unfreeze'>('freeze');
  const [statusOpId, setStatusOpId] = useState<string | null>(null);
  const statusOp = useOperation(statusOpId);
  const [celebrate, setCelebrate] = useState(false);
  const previousStatus = useRef(card.status);
  const completedStatusOp = useRef<string | null>(null);

  // Карта выпустилась, пока пользователь смотрит на экран, — праздник.
  useEffect(() => {
    if (previousStatus.current === 'pending' && card.status === 'active') {
      haptic.success();
      setCelebrate(true);
    }
    previousStatus.current = card.status;
  }, [card.status]);

  const refetchCards = cards.refetch;
  useEffect(() => {
    const op = statusOp.data;
    if (!op || op.status === 'pending' || op.status === 'processing' || completedStatusOp.current === op.id) return;
    completedStatusOp.current = op.id;
    void refetchCards();
    if (op.status === 'succeeded') haptic.success();
    else haptic.error();
  }, [statusOp.data, refetchCards]);

  const active = card.status === 'active';
  const frozen = card.status === 'frozen';
  const busy = setFrozen.isPending || (statusOpId !== null && statusOp.data?.status !== 'succeeded' && statusOp.data?.status !== 'failed');
  const cardActivity = (activity.data ?? []).filter((a) => a.kind !== 'deposit' && a.cardLast4 === card.last4);
  const issueRestricted = card.issueRestriction === 'billing_phone_region_restricted';

  const toggleFrozen = async () => {
    setStatusOpId(null);
    const op = await setFrozen
      .mutateAsync({ frozen: freezeAction === 'freeze', idempotencyKey: crypto.randomUUID() })
      .catch(() => null);
    setSheetOpen(false);
    if (op) setStatusOpId(op.id);
  };

  return (
    <>
      <BankCard card={card} sensitive={reveal.details} />

      {card.status === 'pending' && (card.pendingOperationStatus === 'unknown' || issueRestricted) ? (
        <Surface className="stack card-operation-progress">
          <div className="card-operation-progress-copy" role="status" aria-live="polite">
            <span className="body-medium">{t(issueRestricted ? 'issue.restrictedTitle' : 'issue.reviewTitle')}</span>
            <span className="caption muted">{t(issueRestricted ? 'errors.card_region_restricted' : 'issue.reviewText')}</span>
          </div>
          <Button variant="secondary" title={t('common.refresh')} loading={cards.isFetching} onClick={() => void cards.refetch()} />
          {!issueRestricted && config?.integration.issuanceMode === 'automatic' ? <AdditionalAttemptEntry /> : null}
        </Surface>
      ) : card.status === 'pending' ? (
        <Surface className="promo">
          <Mascot pose="thinking" size={110} />
          <div className="stack-sm grow">
            <span className="body-medium">{t('issue.pendingTitle')}</span>
            <span className="caption muted">{t('issue.pendingText')}</span>
          </div>
        </Surface>
      ) : (
        <>
          <div className="stack-sm">
            <span className="label muted">{t('card.balance')}</span>
            <span className="display mono">{fmt.amount(card.balance, 'USD')}</span>
          </div>
          <div className="actions">
            <ActionButton icon="plus" label={t('card.topup')} disabled={!active || !config?.integration.capabilities.topup} onClick={() => navigate(`/card/topup?cardId=${card.id}`)} />
            <ActionButton
              icon={reveal.details ? 'eyeOff' : 'eye'}
              label={reveal.details ? t('card.hideDetails') : t('card.details')}
              onClick={reveal.details ? reveal.hide : reveal.reveal}
            />
            <ActionButton
              icon="snowflake"
              label={statusOp.data?.status === 'unknown' ? t('card.review') : busy ? t('card.processing') : frozen ? t('card.unfreeze') : t('card.freeze')}
              disabled={busy || !config?.integration.capabilities.freeze}
              onClick={() => {
                setFreezeAction(frozen ? 'unfreeze' : 'freeze');
                setSheetOpen(true);
              }}
            />
            <ActionButton icon="wallet" label={walletName} disabled={!active} onClick={() => navigate(`/wallet-pay?cardId=${card.id}`)} />
          </div>
        </>
      )}

      {reveal.details ? <CardDetails details={reveal.details} /> : null}
      {reveal.error ? <Notice tone="danger" text={fmt.error(reveal.error)} /> : null}
      {config && !config.integration.capabilities.freeze && (active || frozen) ? <Notice tone="warning" text={t('integration.freezeUnavailable')} /> : null}
      {setFrozen.error ? <Notice tone="danger" text={fmt.error(setFrozen.error)} /> : null}
      {statusOp.error ? <QueryError error={statusOp.error} onRetry={() => void statusOp.refetch()} /> : null}
      {statusOp.data?.status === 'failed' ? <Notice tone="danger" text={t('card.statusFailed')} /> : null}
      {statusOp.data?.status === 'unknown' ? <Notice tone="warning" text={t('card.statusUnknown')} action={<Button small variant="ghost" title={t('common.refresh')} onClick={() => void statusOp.refetch()} />} /> : null}

      {config?.devTools && config.integration.cardPartner === 'mock' && active ? (
        <Button
          variant="secondary"
          icon="flask"
          title={t('card.simulatePurchase')}
          loading={purchase.isPending}
          onClick={() => purchase.mutate({ amount: '15', merchant: 'Netflix' })}
        />
      ) : null}
      {purchase.error ? <Notice tone="danger" text={(purchase.error as Error).message} /> : null}

      <SectionTitle title={t('card.transactions')} />
      {activity.error ? <QueryError error={activity.error} onRetry={() => void activity.refetch()} /> : null}
      <Surface>
        {cardActivity.length ? (
          cardActivity.map((item) => <ActivityRow key={item.id} item={item} />)
        ) : activity.error ? null : (
          <span className="muted">{t('card.noTransactions')}</span>
        )}
      </Surface>

      <ConfirmSheet
        open={sheetOpen}
        icon="snowflake"
        title={freezeAction === 'unfreeze' ? t('card.unfreezeTitle') : t('card.freezeTitle')}
        message={freezeAction === 'unfreeze' ? t('card.unfreezeText') : t('card.freezeText')}
        confirmLabel={freezeAction === 'unfreeze' ? t('card.unfreeze') : t('card.freeze')}
        cancelLabel={t('common.cancel')}
        loading={setFrozen.isPending}
        onConfirm={toggleFrozen}
        onCancel={() => setSheetOpen(false)}
      />
      {reveal.element}
      {celebrate ? <Celebrate title={t('card.readyTitle')} text={t('card.readyText')} onClose={() => setCelebrate(false)} /> : null}
    </>
  );
}

export function CardDetails({ details }: { details: CardSensitiveDto }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const expiry = `${String(details.expiryMonth).padStart(2, '0')}/${String(details.expiryYear).slice(-2)}`;
  const rows = [
    { label: t('card.number'), value: details.pan.replace(/(\d{4})(?=\d)/g, '$1 '), copy: details.pan },
    { label: t('card.expiry'), value: expiry, copy: expiry },
    { label: t('card.cvv'), value: details.cvv, copy: details.cvv },
    { label: t('card.holder'), value: details.holderName, copy: details.holderName },
  ];
  return (
    <Surface className="stack">
      {rows.map((row) => (
        <div key={row.label} className="row">
          <div className="stack-sm grow">
            <span className="caption muted">{row.label}</span>
            <span className="body-medium mono">{row.value}</span>
          </div>
          <button
            className="link"
            aria-label={t('common.copy')}
            onClick={async () => {
              await navigator.clipboard?.writeText(row.copy).catch(() => {});
              haptic.success();
              setCopied(row.label);
            }}
          >
            <Icon name={copied === row.label ? 'check' : 'copy'} color="var(--primary)" size={20} />
          </button>
        </div>
      ))}
      <span className="caption muted">{t('card.detailsHint')}</span>
    </Surface>
  );
}

function NoCard() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data: config } = useConfig();
  const points = [t('card.emptyPoint1'), t('card.emptyPoint2'), t('card.emptyPoint3')];
  return (
    <Page title={t('card.title')} tabbar>
      <ServiceNotice />
      <TestModeBanner />
      <Mascot pose="card" size={240} motion="pop" />
      <h2 className="heading">{config?.card.productName ?? t('card.emptyTitle')}</h2>
      <div className="stack">
        {points.map((p) => (
          <div key={p} className="row">
            <Icon name="check" color="var(--primary)" size={20} />
            <span>{p}</span>
          </div>
        ))}
      </div>
      {config ? (
        <Surface>
          <div className="row between">
            <span className="muted">{t('card.issueFee')}</span>
            <span className="body-medium">{fmt.amount(config.card.issueFeeUsd, 'USD')}</span>
          </div>
        </Surface>
      ) : null}
      <KycBanner />
      <Button title={t('home.getCard')} icon="card" onClick={() => navigate(me?.kyc.status === 'approved' ? '/card/issue' : '/kyc')} />
    </Page>
  );
}
