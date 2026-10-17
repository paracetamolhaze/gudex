import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, space, useColors } from '../theme';
import { Icon, type IconName } from './Icon';
import { AppText, Button } from './ui';

// Нижняя панель «вы уверены?» с объяснением последствий действия.
export function ConfirmSheet({
  visible,
  icon,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive,
  loading,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  icon?: IconName;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(5,8,16,0.55)' }} onPress={onCancel} />
      <View
        style={{
          backgroundColor: c.surface,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          padding: space.xl,
          paddingBottom: space.xl + insets.bottom,
          gap: space.lg,
        }}
      >
        {icon ? (
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={icon} color={destructive ? c.danger : c.primary} size={28} />
          </View>
        ) : null}
        <AppText variant="title">{title}</AppText>
        <AppText muted>{message}</AppText>
        <View style={{ gap: space.md }}>
          <Button title={confirmLabel} variant={destructive ? 'danger' : 'primary'} onPress={onConfirm} loading={loading} />
          <Button title={cancelLabel} variant="ghost" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}
