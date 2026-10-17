import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Locale } from '@gudex/shared';
import { storage } from '../lib/storage';
import { en } from './en';
import { ru } from './ru';

const LOCALE_KEY = 'gudex.locale';

// Для языков СНГ по умолчанию русский, для остальных — английский.
const RU_DEFAULT = ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'az', 'hy'];

function deviceLocale(): Locale {
  const code = getLocales()[0]?.languageCode ?? 'en';
  return RU_DEFAULT.includes(code) ? 'ru' : 'en';
}

i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru }, en: { translation: en } },
  lng: deviceLocale(),
  fallbackLng: 'ru',
  interpolation: { escapeValue: false },
});

export async function restoreLocale(): Promise<void> {
  const saved = await storage.get(LOCALE_KEY);
  if (saved === 'ru' || saved === 'en') await i18n.changeLanguage(saved);
}

export async function setLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
  await storage.set(LOCALE_KEY, locale);
}

export function currentLocale(): Locale {
  return i18n.language === 'en' ? 'en' : 'ru';
}

export default i18n;
