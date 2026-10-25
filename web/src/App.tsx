import { useEffect, useState } from 'react';
import { CallerApp } from './CallerApp';
import { CommandApp } from './command/CommandApp';
import { RESPONDER_ME } from './ops/sim/scenario';
import { ResponderApp } from './responder/ResponderApp';

// Hash routes so the static build works on any host:
//   #/ (caller) · #/responder[/<unitId>] (phone, default E21) · #/command[/queue].
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

export default function App() {
  const route = useHashRoute();
  const phone = route.match(/^\/responder(?:\/(\d+))?$/);
  if (phone) {
    const unitId = phone[1] ? Number(phone[1]) : RESPONDER_ME.unitId;
    return <ResponderApp key={unitId} unitId={unitId} />;
  }
  if (route.startsWith('/command')) return <CommandApp route={route} />;
  return <CallerApp />;
}
