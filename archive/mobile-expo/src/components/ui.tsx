import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextProps,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fonts, radius, space, useColors } from '../theme';
import { Icon, type IconName } from './Icon';

// ─── Текст ───────────────────────────────────────────────────────────────

type Variant = 'display' | 'title' | 'heading' | 'body' | 'bodyMedium' | 'caption' | 'label';

const variants: Record<Variant, { fontFamily: string; fontSize: number; lineHeight: number }> = {
  display: { fontFamily: fonts.bold, fontSize: 36, lineHeight: 42 },
  title: { fontFamily: fonts.bold, fontSize: 26, lineHeight: 32 },
  heading: { fontFamily: fonts.semibold, fontSize: 18, lineHeight: 24 },
  body: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 22 },
  bodyMedium: { fontFamily: fonts.medium, fontSize: 16, lineHeight: 22 },
  caption: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
  label: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 18 },
};

export function AppText({
  variant = 'body',
  color,
  muted,
  style,
  ...rest
}: TextProps & { variant?: Variant; color?: string; muted?: boolean }) {
  const c = useColors();
  return <Text style={[variants[variant], { color: color ?? (muted ? c.textSecondary : c.text) }, style]} {...rest} />;
}

// ─── Экран ───────────────────────────────────────────────────────────────

export function Screen({
  children,
  scroll = true,
  edges = ['top'],
  contentStyle,
  refreshControl,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: ('top' | 'bottom')[];
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl'];
}) {
  const c = useColors();
  const content = [{ padding: space.lg, gap: space.lg, maxWidth: 560, width: '100%' as const, alignSelf: 'center' as const }, contentStyle];
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: c.background }}>
      {scroll ? (
        <ScrollView contentContainerStyle={[content, { paddingBottom: space.xxl }]} keyboardShouldPersistTaps="handled" refreshControl={refreshControl}>
          {children}
        </ScrollView>
      ) : (
        <View style={[content, { flex: 1 }]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Surface({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const c = useColors();
  return (
    <View style={[{ backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }, padded && { padding: space.lg }, style]}>
      {children}
    </View>
  );
}

// ─── Кнопки ──────────────────────────────────────────────────────────────

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  icon,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const bg = { primary: c.primary, secondary: c.surfaceAlt, ghost: 'transparent', danger: c.surfaceAlt }[variant];
  const fg = { primary: c.onPrimary, secondary: c.primary, ghost: c.primary, danger: c.danger }[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      style={({ pressed }) => [
        { height: 52, borderRadius: radius.md, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
        pressed && { opacity: 0.85 },
        inactive && { opacity: 0.5 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} color={fg} size={20} /> : null}
      <AppText variant="bodyMedium" color={fg} style={{ fontFamily: fonts.semibold }}>
        {title}
      </AppText>
    </Pressable>
  );
}

// Круглая кнопка с подписью — быстрые действия на главном и на карте.
export function ActionButton({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress?: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [{ alignItems: 'center', gap: space.sm, flex: 1 }, (pressed || disabled) && { opacity: 0.6 }]}>
      <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} color={c.primary} />
      </View>
      <AppText variant="label" style={{ textAlign: 'center' }}>
        {label}
      </AppText>
    </Pressable>
  );
}

// ─── Поля ввода ──────────────────────────────────────────────────────────

export function Field({ label, error, hint, ...input }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: space.xs }}>
      <AppText variant="label" muted>
        {label}
      </AppText>
      <TextInput
        placeholderTextColor={c.textSecondary}
        style={{
          height: 52,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: error ? c.danger : c.border,
          backgroundColor: c.surface,
          paddingHorizontal: space.lg,
          color: c.text,
          fontFamily: fonts.medium,
          fontSize: 16,
        }}
        {...input}
      />
      {error ? (
        <AppText variant="caption" color={c.danger}>
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="caption" muted>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: radius.md, padding: 4, gap: 4 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{ flex: 1, height: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? c.surface : 'transparent' }}
          >
            <AppText variant="label" color={active ? c.text : c.textSecondary} style={{ fontFamily: active ? fonts.semibold : fonts.medium }}>
              {o.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Сообщения ───────────────────────────────────────────────────────────

export function Notice({ text, tone = 'info', icon, action }: { text: string; tone?: 'info' | 'warning' | 'danger'; icon?: IconName; action?: ReactNode }) {
  const c = useColors();
  const palette = {
    info: { bg: c.surfaceAlt, fg: c.primary },
    warning: { bg: c.warningBg, fg: c.warning },
    danger: { bg: c.surfaceAlt, fg: c.danger },
  }[tone];
  return (
    <View style={{ flexDirection: 'row', gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: palette.bg, alignItems: 'center' }}>
      <Icon name={icon ?? 'alert'} color={palette.fg} size={20} />
      <AppText variant="caption" style={{ flex: 1 }}>
        {text}
      </AppText>
      {action}
    </View>
  );
}

export function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md }}>
      <AppText variant={strong ? 'bodyMedium' : 'body'} muted={!strong}>
        {label}
      </AppText>
      <AppText variant={strong ? 'heading' : 'bodyMedium'}>{value}</AppText>
    </View>
  );
}

export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <AppText variant="heading">{title}</AppText>
      {action}
    </View>
  );
}

export function Loading() {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl }}>
      <ActivityIndicator color={c.primary} />
    </View>
  );
}
