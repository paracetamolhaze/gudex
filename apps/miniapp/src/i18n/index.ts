import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Locale } from '@gudex/shared';
import { tgUser } from '../lib/telegram';
import { en } from './en';
import { ru } from './ru';

// Язык по умолчанию — из Telegram; для языков СНГ русский. Сохранённый выбор приходит с сервера (me.locale).
const RU_DEFAULT = ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'az', 'hy'];
const fromTelegram = tgUser?.language_code ?? navigator.language.slice(0, 2);

i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru }, en: { translation: en } },
  lng: RU_DEFAULT.includes(fromTelegram) ? 'ru' : 'en',
  fallbackLng: 'ru',
  interpolation: { escapeValue: false },
});

export function setLocale(locale: Locale): void {
  if (i18n.language !== locale) i18n.changeLanguage(locale);
}

// Screen readers pronounce the page in the language it is shown in.
document.documentElement.lang = i18n.language;
i18n.on('languageChanged', language => { document.documentElement.lang = language; });

export default i18n;
