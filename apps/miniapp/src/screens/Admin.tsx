import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { useConfirmation } from '../components/security';
import { Button, Field, Notice, Page, QueryError, Spinner, Surface } from '../components/ui';
import { ApiError } from '../lib/api';
import { adminKeys, adminQueryValid, canLinkManualCard, documentObjectUrl, getAdminDocument, updateAdminClient,
  useAdminAccess, useAdminApplications, useAdminClient, useAdminProviderCards, type AdminClient, type AdminDocument } from '../lib/admin';
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

function ClientReview({ client, onUpdated }: { client: AdminClient; onUpdated: (value: AdminClient) => void }) {
  const [customerId, setCustomerId] = useState('');
  const [customerNo, setCustomerNo] = useState(client.kyc?.partnerCustomerId ?? '');
  const [documentsMatch, setDocumentsMatch] = useState(false);
  const [viewed, setViewed] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [operationId, setOperationId] = useState('');
  const [partnerCardId, setPartnerCardId] = useState('');
  const [cardsRequested, setCardsRequested] = useState(false);
  const [orderNo, setOrderNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const confirmation = useConfirmation();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const kyc = client.kyc;
  const providerCards = useAdminProviderCards(client.userId, cardsRequested && kyc?.status === 'approved' && Boolean(kyc.partnerCustomerId));
  const manualOperations = client.operations.filter(canLinkManualCard);
  const canReview = kyc?.status === 'pending' && kyc.submissionState === 'manual_review' && Boolean(kyc.submissionId);
  const allViewed = Boolean(kyc?.documents.length) && kyc!.documents.every(item => viewed.includes(item.id));
  const selectedOperation = manualOperations.find(operation => operation.id === operationId);
  const selectedProviderCard = providerCards.data?.find(card => card.id === partnerCardId);
  const write = async (action: 'kyc' | 'reject' | 'card', body: object, prompt: string, completed: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const token = await confirmation.confirm(prompt);
      if (!token || !mounted.current) return;
      const updated = await updateAdminClient(client.userId, action, body, token);
      if (!mounted.current) return;
      setCustomerId(''); setDocumentsMatch(false); setViewed([]); setReason(''); setOperationId(''); setPartnerCardId(''); setCardsRequested(false); setOrderNo('');
      onUpdated(updated);
      setSuccess(completed);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'Не удалось подтвердить результат. Обновите заявку перед повторным действием.');
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <div className="admin-client stack">
    <Surface className="stack">
      <div className="row between"><div><span className="admin-eyebrow">Клиент</span><h2 className="heading">
        {[kyc?.firstName, kyc?.lastName].filter(Boolean).join(' ') || (client.username ? `@${client.username}` : 'Без анкеты')}</h2></div>
        {kyc ? <Status value={kyc.status} /> : null}</div>
      <dl className="admin-details"><Detail label="GUDEX ID" value={client.userId} /><Detail label="Telegram ID" value={client.telegramId} />
        <Detail label="Имя в Telegram" value={client.username ? `@${client.username}` : null} /><Detail label="Регистрация" value={date(client.createdAt)} /></dl>
    </Surface>
    {success ? <Notice text={success} /> : null}
    {error ? <Notice text={error} tone="danger" /> : null}
    {client.billingAddress ? <Surface className="stack"><h2 className="heading">Расчётный адрес</h2>
      <dl className="admin-details"><Detail label="Код страны UPay" value={client.billingAddress.countryId} />
        <Detail label="Почтовый индекс" value={client.billingAddress.postalCode} /><Detail label="Адрес" value={client.billingAddress.address} /></dl>
    </Surface> : null}
    {kyc ? <Surface className="stack">
      <div className="row between"><h2 className="heading">Анкета и документы</h2><Status value={kyc.submissionState} /></div>
      <dl className="admin-details"><Detail label="Имя" value={kyc.firstName} /><Detail label="Фамилия" value={kyc.lastName} />
        <Detail label="Дата рождения" value={kyc.birthDate} /><Detail label="Гражданство" value={kyc.citizenship} />
        <Detail label="Email" value={kyc.email} /><Detail label="Телефон" value={[kyc.globalCode, kyc.phone].filter(Boolean).join(' ')} />
        <Detail label="Документ" value={kyc.documentType === 'id_card' ? 'ID-карта' : kyc.documentType === 'passport' ? 'Паспорт' : kyc.documentType} />
        <Detail label="Страна документа" value={kyc.documentCountry} /><Detail label="Номер клиента UPay" value={kyc.partnerCustomerId} />
        <Detail label="Обновлено" value={date(kyc.updatedAt)} /></dl>
      <Documents key={`${client.userId}:${kyc.submissionId}:${kyc.updatedAt}`} userId={client.userId} documents={kyc.documents}
        onViewed={id => setViewed(previous => previous.includes(id) ? previous : [...previous, id])} />
      {canReview ? <>
        <div className="admin-divider" />
        <h3 className="heading">Подтверждение KYC</h3>
        <p className="caption muted">После проверки в UPay укажите оба идентификатора клиента. Сервер сверит анкету и результат проверки.</p>
        <div className="admin-fields"><Field label="Customer ID в UPay" hint="Число в конце адреса страницы клиента UPay." value={customerId} onChange={event => setCustomerId(event.target.value.trim())} disabled={busy} autoComplete="off" maxLength={128} />
          <Field label="Customer No в UPay" hint="Customer ID из таблицы UPay. Это другое значение, чем число в адресе страницы." value={customerNo} onChange={event => setCustomerNo(event.target.value.trim())} disabled={busy} autoComplete="off" maxLength={128} /></div>
        <label className="admin-check"><input type="checkbox" checked={documentsMatch} disabled={busy || !allViewed}
          onChange={event => setDocumentsMatch(event.target.checked)} /><span>Данные и просмотренные документы соответствуют клиенту в UPay</span></label>
        {!allViewed ? <span className="caption muted">Откройте документы перед подтверждением.</span> : null}
        <Button title="Подтвердить проверку" disabled={busy || !documentsMatch || !allViewed || !identifierValid(customerId) || !identifierValid(customerNo)}
          onClick={() => void write('kyc', { submissionId: kyc.submissionId, customerId, customerNo, documentsMatch: true },
            'Подтвердить соответствие клиента и документов в UPay', 'Проверка подтверждена.')} />
        <div className="admin-divider" />
        <Field label="Причина отказа для клиента" value={reason} maxLength={300} disabled={busy} onChange={event => setReason(event.target.value)} />
        <Button title="Отклонить анкету" variant="danger" disabled={busy || reason.trim().length < 5}
          onClick={() => void write('reject', { submissionId: kyc.submissionId, reason: reason.trim() }, 'Отклонить текущую анкету клиента', 'Анкета отклонена.')} />
      </> : null}
    </Surface> : <Notice text="Клиент ещё не отправил анкету." />}

    <Surface className="stack">
      <h2 className="heading">Заявки на карту</h2>
      {!client.operations.length ? <p className="muted">Заявок пока нет.</p> : null}
      {client.operations.map(operation => <div className="admin-operation" key={operation.id}>
        <div className="row between"><strong>{operation.type === 'issue' ? 'Выпуск карты' : operation.type === 'topup' ? 'Пополнение' : 'Управление картой'}</strong><Status value={operation.status} /></div>
        <span className="caption muted">{date(operation.createdAt)} · {operation.fulfillmentMode === 'manual' ? 'Ручной выпуск' : 'Автоматическая операция'}
          {operation.last4 ? ` · •• ${operation.last4}` : ''}</span>
        <span className="caption admin-id">Заявка: {operation.id}</span>
        {operation.status === 'unknown' ? <Notice tone="warning" text="Исход операции требует отдельной сверки. Не выпускайте карту повторно и не привязывайте новую карту к этой операции." /> : null}
      </div>)}
      {manualOperations.length && kyc?.status === 'approved' && kyc.partnerCustomerId ? <>
        <div className="admin-divider" /><h3 className="heading">Привязать выпущенную карту</h3>
        <p className="caption muted">Сначала выпустите карту нужному клиенту в админке UPay. Здесь сервер проверит карту и точную квитанцию. Повторный выпуск не отправляется.</p>
        <Detail label="Номер клиента UPay" value={kyc.partnerCustomerId} />
        <label className="field"><span className="label muted">Заявка на ручной выпуск</span><select className="input" aria-label="Заявка на ручной выпуск" value={operationId} disabled={busy}
          onChange={event => setOperationId(event.target.value)}><option value="">Выберите заявку</option>
          {manualOperations.map(operation => <option key={operation.id} value={operation.id}>{date(operation.createdAt)} · {operation.id}</option>)}</select></label>
        <Button title={cardsRequested ? 'Обновить карты клиента в UPay' : 'Загрузить карты клиента из UPay'} variant="secondary"
          disabled={busy} loading={providerCards.isFetching} onClick={() => {
            setPartnerCardId('');
            if (cardsRequested) void providerCards.refetch(); else setCardsRequested(true);
          }} />
        {cardsRequested && providerCards.isError ? <Notice tone="danger" text="Не удалось загрузить карты этого клиента. Обновите список перед привязкой." /> : null}
        {cardsRequested && providerCards.isSuccess ? providerCards.data.length ? <>
          <label className="field"><span className="label muted">Карта клиента в UPay</span>
            <select className="input" aria-label="Карта клиента в UPay" value={partnerCardId} disabled={busy || providerCards.isFetching}
              onChange={event => setPartnerCardId(event.target.value)}><option value="">Выберите выпущенную карту</option>
              {providerCards.data.map(card => <option key={card.id} value={card.id} disabled={card.state !== 1}>
                {`№ ${card.brokerCardId ?? 'без номера'}${card.last4 ? ` · •• ${card.last4}` : ''}${card.state !== 1 ? ' · недоступна для привязки' : ''}`}
              </option>)}
            </select>
          </label>
          {selectedProviderCard?.holderName ? <Detail label="Держатель карты" value={selectedProviderCard.holderName} /> : null}
        </> : <Notice text="В UPay пока нет карт этого клиента. После ручного выпуска обновите список." /> : null}
        <Field label="Order No выпуска" value={orderNo} maxLength={128} disabled={busy} autoComplete="off" onChange={event => setOrderNo(event.target.value.trim())} />
        <Button title="Проверить и привязать карту" disabled={busy || !selectedOperation || providerCards.isFetching || providerCards.isError || selectedProviderCard?.state !== 1 || !identifierValid(partnerCardId) || !identifierValid(orderNo)}
          onClick={() => void write('card', { operationId, partnerCardId, orderNo }, 'Проверить квитанцию и привязать карту выбранному клиенту', 'Карта проверена и привязана клиенту.')} />
      </> : null}
    </Surface>
    {confirmation.element}
  </div>;
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
              <span className="admin-queue-badges"><Status value={item.kycStatus} />{item.hasPendingCard ? <span className="admin-status">Ожидает карту</span> : null}</span>
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
