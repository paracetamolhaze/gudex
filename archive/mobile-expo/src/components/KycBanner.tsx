import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';
import { useMe } from '../lib/queries';
import { useColors } from '../theme';
import { Icon } from './Icon';
import { Notice } from './ui';

export function KycBanner() {
  const { t } = useTranslation();
  const c = useColors();
  const { data: me } = useMe();
  const status = me?.kyc.status;
  if (!status || status === 'approved') return null;

  const text = { none: t('home.kycNeeded'), pending: t('home.kycPending'), rejected: t('home.kycRejected') }[status];
  return (
    <Pressable onPress={() => router.push('/kyc')}>
      <Notice
        tone={status === 'rejected' ? 'danger' : 'info'}
        icon="shield"
        text={text}
        action={status === 'pending' ? undefined : <Icon name="chevronRight" color={c.textSecondary} size={18} />}
      />
    </Pressable>
  );
}
