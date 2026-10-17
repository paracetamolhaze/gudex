import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { haptic } from '../lib/telegram';
import { Icon, type IconName } from './Icon';

const TABS: { to: string; icon: IconName; label: 'tabs.home' | 'tabs.card' | 'tabs.history' | 'tabs.profile' }[] = [
  { to: '/', icon: 'home', label: 'tabs.home' },
  { to: '/card', icon: 'card', label: 'tabs.card' },
  { to: '/history', icon: 'history', label: 'tabs.history' },
  { to: '/profile', icon: 'user', label: 'tabs.profile' },
];

export function TabBar() {
  const { t } = useTranslation();
  return (
    <nav className="tabbar">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end replace onClick={() => haptic.select()}>
          <Icon name={tab.icon} size={24} />
          {t(tab.label)}
        </NavLink>
      ))}
    </nav>
  );
}
