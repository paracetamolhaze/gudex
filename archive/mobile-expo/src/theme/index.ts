import { useColorScheme } from 'react-native';

// Цвета взяты с gudexchange.com: основной синий #2E66E9 и голубой #3DAEEC.
const brand = {
  primary: '#2E66E9',
  accent: '#3DAEEC',
  gradient: ['#2E66E9', '#3DAEEC'] as const,
};

const light = {
  ...brand,
  background: '#F3F6FC',
  surface: '#FFFFFF',
  surfaceAlt: '#EAF0FD',
  text: '#0E1424',
  textSecondary: '#6B7489',
  border: '#E3E8F2',
  success: '#17A673',
  danger: '#E5484D',
  warning: '#D98A00',
  warningBg: '#FFF4D6',
  onPrimary: '#FFFFFF',
};

const dark: typeof light = {
  ...brand,
  primary: '#4A7DF0',
  background: '#0A0F1C',
  surface: '#131A2B',
  surfaceAlt: '#1B2438',
  text: '#F2F5FB',
  textSecondary: '#8E98AE',
  border: '#222C42',
  success: '#2CC28A',
  danger: '#FF6369',
  warning: '#F5B13D',
  warningBg: '#3A2E12',
  onPrimary: '#FFFFFF',
};

export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light;
}

export const fonts = {
  regular: 'InterTight_400Regular',
  medium: 'InterTight_500Medium',
  semibold: 'InterTight_600SemiBold',
  bold: 'InterTight_700Bold',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 20, xl: 28 } as const;
