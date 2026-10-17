import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { useFormat } from '../lib/format';
import { space, useColors } from '../theme';
import { Icon } from './Icon';
import { AppText, Button, Field, Notice, Screen } from './ui';

export function AuthForm({ mode }: { mode: 'signIn' | 'signUp' }) {
  const fmt = useFormat();
  const { t } = useTranslation();
  const c = useColors();
  const { signIn, signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signingUp = mode === 'signUp';
  const valid = /\S+@\S+\.\S+/.test(email) && password.length >= (signingUp ? 8 : 1);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await (signingUp ? signUp : signIn)(email.trim(), password);
      router.replace('/home');
    } catch (err) {
      setError(fmt.error(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))} hitSlop={12}>
        <Icon name="arrowLeft" color={c.text} size={26} />
      </Pressable>
      <AppText variant="title">{signingUp ? t('auth.signUpTitle') : t('auth.signInTitle')}</AppText>

      <View style={{ gap: space.lg }}>
        <Field
          label={t('auth.email')}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
        />
        <Field
          label={t('auth.password')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          hint={signingUp ? t('auth.passwordHint') : undefined}
          onSubmitEditing={valid ? submit : undefined}
        />
      </View>

      {error ? <Notice tone="danger" text={error} /> : null}

      <Button title={signingUp ? t('auth.signUp') : t('auth.signIn')} onPress={submit} loading={busy} disabled={!valid} />
      <Button
        variant="ghost"
        title={signingUp ? t('auth.haveAccount') : t('auth.noAccount')}
        onPress={() => router.replace(signingUp ? '/login' : '/register')}
      />
    </Screen>
  );
}
