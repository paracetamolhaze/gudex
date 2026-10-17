import { useTranslation } from 'react-i18next';
import type { Asset } from '@gudex/shared';
import i18n from '../i18n';
import { errorTranslation } from './error-format';

// Форматирование только для отображения. Расчёты денег делает сервер.
// Язык передаётся явно: React Compiler кэширует вызовы и не видит глобальный i18n.language.

function numberLocale(language: string): string {
  return language === 'en' ? 'en-US' : 'ru-RU';
}

export function formatAmount(amount: string, asset: Asset, language: string, options: { sign?: boolean } = {}): string {
  const value = Number(amount);
  const abs = Math.abs(value).toLocaleString(numberLocale(language), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = options.sign ? (value > 0 ? '+' : value < 0 ? '−' : '') : value < 0 ? '−' : '';
  return asset === 'USD' ? `${sign}$${abs}` : `${sign}${abs} ${asset}`;
}

export function formatTime(iso: string, language: string): string {
  return new Date(iso).toLocaleTimeString(numberLocale(language), { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(iso: string, language: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return i18n.t('history.today', { lng: language });
  if (date.toDateString() === yesterday.toDateString()) return i18n.t('history.yesterday', { lng: language });
  return date.toLocaleDateString(numberLocale(language), { day: 'numeric', month: 'long', year: 'numeric' });
}

// Длинный адрес кошелька: начало и конец, середина — многоточием.
export function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

// Форматтеры, привязанные к текущему языку: компонент перерисуется при его смене.
export function useFormat() {
  const { i18n: instance } = useTranslation();
  const language = instance.language;
  return {
    amount: (amount: string, asset: Asset, options?: { sign?: boolean }) => formatAmount(amount, asset, language, options),
    time: (iso: string) => formatTime(iso, language),
    day: (iso: string) => formatDay(iso, language),
    percent: (value: number) => value.toLocaleString(numberLocale(language)),
    error: (error: unknown) => errorMessage(error, language),
  };
}

export function errorMessage(error: unknown, language: string): string {
  const { key, options } = errorTranslation(error, language);
  return i18n.t(i18n.exists(key) ? key : 'errors.internal', options);
}
