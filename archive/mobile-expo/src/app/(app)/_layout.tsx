import { Redirect, Stack, useSegments } from 'expo-router';
import { Loading } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useSecurity } from '../../lib/security';
import { fonts, useColors } from '../../theme';

// Всё внутри (app) — только для вошедших пользователей с созданным код-паролем.
export default function AppLayout() {
  const { status } = useAuth();
  const security = useSecurity();
  const segments = useSegments();
  const c = useColors();
  if (status === 'loading' || !security.ready) return <Loading />;
  if (status === 'signedOut') return <Redirect href="/welcome" />;
  if (!security.hasPin && !segments.includes('pin-setup' as never)) return <Redirect href="/pin-setup" />;

  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.text,
        headerTitleStyle: { fontFamily: fonts.semibold },
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: c.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="pin-setup" options={{ headerShown: false, gestureEnabled: false }} />
    </Stack>
  );
}
