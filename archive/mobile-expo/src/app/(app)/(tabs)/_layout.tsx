import { Tabs } from 'expo-router/js-tabs';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../../components/Icon';
import { fonts, useColors } from '../../../theme';

const TABS: { name: string; icon: IconName; title: 'tabs.home' | 'tabs.card' | 'tabs.history' | 'tabs.profile' }[] = [
  { name: 'home', icon: 'home', title: 'tabs.home' },
  { name: 'card', icon: 'card', title: 'tabs.card' },
  { name: 'history', icon: 'history', title: 'tabs.history' },
  { name: 'profile', icon: 'user', title: 'tabs.profile' },
];

export default function TabsLayout() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textSecondary,
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
        tabBarLabelStyle: { fontFamily: fonts.medium, fontSize: 12 },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{ title: t(tab.title), tabBarIcon: ({ color }) => <Icon name={tab.icon} color={String(color)} size={24} /> }}
        />
      ))}
    </Tabs>
  );
}
