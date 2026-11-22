import { useEffect, useState } from 'react';
import { CustomerStorefront } from './components/CustomerStorefront';
import { LivePosTerminal } from './components/LivePosTerminal';
import { OpsPortal, type OpsDestination } from './components/OpsPortal';

function parseRoute() {
  const { pathname, search } = window.location;
  const params = new URLSearchParams(search);
  const posMatch = pathname.match(/^\/pos\/([^/]+)\/?$/);
  if (posMatch) {
    return {
      inOps: false,
      dest: null as OpsDestination | null,
      posShopId: decodeURIComponent(posMatch[1]),
      posKey: params.get('k') ?? '',
    };
  }
  const inOps = pathname === '/ops' || pathname.startsWith('/ops/');
  const dest = params.get('dest') as OpsDestination | null;
  return { inOps, dest, posShopId: null as string | null, posKey: '' };
}

export function navigateToAppPath(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export default function App() {
  const [route, setRoute] = useState(parseRoute);

  useEffect(() => {
    const onPopState = () => {
      setRoute(parseRoute());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  if (route.posShopId) {
    return (
      <LivePosTerminal
        shopId={route.posShopId}
        qrKey={route.posKey}
        onExitToStore={() => navigateToAppPath('/')}
      />
    );
  }

  if (route.inOps) {
    return <OpsPortal initialDestination={route.dest ?? undefined} />;
  }

  return (
    <CustomerStorefront
      onSwitchRole={(dest) => {
        if (dest === 'customer') return;
        navigateToAppPath(`/ops?dest=${encodeURIComponent(dest)}`);
      }}
    />
  );
}

