import { type ReactNode, useEffect } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { TabBar } from './components/TabBar';
import { Loading } from './components/ui';
import { setLocale } from './i18n';
import { useMe } from './lib/queries';
import { useSession } from './lib/session';
import { CardScreen } from './screens/Card';
import { CardBilling } from './screens/CardBilling';
import { CardAdditionalAttempt } from './screens/CardAdditionalAttempt';
import { Admin } from './screens/Admin';
import { adminQueryValid } from './lib/admin';
import { BootError, Lock, Onboarding, Outside } from './screens/Entry';
import { Home } from './screens/Home';
import { Buy } from './screens/Buy';
import { Help, Referral, Tariffs } from './screens/Info';
import { LegalScreen, TermsGate } from './screens/Legal';
import { Transfer, Withdraw } from './screens/Money';
import { History, Kyc, PinChange, Profile, WalletPay } from './screens/Other';
import { CardIssue, CardTopup, Deposit } from './screens/Wallet';

const TAB_PATHS = ['/', '/card', '/history', '/profile'];

function MainApp() {
  const location = useLocation();
  const { data: me } = useMe();

  // Язык, выбранный в профиле, хранится на сервере.
  useEffect(() => {
    if (me?.locale) setLocale(me.locale);
  }, [me?.locale]);

  // Каждый экран начинается сверху.
  // Фигурные скобки обязательны: в новых браузерах scrollTo возвращает Promise, а эффект не должен.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // Clients who signed up before the documents existed accept them once before using the app.
  if (me && me.termsAccepted === false) return <TermsGate />;

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/card" element={<CardScreen />} />
        <Route path="/history" element={<History />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/admin/clients/:query" element={<Admin />} />
        <Route path="/deposit" element={<Deposit />} />
        <Route path="/kyc" element={<Kyc />} />
        <Route path="/card/issue" element={<CardIssue />} />
        <Route path="/card/billing" element={<CardBilling />} />
        <Route path="/card/additional-attempt" element={<CardAdditionalAttempt />} />
        <Route path="/card/topup" element={<CardTopup />} />
        <Route path="/wallet-pay" element={<WalletPay />} />
        <Route path="/pin/change" element={<PinChange />} />
        <Route path="/withdraw" element={<Withdraw />} />
        <Route path="/transfer" element={<Transfer />} />
        <Route path="/referral" element={<Referral />} />
        <Route path="/tariffs" element={<Tariffs />} />
        <Route path="/help" element={<Help />} />
        <Route path="/buy" element={<Buy />} />
        <Route path="/legal/:kind" element={<LegalScreen />} />
      </Routes>
      {TAB_PATHS.includes(location.pathname) ? <TabBar /> : null}
    </>
  );
}

// Маршрутизация в памяти: в Mini App нет адресной строки, а hash занят параметрами запуска Telegram.
// Only the explicit admin entry path is accepted from the address bar; Telegram hash is untouched.
const adminClientPath = window.location.pathname.match(/^\/admin\/clients\/([A-Za-z0-9-]+)\/?$/)?.[1];
const initialEntries = window.location.pathname === '/admin' || window.location.pathname === '/admin/'
  ? ['/profile', '/admin'] : adminClientPath && adminQueryValid(adminClientPath)
    ? ['/profile', `/admin/clients/${adminClientPath}`] : ['/'];

export function App() {
  const { stage } = useSession();
  let screen: ReactNode;
  switch (stage) {
    case 'loading':
      screen = <Loading />; break;
    case 'outside':
      screen = <Outside />; break;
    case 'error':
      screen = <BootError />; break;
    case 'onboarding':
      screen = <Onboarding />; break;
    case 'locked':
      screen = <Lock />; break;
    case 'ready':
      screen = <MainApp />; break;
  }
  // Preserve only in-memory navigation through relock; private screens still unmount.
  return <MemoryRouter initialEntries={initialEntries}>{screen}</MemoryRouter>;
}
