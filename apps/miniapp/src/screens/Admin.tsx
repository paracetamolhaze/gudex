import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { useConfirmation } from '../components/security';
import { Button, Field, Notice, Page, QueryError, Spinner, Surface } from '../components/ui';
import { ApiError } from '../lib/api';
import { CARD_TOPUP_ROUTES, type CardTopupAddresses } from '@gudex/shared';
import { adminKeys, adminQueryValid, assignWalletTransfer, canLinkManualCard, clientMailValid, documentObjectUrl, getAdminDocument, resolveAdminRequest,
  saveCardTopupAddresses, saveClientMail, updateAdminClient, useAdminAccess, useAdminApplications, useAdminClient, useAdminWalletTransfers,
  type AdminClient, type AdminDocument } from '../lib/admin';
import './Admin.css';

const statuses: Record<string, string> = {
  none: 'Не подана', pending: 'На проверке', approved: 'Подтверждено', rejected: 'Отклонено', unknown: 'Требует разбора',
  processing: 'В обработке', succeeded: 'Завершено', failed: 'Не выполнено', queued: 'В очереди', submitted: 'Отправлено',
  manual_review: 'Ручная проверка', manual_verified: 'Проверено администратором',
};
const documentNames = { front: 'Документ — лицевая сторона', back: 'Документ — оборотная сторона', selfie: 'Селфи' };
const date = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const identifierValid = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);

function Status({ value }: { value: string }) {
  return <span className={`admin-status ${['approved', 'succeeded', 'manual_verified'].includes(value) ? 'good' :
    ['unknown', 'rejected', 'failed'].includes(value) ? 'attention' : ''}`}>{statuses[value] ?? 'Неизвестный статус'}</span>;
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  return <div className="admin-detail"><dt>{label}</dt><dd>{value || '—'}</dd></div>;
}

// Images never enter React Query or storage. Closing, expiry and relocking revoke the URL.
function Documents({ userId, documents, onViewed }: { userId: string; documents: AdminDocument[]; onViewed: (id: string) => void }) {
  const [preview, setPreview] = useState<{ id: string; url: string; title: string; expiresAt: string; filename: string } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<{ controller?: AbortController; url?: string }>({});
  const close = () => {
    active.current.controller?.abort();
    if (active.current.url) URL.revokeObjectURL(active.current.url);
    active.current = {};
    setPreview(null);
    setLoading(null);
  };
  useEffect(() => () => {
    active.current.controller?.abort();
    if (active.current.url) URL.revokeObjectURL(active.current.url);
    active.current = {};
  }, []);
  useEffect(() => {
    if (!preview) return;
    const timeout = setTimeout(close, Math.max(0, Date.parse(preview.expiresAt) - Date.now()));
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(timeout); document.removeEventListener('keydown', onKey); };
  }, [preview]);
  const show = async (item: AdminDocument) => {
    close();
    const controller = new AbortController();
    active.current.controller = controller;
    setLoading(item.id);
    setError(null);
    try {
      const content = await getAdminDocument(userId, item.id, controller.signal);
      if (controller.signal.aborted) return;
      if (content.id !== item.id || content.kind !== item.kind || content.mimeType !== item.mimeType ||
        !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= Date.now()) throw new Error('Документ больше недоступен');
      const url = documentObjectUrl(content);
      active.current.url = url;
      setPreview({ id: item.id, url, title: documentNames[item.kind], expiresAt: item.expiresAt,
        filename: `kyc-${item.kind}.${content.mimeType === 'image/png' ? 'png' : 'jpg'}` });
    } catch {
      if (!controller.signal.aborted) setError('Не удалось открыть документ. Обновите заявку и повторите.');
    } finally { if (!controller.signal.aborted) setLoading(null); }
  };
  return <div className="stack">
    <div className="admin-document-list">{documents.map(item => <button className="admin-document" key={item.id}
      disabled={loading !== null || Date.parse(item.expiresAt) <= Date.now()} onClick={() => void show(item)}>
      <Icon name="eye" size={20} /><span className="grow"><strong>{documentNames[item.kind]}</strong>
        <span className="caption muted">{Math.ceil(item.size / 1024)} КБ · доступен до {date(item.expiresAt)}</span></span>
      {loading === item.id ? <Spinner /> : <Icon name="chevronRight" size={18} />}
    </button>)}</div>
    {!documents.length ? <p className="caption muted">Документы не сохранены или срок хранения завершён.</p> : null}
    {error ? <Notice text={error} tone="danger" /> : null}
    {preview ? <div className="admin-preview" role="dialog" aria-modal="true" aria-label={preview.title}>
      <div className="admin-preview-bar"><strong>{preview.title}</strong><button className="btn secondary small" onClick={close} autoFocus>Закрыть</button></div>
      <a className="btn secondary small" href={preview.url} download={preview.filename}>Скачать для UPay</a>
      <img src={preview.url} alt={preview.title} onLoad={() => onViewed(preview.id)}
        onError={() => { close(); setError('Не удалось прочитать изображение документа.'); }} />
    </div> : null}
  </div>;
}

const routeNames: Record<string, string> = { TRC20: 'TRC20 (Tron)', ERC20: 'ERC20 (Ethereum)', BEP20: 'BEP20 (BNB Chain)' };
const topupAddressValid = (network: string, value: string) => !value || (network === 'TRC20' ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value) : /^0x[0-9a-fA-F]{40}$/.test(value));

// Crypto addresses UPay gives this card for top-ups; the client sees them under «Пополнить».
function CardTopupAddressesForm({ card, busy, onSave }: { card: AdminClient['cards'][number]; busy: boolean; onSave: (addresses: CardTopupAddresses) => void }) {
  const [values, setValues] = useState<CardTopupAddresses>(card.topupAddresses);
  const valid = CARD_TOPUP_ROUTES.every(route => topupAddressValid(route.network, (values[route.key] ?? '').trim()));
  return <Surface className="stack">
    <h2 className="heading">Адреса пополнения карты{card.last4 ? ` •• ${card.last4}` : ''}</h2>
    <span className="caption muted">Адреса из UPay, привязанные к этой карте. Клиент увидит их в «Пополнить». Пустое поле — сеть не показывается.</span>
    {CARD_TOPUP_ROUTES.map(route => {
      const value = values[route.key] ?? '';
      return <Field key={route.key} label={`${route.asset} ${routeNames[route.network]}`} value={value} maxLength={64} disabled={busy} autoComplete="off"
        placeholder={route.network === 'TRC20' ? 'T…' : '0x…'} error={topupAddressValid(route.network, value.trim()) ? null : 'Адрес указан неверно'}
        onChange={event => setValues(previous => ({ ...previous, [route.key]: event.target.value.trim() }))} />;
    })}
    <Button title="Сохранить адреса" disabled={busy || !valid} onClick={() => onSave(values)} />
  </Surface>;
}

function ClientReview({ client, onUpdated }: { client: AdminClient; onUpdated: (value: AdminClient) => void }) {
  const kyc = client.kyc;
  const reviewing = kyc?.status === 'pending' && kyc.submissionState === 'manual_review' && Boolean(kyc.submissionId);
  const verifiedCustomerNo = kyc?.status === 'approved' ? kyc.partnerCustomerId : null;
  const [customerNo, setCustomerNo] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [mail, setMail] = useState(client.mail.address ?? client.mail.suggested ?? '');
  const [reason, setReason] = useState('');
  const [requestReasons, setRequestReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const confirmation = useConfirmation();
  const queryClient = useQueryClient();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const manualOperations = client.operations.filter(canLinkManualCard);
  const operation = manualOperations[0];
  const requests = client.operations.filter(item => item.fulfillmentMode === 'manual' && item.status === 'pending' && item.type !== 'issue');
  const canLink = Boolean(operation) && (reviewing || Boolean(verifiedCustomerNo));
  const canReject = reviewing || Boolean(operation);
  const digits = cardNumber.replace(/\D/g, '');
  const expiryMatch = /^(\d{2})\/(\d{2})$/.exec(expiry);
  const mailValid = clientMailValid(mail, client.mail.domain);
  // Only a missing mail domain needs a word: then codes cannot reach the client.
  const mailHint = client.mail.domain ? undefined : 'Домен почты не настроен: коды на эту почту не придут.';
  const cardReady = /^\d{13,19}$/.test(digits) && Boolean(expiryMatch) && /^\d{3,4}$/.test(cvv) && (!reviewing || identifierValid(customerNo)) && mailValid;
  const run = async (action: (token: string) => Promise<AdminClient>, prompt: string, completed: string, reset: () => void) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const token = await confirmation.confirm(prompt);
      if (!token || !mounted.current) return;
      const updated = await action(token);
      if (!mounted.current) return;
      reset();
      onUpdated(updated);
      setSuccess(completed);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'Не удалось выполнить действие. Обновите заявку и повторите.');
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <div className="admin-client stack">
    <Surface className="stack">
      <div className="row between"><div><span className="admin-eyebrow">Клиент</span><h2 className="heading">
        {[kyc?.firstName, kyc?.lastName].filter(Boolean).join(' ') || (client.username ? `@${client.username}` : 'Без анкеты')}</h2></div>
        {operation ? <span className="admin-status">Ожидает карту</span> : kyc ? <Status value={kyc.status} /> : null}</div>
      <dl className="admin-details"><Detail label="GUDEX ID" value={client.userId} /><Detail label="Telegram ID" value={client.telegramId} />
        <Detail label="Имя в Telegram" value={client.username ? `@${client.username}` : null} /><Detail label="Регистрация" value={date(client.createdAt)} /></dl>
    </Surface>
    {success ? <Notice text={success} /> : null}
    {error ? <Notice text={error} tone="danger" /> : null}
    {kyc ? <Surface className="stack">
      <div className="row between"><h2 className="heading">Анкета</h2><Status value={kyc.submissionState} /></div>
      <dl className="admin-details"><Detail label="Имя" value={kyc.firstName} /><Detail label="Фамилия" value={kyc.lastName} />
        <Detail label="Дата рождения" value={kyc.birthDate} /><Detail label="Гражданство" value={kyc.citizenship} />
        <Detail label="Почта" value={client.mail.address} /><Detail label="Телефон" value={[kyc.globalCode, kyc.phone].filter(Boolean).join(' ')} />
        <Detail label="Документ" value={kyc.documentType === 'id_card' ? 'ID-карта' : kyc.documentType === 'passport' ? 'Паспорт' : kyc.documentType === 'driving_license' ? 'Водительские права' : kyc.documentType} />
        <Detail label="Страна документа" value={kyc.documentCountry} /><Detail label="Customer ID в UPay" value={kyc.partnerCustomerId} />
        <Detail label="Обновлено" value={date(kyc.updatedAt)} /></dl>
      {client.billingAddress ? <>
        <h3 className="heading">Адрес</h3>
        <dl className="admin-details"><Detail label="Страна" value={client.billingAddress.countryName
          ? `${client.billingAddress.countryName} (${client.billingAddress.countryId})` : client.billingAddress.countryId} />
          <Detail label="Почтовый индекс" value={client.billingAddress.postalCode} /><Detail label="Адрес" value={client.billingAddress.address} /></dl>
      </> : null}
      <h3 className="heading">Фото документов</h3>
      <Documents key={`${client.userId}:${kyc.submissionId}:${kyc.updatedAt}`} userId={client.userId} documents={kyc.documents} onViewed={() => {}} />
    </Surface> : <Notice text="Клиент ещё не отправил анкету." />}

    {operation ? <Surface className="stack">
      <h2 className="heading">Оплата</h2>
      <Detail label="Зарезервировано с баланса клиента" value={operation.amount && operation.asset ? `${operation.amount} ${operation.asset}` : null} />
      <span className="caption muted">Заявка от {date(operation.createdAt)}. При отказе сумма вернётся клиенту на баланс.</span>
    </Surface> : reviewing ? <Notice tone="warning" text="Анкета отправлена без оплаты (старая версия приложения). Отклоните её с просьбой заполнить анкету заново." /> : null}

    {canLink ? <Surface className="stack">
      <h2 className="heading">Привязать карту</h2>
      <ol className="caption muted admin-steps">
        {reviewing ? <li>Создайте клиента в UPay по данным анкеты и фото документов. Email — из поля «Почта» ниже.</li> : <li>Проверьте, что у клиента в UPay указана почта из поля ниже.</li>}
        <li>Выпустите этому клиенту карту в UPay с нулевым пополнением.</li>
        <li>Укажите Customer ID — по нему бот найдёт карту этого клиента в UPay. Номер, срок и CVV нужны, чтобы клиент видел реквизиты после кода-пароля.</li>
      </ol>
      {reviewing ? <Field label="Customer ID в UPay" hint="Из таблицы клиентов UPay." value={customerNo} maxLength={128} disabled={busy} autoComplete="off"
        onChange={event => setCustomerNo(event.target.value.trim())} /> : <Detail label="Customer ID в UPay" value={verifiedCustomerNo} />}
      <Field label="Почта" hint={mailHint} value={mail} type="email" maxLength={254} disabled={busy} autoComplete="off" spellCheck={false}
        error={mail && !mailValid ? 'Проверьте почту' : null} onChange={event => setMail(event.target.value.trim().toLowerCase())} />
      <Field label="Номер карты" value={cardNumber} inputMode="numeric" maxLength={23} disabled={busy} autoComplete="off" placeholder="4462 0000 0000 0000"
        onChange={event => setCardNumber(event.target.value.replace(/[^\d ]/g, ''))} />
      <div className="admin-fields">
        <Field label="Срок (ММ/ГГ)" value={expiry} inputMode="numeric" maxLength={5} disabled={busy} autoComplete="off" placeholder="12/29"
          onChange={event => { const value = event.target.value.replace(/\D/g, '').slice(0, 4); setExpiry(value.length > 2 ? `${value.slice(0, 2)}/${value.slice(2)}` : value); }} />
        <Field label="CVV" value={cvv} inputMode="numeric" maxLength={4} disabled={busy} autoComplete="off"
          onChange={event => setCvv(event.target.value.replace(/\D/g, '').slice(0, 4))} />
      </div>
      <Button title="Привязать карту клиенту" disabled={busy || !cardReady}
        onClick={() => void run(token => updateAdminClient(client.userId, 'card', { operationId: operation!.id, cardNumber: digits,
          expiryMonth: Number(expiryMatch![1]), expiryYear: Number(expiryMatch![2]), cvv, email: mail, ...(reviewing ? { customerNo } : {}) }, token),
          'Привязать эту карту клиенту', 'Карта привязана. Клиент получил уведомление в Telegram.',
          () => { setCustomerNo(''); setCardNumber(''); setExpiry(''); setCvv(''); })} />
    </Surface> : null}

    {!canLink && (kyc || client.mail.address) ? <Surface className="stack">
      <h2 className="heading">Почта для кодов</h2>
      <Field label="Почта" hint={mailHint} value={mail} type="email" maxLength={254} disabled={busy} autoComplete="off" spellCheck={false}
        error={mail && !mailValid ? 'Проверьте почту' : null} onChange={event => setMail(event.target.value.trim().toLowerCase())} />
      <Button title="Сохранить почту" disabled={busy || !mailValid || mail === client.mail.address}
        onClick={() => void run(token => saveClientMail(client.userId, mail, token), 'Привязать эту почту клиенту', 'Почта сохранена.', () => {})} />
    </Surface> : null}

    {(client.cards ?? []).map(card => <CardTopupAddressesForm key={`${card.id}:${JSON.stringify(card.topupAddresses)}`} card={card} busy={busy}
      onSave={addresses => void run(token => saveCardTopupAddresses(client.userId, card.id, addresses, token),
        'Сохранить адреса пополнения карты', 'Адреса сохранены. Клиент видит их в «Пополнить».',
        // The administrator may be this client too: the card in this app shows the new addresses at once.
        () => { void queryClient.invalidateQueries({ queryKey: ['cards'] }); })} />)}

    {requests.length ? <Surface className="stack">
      <h2 className="heading">Заявки по карте</h2>
      <span className="caption muted">Выполните операцию в UPay вручную, затем отметьте её здесь. При отказе деньги вернутся клиенту на баланс.</span>
      {requests.map(item => <div className="admin-operation" key={item.id}>
        <div className="row between"><strong>{item.type === 'topup' ? `Пополнить карту на $${item.netUsd ?? '—'}` : item.type === 'freeze' ? 'Заморозить карту' : 'Разморозить карту'}</strong>
          {item.last4 ? <span className="admin-status">•• {item.last4}</span> : null}</div>
        <span className="caption muted">{date(item.createdAt)}{item.type === 'topup' && item.amount ? ` · клиент заплатил ${item.amount} ${item.asset} (комиссия ${item.fee} ${item.asset})` : ''}</span>
        <div className="admin-fields">
          <Button small title="Выполнено" disabled={busy} onClick={() => void run(token => resolveAdminRequest(client.userId, item.id, { done: true }, token),
            item.type === 'topup' ? 'Подтвердить, что карта пополнена в UPay' : 'Подтвердить, что операция выполнена в UPay', 'Заявка выполнена, клиент получил уведомление.', () => {})} />
          <Button small variant="danger" title="Отклонить" disabled={busy || (requestReasons[item.id] ?? '').trim().length < 3}
            onClick={() => void run(token => resolveAdminRequest(client.userId, item.id, { done: false, reason: (requestReasons[item.id] ?? '').trim() }, token),
              'Отклонить заявку клиента', 'Заявка отклонена.', () => setRequestReasons(previous => ({ ...previous, [item.id]: '' })))} />
        </div>
        <Field label="Причина отказа" value={requestReasons[item.id] ?? ''} maxLength={300} disabled={busy}
          onChange={event => setRequestReasons(previous => ({ ...previous, [item.id]: event.target.value }))} />
      </div>)}
    </Surface> : null}

    {canReject ? <Surface className="stack">
      <h2 className="heading">Отклонить заявку на карту</h2>
      <span className="caption muted">Клиент получит уведомление с причиной{operation ? ', оплата вернётся на его баланс' : ''}. Он сможет отправить анкету заново.</span>
      <Field label="Причина для клиента" value={reason} maxLength={300} disabled={busy} onChange={event => setReason(event.target.value)} />
      <Button title="Отклонить заявку" variant="danger" disabled={busy || reason.trim().length < 5}
        onClick={() => void run(token => updateAdminClient(client.userId, 'reject', { ...(reviewing ? { submissionId: kyc!.submissionId } : {}), reason: reason.trim() }, token),
          'Отклонить заявку клиента', operation ? 'Заявка отклонена, оплата возвращена клиенту.' : 'Анкета отклонена.', () => setReason(''))} />
    </Surface> : null}

    {client.operations.length ? <Surface className="stack">
      <h2 className="heading">История операций</h2>
      {client.operations.map(item => <div className="admin-operation" key={item.id}>
        <div className="row between"><strong>{item.type === 'issue' ? 'Выпуск карты' : item.type === 'topup' ? 'Пополнение' : 'Управление картой'}</strong><Status value={item.status} /></div>
        <span className="caption muted">{date(item.createdAt)} · {item.fulfillmentMode === 'manual' ? 'Вручную' : 'Автоматическая операция'}
          {item.last4 ? ` · •• ${item.last4}` : ''}</span>
        <span className="caption admin-id">Заявка: {item.id}</span>
        {item.status === 'unknown' ? <Notice tone="warning" text="Исход операции требует отдельной сверки. Не выпускайте карту повторно и не привязывайте новую карту к этой операции." /> : null}
      </div>)}
    </Surface> : null}
    {confirmation.element}
  </div>;
}

const networkNames: Record<string, string> = { TRC20: 'Tron (TRC20)', BEP20: 'BNB Chain (BEP20)', ERC20: 'Ethereum (ERC20)', POLYGON: 'Polygon' };
const short = (value: string) => value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

// Payments to the app wallet that matched no client's exact amount. The operator checks and credits them.
function WalletTransfers() {
  const queryClient = useQueryClient();
  const transfers = useAdminWalletTransfers(true);
  const confirmation = useConfirmation();
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const assign = async (id: string) => {
    const query = (targets[id] ?? '').trim();
    if (!adminQueryValid(query)) { setError('Введите полный GUDEX UUID или числовой Telegram ID клиента.'); return; }
    setBusy(id); setError(null); setSuccess(null);
    try {
      const token = await confirmation.confirm('Зачислить этот платёж на баланс клиента');
      if (!token) return;
      await assignWalletTransfer(id, query, token);
      setSuccess('Платёж зачислен на баланс клиента. Клиент получил уведомление.');
      void queryClient.invalidateQueries({ queryKey: [...adminKeys.all, 'wallet-transfers'] });
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'Не удалось зачислить платёж. Обновите список и повторите.');
    } finally { setBusy(null); }
  };
  return <Surface className="stack">
    <div className="row between"><h2 className="heading">Платежи на кошелёк приложения</h2>
      <button className="link" disabled={transfers.isFetching} onClick={() => void transfers.refetch()}>Обновить</button></div>
    <span className="caption muted">Здесь переводы, которые не совпали ни с одной суммой клиента: другая сумма, поздняя оплата или неизвестный отправитель. Проверьте перевод в обозревателе и зачислите его нужному клиенту.</span>
    {success ? <Notice text={success} /> : null}
    {error ? <Notice tone="danger" text={error} /> : null}
    {transfers.isPending ? <Spinner /> : transfers.isError ? <QueryError error={transfers.error} onRetry={() => void transfers.refetch()} /> :
      !transfers.data.length ? <p className="caption muted">Нераспознанных платежей нет.</p> :
      transfers.data.map(item => <div className="admin-operation" key={item.id}>
        <div className="row between"><strong>{item.amount} {item.asset}</strong><span className="admin-status attention">Не распознан</span></div>
        <span className="caption muted">{networkNames[item.network] ?? item.network} · {date(item.blockTime)} · от {short(item.from)}
          {!item.exact ? ' · сумма точнее 6 знаков' : ''}</span>
        <a className="caption link" href={item.explorerUrl} target="_blank" rel="noreferrer">Открыть перевод: {short(item.txHash)}</a>
        <div className="admin-search">
          <Field label="Клиент (GUDEX UUID или Telegram ID)" value={targets[item.id] ?? ''} maxLength={64} autoComplete="off" disabled={busy !== null}
            onChange={event => setTargets(previous => ({ ...previous, [item.id]: event.target.value }))} />
          <Button title="Зачислить" small loading={busy === item.id} disabled={busy !== null || !adminQueryValid((targets[item.id] ?? '').trim())}
            onClick={() => void assign(item.id)} />
        </div>
      </div>)}
    {confirmation.element}
  </Surface>;
}

export function Admin() {
  const navigate = useNavigate();
  const { query: selectedQuery } = useParams<{ query?: string }>();
  const queryClient = useQueryClient();
  const access = useAdminAccess();
  const allowed = access.data?.isAdmin === true && !access.isError;
  const [search, setSearch] = useState(selectedQuery ?? '');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const applications = useAdminApplications(page, allowed);
  const client = useAdminClient(selectedQuery && adminQueryValid(selectedQuery) ? selectedQuery : null, allowed);
  useEffect(() => { setSearch(selectedQuery ?? ''); setSearchError(null); }, [selectedQuery]);
  useEffect(() => () => {
    void queryClient.cancelQueries({ queryKey: adminKeys.all });
    queryClient.removeQueries({ queryKey: adminKeys.all });
  }, [queryClient]);
  const find = (event: FormEvent) => {
    event.preventDefault();
    const value = search.trim();
    if (!adminQueryValid(value)) { setSearchError('Введите полный GUDEX UUID или числовой Telegram ID.'); return; }
    setSearchError(null);
    navigate(`/admin/clients/${encodeURIComponent(value)}`);
  };
  return <div className="admin-shell"><Page title="Админка GUDEX">
    <div className="row between"><span className="admin-eyebrow">Ручная проверка заявок</span><button className="link" onClick={() => navigate('/profile')}>В профиль</button></div>
    {access.isPending ? <div className="admin-empty"><Spinner /><span>Проверяем доступ…</span></div> : !allowed ?
      <Notice tone="danger" text="Админка доступна только авторизованному администратору GUDEX." /> : <>
      <form className="admin-search" onSubmit={find}>
        <Field label="Найти клиента" placeholder="GUDEX UUID или Telegram ID" value={search} maxLength={64} autoComplete="off" spellCheck={false}
          onChange={event => setSearch(event.target.value)} error={searchError} />
        <button type="submit" className="btn primary">Найти</button>
      </form>
      <WalletTransfers />
      <div className="admin-grid">
        <Surface className="admin-queue stack">
          <div className="row between"><h2 className="heading">Очередь заявок</h2><button className="link" disabled={applications.isFetching} onClick={() => void applications.refetch()}>Обновить</button></div>
          {applications.isPending ? <Spinner /> : applications.isError ? <QueryError error={applications.error} onRetry={() => void applications.refetch()} /> : <>
            <span className="caption muted">Всего: {applications.data.total}</span>
            {!applications.data.items.length ? <div className="admin-empty">Новых заявок пока нет.</div> : null}
            <div className="admin-queue-list">{applications.data.items.map(item => <button key={item.userId}
              className={`admin-queue-item${client.data?.userId === item.userId ? ' selected' : ''}`}
              onClick={() => navigate(`/admin/clients/${item.userId}`)}>
              <span className="row between"><strong>{item.name || 'Без имени'}</strong><Icon name="chevronRight" size={18} /></span>
              <span className="caption muted">Telegram ID: {item.telegramId}</span>
              <span className="admin-queue-badges"><Status value={item.kycStatus} />{item.hasPendingCard ? <span className="admin-status">Ожидает карту</span> : null}
                {item.hasCardRequest ? <span className="admin-status attention">Заявка по карте</span> : null}</span>
              <span className="caption muted">{date(item.createdAt)}</span>
            </button>)}</div>
            <div className="admin-pagination"><Button small title="Назад" variant="secondary" disabled={page <= 1 || applications.isFetching} onClick={() => setPage(value => value - 1)} />
              <span className="caption muted">{page}</span><Button small title="Далее" variant="secondary" disabled={page * applications.data.limit >= applications.data.total || applications.isFetching}
                onClick={() => setPage(value => value + 1)} /></div>
          </>}
        </Surface>
        <div className="admin-review">{!selectedQuery ? <Surface className="admin-empty"><Icon name="shield" size={32} color="var(--primary)" />
          <h2 className="heading">Выберите заявку</h2><p className="muted">Откройте клиента из очереди или найдите его по идентификатору.</p></Surface> :
          !adminQueryValid(selectedQuery) ? <Notice tone="danger" text="Неверный идентификатор клиента." /> :
          client.isPending ? <Surface className="admin-empty"><Spinner /><span>Загружаем заявку…</span></Surface> :
          client.isError ? <QueryError error={client.error} onRetry={() => void client.refetch()} /> : client.data ?
          <ClientReview key={`${client.data.userId}:${client.data.kyc?.submissionId ?? ''}`} client={client.data} onUpdated={updated => {
            queryClient.setQueryData([...adminKeys.all, 'client', selectedQuery], updated);
            void queryClient.invalidateQueries({ queryKey: [...adminKeys.all, 'applications'] });
          }} /> : null}</div>
      </div>
    </>}
  </Page></div>;
}
