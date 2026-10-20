import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import type { SupportMessageDto } from '@gudex/shared';
import { Icon } from '../components/Icon';
import { Mascot } from '../components/Mascot';
import { Button, Loading, Notice, Page, QueryError, Spinner } from '../components/ui';
import { adminKeys, sendAdminSupport, setAdminSupportStatus, useAdminAccess, useAdminSupportThread } from '../lib/admin';
import { ApiError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useSendSupport, useSupport } from '../lib/queries';
import { haptic } from '../lib/telegram';

const MAX_TEXT = 2000;

function time(value: string, language: string): string {
  const date = new Date(value);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(language === 'en' ? 'en-GB' : 'ru-RU', today ? { hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Messages and the reply box. `mine` is the side drawn on the right. */
export function ChatView({ messages, mine, theirsLabel, empty, sending, error, onSend }: {
  messages: SupportMessageDto[];
  mine: SupportMessageDto['author'];
  theirsLabel: string;
  empty?: string;
  sending: boolean;
  error?: string | null;
  onSend: (text: string) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const lastId = messages.at(-1)?.id;
  // A new message (and opening the chat) scrolls the page to the very bottom, below the sticky reply box.
  // After a tick: the screen change resets the scroll to the top in a parent effect that runs after this one.
  useEffect(() => {
    const timer = setTimeout(() => window.scrollTo(0, document.documentElement.scrollHeight), 0);
    return () => clearTimeout(timer);
  }, [lastId]);
  // The box grows with wrapped text too, up to about five lines.
  const resize = () => {
    const box = input.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
  };
  useEffect(resize, [text]);
  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    if (await onSend(value)) setText('');
  };
  return (
    <div className="chat">
      {messages.length ? <div className="chat-list">
        {messages.map(message => (
          <div key={message.id} className={`chat-msg ${message.author === mine ? 'mine' : 'theirs'}`}>
            {message.author !== mine ? <span className="chat-author">{theirsLabel}</span> : null}
            <span className="chat-text">{message.text}</span>
            <span className="chat-time">{time(message.createdAt, i18n.language)}</span>
          </div>
        ))}
      </div> : empty ? <p className="muted chat-empty">{empty}</p> : null}
      <div className="chat-composer">
        {error ? <Notice tone="danger" text={error} /> : null}
        <div className="chat-composer-row">
          {/* readOnly, not disabled, while sending: disabling a focused field closes the phone keyboard. */}
          <textarea ref={input} className="input chat-input" value={text} maxLength={MAX_TEXT} rows={1}
            placeholder={t('support.placeholder')} readOnly={sending} onChange={event => setText(event.target.value)} />
          <button type="button" className="btn primary chat-send" aria-label={t('support.send')} disabled={sending || !text.trim()} onClick={() => void send()}>
            {sending ? <Spinner /> : <Icon name="send" color="#fff" size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Профиль › Поддержка: the client's conversation with GUDEX. */
export function Support() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const thread = useSupport();
  const send = useSendSupport();
  if (thread.error && !thread.data) return <Page title={t('support.title')}><QueryError error={thread.error} onRetry={() => void thread.refetch()} /></Page>;
  if (!thread.data) return <Loading />;
  return (
    <Page title={t('support.title')}>
      {!thread.data.messages.length ? <div className="row">
        <Mascot pose="hello" size={90} motion="none" />
        <span className="muted grow">{t('support.intro')}</span>
      </div> : null}
      <ChatView messages={thread.data.messages} mine="client" theirsLabel={t('support.team')} sending={send.isPending}
        error={send.error ? fmt.error(send.error) : null}
        onSend={async text => {
          try { await send.mutateAsync(text); haptic.success(); return true; } catch { haptic.error(); return false; }
        }} />
      <span className="caption muted" style={{ textAlign: 'center' }}>{t('support.hint')}</span>
    </Page>
  );
}

/** Admin › Обращения › a client: the same conversation from the operator's side. */
export function AdminSupportThread() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { userId = '' } = useParams<{ userId: string }>();
  const access = useAdminAccess();
  const thread = useAdminSupportThread(userId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      // A refresh already in flight would bring back the conversation without this message.
      await queryClient.cancelQueries({ queryKey: [...adminKeys.all, 'support-thread', userId] });
      queryClient.setQueryData([...adminKeys.all, 'support-thread', userId], result);
      void queryClient.invalidateQueries({ queryKey: [...adminKeys.all, 'support'] });
      return true;
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'Не удалось отправить. Повторите.');
      return false;
    } finally { setBusy(false); }
  };
  if (access.isError) return <Page title="Обращение"><Notice tone="danger" text="Доступно только администратору GUDEX." /></Page>;
  if (thread.error && !thread.data) return <Page title="Обращение"><QueryError error={thread.error} onRetry={() => void thread.refetch()} /></Page>;
  if (!thread.data) return <Loading />;
  const closed = thread.data.status === 'closed';
  return (
    <Page title="Обращение">
      <div className="row between">
        <button className="link" onClick={() => navigate(`/admin/clients/${userId}`)}>Карточка клиента</button>
        <Button small variant="secondary" title={closed ? 'Открыть снова' : 'Закрыть обращение'} disabled={busy}
          onClick={() => void run(() => setAdminSupportStatus(userId, closed ? 'open' : 'closed'))} />
      </div>
      {closed ? <Notice text="Обращение закрыто. Если клиент напишет снова, оно откроется само." /> : null}
      <ChatView messages={thread.data.messages} mine="support" theirsLabel="Клиент" sending={busy} error={error}
        onSend={text => run(() => sendAdminSupport(userId, text))} />
    </Page>
  );
}
