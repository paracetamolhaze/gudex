import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { Mascot } from '../components/Mascot';
import { Button, Notice, Page } from '../components/ui';
import { LEGAL_DOCUMENTS } from '../legal/documents';
import { useFormat } from '../lib/format';
import { useAcceptTerms } from '../lib/queries';
import { haptic } from '../lib/telegram';

export type LegalKind = 'terms' | 'privacy';

function documentText(kind: LegalKind, language: string): string {
  return LEGAL_DOCUMENTS[`${kind}_${language === 'en' ? 'en' : 'ru'}`];
}

// **bold** inside a line.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
}

/** The small markdown subset the documents use: # and ## headings, - lists (nested by two spaces), --- and paragraphs. */
export function LegalText({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let list: { nested: boolean; text: string }[] = [];
  const flush = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    blocks.push(<ul key={blocks.length}>{items.map((item, index) => <li key={index} className={item.nested ? 'nested' : undefined}>{inline(item.text)}</li>)}</ul>);
  };
  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();
    const item = /^(\s*)- (.*)$/.exec(line);
    if (item) { list.push({ nested: item[1]!.length >= 2, text: item[2]! }); continue; }
    flush();
    if (!line) continue;
    if (line === '---') blocks.push(<hr key={blocks.length} />);
    else if (line.startsWith('# ')) blocks.push(<h2 key={blocks.length}>{line.slice(2)}</h2>);
    else if (line.startsWith('## ')) blocks.push(<h3 key={blocks.length}>{line.slice(3)}</h3>);
    else blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="legal">{blocks}</div>;
}

/** Profile › Документы › Условия использования / Политика конфиденциальности. */
export function LegalScreen() {
  const { t, i18n } = useTranslation();
  const { kind = 'terms' } = useParams<{ kind: LegalKind }>();
  const safeKind: LegalKind = kind === 'privacy' ? 'privacy' : 'terms';
  return <Page title={t(`legal.${safeKind}`)}><LegalText source={documentText(safeKind, i18n.language)} /></Page>;
}

/** A document over the current screen: used before the client is inside the app. */
export function LegalSheet({ kind, onClose }: { kind: LegalKind; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="fullscreen legal-sheet" role="dialog" aria-modal="true" aria-label={t(`legal.${kind}`)}>
      <div className="row between">
        <h1 className="heading">{t(`legal.${kind}`)}</h1>
        <button className="btn secondary small" onClick={onClose} autoFocus>{t('legal.close')}</button>
      </div>
      <div className="legal-sheet-body"><LegalText source={documentText(kind, i18n.language)} /></div>
    </div>
  );
}

/** «Я принимаю Условия использования и Политику конфиденциальности…» with links that open the documents. */
export function TermsConsent({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<LegalKind | null>(null);
  const link = (kind: LegalKind, label: string) => (
    <button type="button" className="link consent-link" onClick={event => { event.preventDefault(); setOpen(kind); }}>{label}</button>
  );
  return (
    <>
      <label className="consent-check">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={event => { haptic.select(); onChange(event.target.checked); }} />
        <span>{t('legal.accept')} {link('terms', t('legal.termsLink'))} {t('legal.and')} {link('privacy', t('legal.privacyLink'))} {t('legal.consent')}</span>
      </label>
      {open ? <LegalSheet kind={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** Clients who joined before the documents existed (or before a new version) accept them once after signing in. */
export function TermsGate() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const accept = useAcceptTerms();
  const [checked, setChecked] = useState(false);
  return (
    <div className="page center-screen terms-gate">
      <Mascot pose="hello" size={160} motion="pop" />
      <h1 className="title">{t('legal.updateTitle')}</h1>
      <p className="muted">{t('legal.updateText')}</p>
      <div className="stack" style={{ width: '100%', maxWidth: 420, textAlign: 'left' }}>
        <TermsConsent checked={checked} disabled={accept.isPending} onChange={setChecked} />
        {accept.error ? <Notice tone="danger" text={fmt.error(accept.error)} /> : null}
        <Button title={t('common.continue')} disabled={!checked} loading={accept.isPending} onClick={() => accept.mutate()} />
      </div>
    </div>
  );
}
