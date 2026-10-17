import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BankCard } from '../../components/BankCard';
import { Icon, type IconName } from '../../components/Icon';
import { LanguageSwitch } from '../../components/LanguageSwitch';
import { LogoBadge } from '../../components/Logo';
import { AppText, Button } from '../../components/ui';
import { fonts, radius, space, useColors } from '../../theme';

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'globe', title: 'welcome.f1Title', text: 'welcome.f1Text' },
  { icon: 'phone', title: 'welcome.f2Title', text: 'welcome.f2Text' },
  { icon: 'coins', title: 'welcome.f3Title', text: 'welcome.f3Text' },
  { icon: 'shield', title: 'welcome.f4Title', text: 'welcome.f4Text' },
];

export default function Welcome() {
  const { t } = useTranslation();
  const c = useColors();

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.xl, maxWidth: 560, width: '100%', alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <LogoBadge size={40} />
          <AppText variant="heading" style={{ fontFamily: fonts.bold, letterSpacing: 1 }}>
            GUDEX
          </AppText>
        </View>

        <View style={{ gap: space.sm }}>
          <AppText variant="title" style={{ fontSize: 30, lineHeight: 36 }}>
            {t('welcome.tagline')}
          </AppText>
          <AppText muted>{t('welcome.subtitle')}</AppText>
        </View>

        <View style={{ paddingHorizontal: space.xl }}>
          <BankCard placeholder />
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md }}>
          {FEATURES.map((f) => (
            <View
              key={f.icon}
              style={{ width: '48.5%', backgroundColor: c.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: c.border }}
            >
              <LinearGradient
                colors={c.gradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name={f.icon} color="#FFFFFF" size={20} />
              </LinearGradient>
              <AppText variant="bodyMedium" style={{ fontFamily: fonts.semibold }}>
                {t(f.title)}
              </AppText>
              <AppText variant="caption" muted>
                {t(f.text)}
              </AppText>
            </View>
          ))}
        </View>

        <LanguageSwitch />
      </ScrollView>

      <View style={{ padding: space.lg, gap: space.md, borderTopWidth: 1, borderTopColor: c.border, maxWidth: 560, width: '100%', alignSelf: 'center' }}>
        <Button title={t('welcome.signUp')} onPress={() => router.push('/register')} />
        <Button title={t('welcome.signIn')} variant="secondary" onPress={() => router.push('/login')} />
      </View>
    </SafeAreaView>
  );
}
