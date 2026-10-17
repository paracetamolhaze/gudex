import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, Switch, View } from 'react-native';
import { Icon } from '../../../components/Icon';
import { LanguageSwitch } from '../../../components/LanguageSwitch';
import { AppText, Button, Screen, Surface } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { BIOMETRY_ICON, useSecurity } from '../../../lib/security';
import { useMe, useUpdateLocale } from '../../../lib/queries';
import { space, useColors } from '../../../theme';

export default function Profile() {
  const { t } = useTranslation();
  const c = useColors();
  const { signOut } = useAuth();
  const security = useSecurity();
  const { data: me } = useMe();
  const updateLocale = useUpdateLocale();
  const kycStatus = me?.kyc.status ?? 'none';
  const fullName = me?.kyc.firstName ? `${me.kyc.firstName} ${me.kyc.lastName}` : null;

  return (
    <Screen>
      <AppText variant="title">{t('profile.title')}</AppText>

      <Surface style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="user" color={c.primary} />
        </View>
        <View style={{ flex: 1 }}>
          {fullName ? <AppText variant="bodyMedium">{fullName}</AppText> : null}
          <AppText muted={Boolean(fullName)}>{me?.email ?? '—'}</AppText>
        </View>
      </Surface>

      <Pressable onPress={() => router.push('/kyc')}>
        <Surface style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Icon name="shield" color={kycStatus === 'approved' ? c.success : c.primary} />
          <AppText variant="bodyMedium" style={{ flex: 1 }}>
            {t('profile.verification')}
          </AppText>
          <AppText muted>{t(`profile.kyc.${kycStatus}`)}</AppText>
          <Icon name="chevronRight" color={c.textSecondary} size={18} />
        </Surface>
      </Pressable>

      <AppText variant="heading">{t('security.section')}</AppText>
      <Surface padded={false}>
        <Pressable
          onPress={() => router.push({ pathname: '/pin-setup', params: { mode: 'change' } })}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg }}
        >
          <Icon name="lock" color={c.primary} />
          <AppText variant="bodyMedium" style={{ flex: 1 }}>
            {t('security.pinRow')}
          </AppText>
          <AppText muted>{t('security.change')}</AppText>
          <Icon name="chevronRight" color={c.textSecondary} size={18} />
        </Pressable>
        {security.biometry ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderTopWidth: 1, borderTopColor: c.border }}>
            <Icon name={BIOMETRY_ICON[security.biometry]} color={c.primary} />
            <AppText variant="bodyMedium" style={{ flex: 1 }}>
              {t(`security.method.${security.biometry}`)}
            </AppText>
            <Switch
              value={security.biometricsEnabled}
              onValueChange={(on) => {
                security.setBiometricsEnabled(on);
              }}
              trackColor={{ true: c.primary, false: c.border }}
            />
          </View>
        ) : null}
        {security.faceIdBlockedInExpoGo ? (
          <View style={{ padding: space.lg, borderTopWidth: 1, borderTopColor: c.border }}>
            <AppText variant="caption" muted>
              {t('security.expoGoFaceId')}
            </AppText>
          </View>
        ) : null}
      </Surface>

      <Surface style={{ gap: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Icon name="globe" color={c.primary} />
          <AppText variant="bodyMedium">{t('profile.language')}</AppText>
        </View>
        <LanguageSwitch onChange={(locale) => updateLocale.mutate(locale)} />
      </Surface>

      <Button title={t('profile.signOut')} variant="danger" icon="logout" onPress={signOut} />
      <AppText variant="caption" muted style={{ textAlign: 'center' }}>
        {t('profile.version', { version: Constants.expoConfig?.version ?? '0.1.0' })}
      </AppText>
    </Screen>
  );
}
