import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { useColors } from '../../theme';

export default function AuthLayout() {
  const { status } = useAuth();
  const c = useColors();
  if (status === 'signedIn') return <Redirect href="/home" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background } }} />;
}
