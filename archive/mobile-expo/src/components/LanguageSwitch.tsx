import { useTranslation } from 'react-i18next';
import type { Locale } from '@gudex/shared';
import { setLocale } from '../i18n';
import { Segmented } from './ui';

export function LanguageSwitch({ onChange }: { onChange?: (locale: Locale) => void }) {
  const { i18n } = useTranslation();
  const value: Locale = i18n.language === 'en' ? 'en' : 'ru';
  return (
    <Segmented<Locale>
      options={[
        { value: 'ru', label: 'Русский' },
        { value: 'en', label: 'English' },
      ]}
      value={value}
      onChange={(locale) => {
        setLocale(locale);
        onChange?.(locale);
      }}
    />
  );
}
