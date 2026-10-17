import { useTranslation } from 'react-i18next';
import { useConfig } from '../lib/queries';
import { Notice } from './ui';

// Показывается, пока backend работает с заглушками: чтобы никто не отправил на тестовый адрес реальные деньги.
export function TestModeBanner() {
  const { t } = useTranslation();
  const { data: config } = useConfig();
  if (!config?.devTools) return null;
  return <Notice tone="warning" icon="flask" text={`${t('common.testMode')}. ${t('common.testModeHint')}`} />;
}
