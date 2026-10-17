import { useState } from 'react';
import { Pressable, Vibration, View } from 'react-native';
import { PIN_LENGTH } from '../lib/security-store';
import { fonts, space, useColors } from '../theme';
import { Icon, type IconName } from './Icon';
import { AppText } from './ui';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'] as const;

// Цифровая клавиатура для код-пароля. onComplete вызывается, когда набраны все цифры;
// если он вернёт false — ввод сбрасывается с вибрацией.
export function PinPad({
  title,
  subtitle,
  error,
  onComplete,
  biometryIcon,
  onBiometrics,
}: {
  title: string;
  subtitle?: string;
  error?: string | null;
  onComplete: (pin: string) => Promise<boolean | void> | boolean | void;
  biometryIcon?: IconName;
  onBiometrics?: () => void;
}) {
  const c = useColors();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const press = async (key: (typeof KEYS)[number]) => {
    if (busy) return;
    if (key === 'bio') return onBiometrics?.();
    if (key === 'del') return setValue((v) => v.slice(0, -1));
    const next = value + key;
    setValue(next);
    if (next.length < PIN_LENGTH) return;
    setBusy(true);
    const result = await onComplete(next);
    if (result === false) Vibration.vibrate(120);
    setValue('');
    setBusy(false);
  };

  return (
    <View style={{ alignItems: 'center', gap: space.xl }}>
      <View style={{ alignItems: 'center', gap: space.sm }}>
        <AppText variant="title" style={{ textAlign: 'center' }}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText muted style={{ textAlign: 'center' }}>
            {subtitle}
          </AppText>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: space.lg }}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <View
            key={i}
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              borderWidth: 2,
              borderColor: error ? c.danger : c.primary,
              backgroundColor: i < value.length ? (error ? c.danger : c.primary) : 'transparent',
            }}
          />
        ))}
      </View>

      <AppText variant="caption" color={c.danger} style={{ minHeight: 18, textAlign: 'center' }}>
        {error ?? ''}
      </AppText>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: 3 * 76 + 2 * space.xl, gap: space.lg, columnGap: space.xl }}>
        {KEYS.map((key) => {
          const hidden = key === 'bio' && !onBiometrics;
          return (
            <Pressable
              key={key}
              disabled={hidden}
              onPress={() => press(key)}
              accessibilityLabel={key === 'del' ? 'Delete' : key === 'bio' ? 'Biometrics' : key}
              style={({ pressed }) => ({
                width: 76,
                height: 76,
                borderRadius: 38,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: key === 'bio' || key === 'del' ? 'transparent' : pressed ? c.border : c.surfaceAlt,
                opacity: hidden ? 0 : 1,
              })}
            >
              {key === 'del' ? (
                <Icon name="backspace" color={c.text} size={26} />
              ) : key === 'bio' ? (
                <Icon name={biometryIcon ?? 'faceId'} color={c.primary} size={30} />
              ) : (
                <AppText style={{ fontFamily: fonts.medium, fontSize: 28, lineHeight: 34 }}>{key}</AppText>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
