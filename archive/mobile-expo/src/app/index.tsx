import { Redirect } from 'expo-router';
import { Loading } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Index() {
  const { status } = useAuth();
  if (status === 'loading') return <Loading />;
  return <Redirect href={status === 'signedIn' ? '/home' : '/welcome'} />;
}
