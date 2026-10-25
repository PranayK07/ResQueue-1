import { useEffect, useState } from 'react';
import { CallerApp } from './CallerApp';
import { CommandApp } from './command/CommandApp';
import { isLive } from './live/config';
import { useLiveRows } from './live/hooks';
import { LiveGate } from './live/LiveGate';
import { RESPONDER_ME } from './ops/sim/scenario';
import { ResponderApp } from './responder/ResponderApp';

// Hash routes so the static build works on any host:
//   #/ (caller) · #/responder[/<unitId>] (phone; default E21 in the simulation, unit 1 live) · #/command[/queue].

/** Live phone for one unit: its own identity, signed in as a responder of the unit's station. */
function LiveResponder({ unitId }: { unitId: number }) {
  const surface = `responder:${unitId}` as const;
  const units = useLiveRows('unit', surface);
  const unit = units.find(u => u.id === unitId);
  const others = units.map(u => u.id).sort((a, b) => a - b);
  return (
    <LiveGate
      surface={surface}
      role="responder"
      stationId={unit?.stationId}
      title={unit ? `Responder · ${unit.callsign}` : `Responder · unit ${unitId}`}
      subtitle="Sign in with the operator passcode."
    >
      {unit ? (
        <ResponderApp unitId={unitId} />
      ) : (
        <p style={{ padding: 24 }}>
          Unit {unitId} is not in this scenario.{' '}
          {others.map(id => (
            <a key={id} href={`#/responder/${id}`} style={{ marginRight: 8 }}>
              Unit {id}
            </a>
          ))}
        </p>
      )}
    </LiveGate>
  );
}
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

const TITLES: [RegExp, string][] = [
  [/^\/responder/, 'ResQueue · Responder'],
  [/^\/command/, 'ResQueue · Command'],
];

export default function App() {
  const route = useHashRoute();
  useEffect(() => {
    document.title = TITLES.find(([re]) => re.test(route))?.[1] ?? 'ResQueue · Request help';
  }, [route]);
  const phone = route.match(/^\/responder(?:\/(\d+))?$/);
  if (phone) {
    // Live scenarios number their units from 1 (the recorded bundle: SIM-1..SIM-4); the simulation's phone is E21.
    const unitId = phone[1] ? Number(phone[1]) : isLive ? 1 : RESPONDER_ME.unitId;
    return isLive ? <LiveResponder key={unitId} unitId={unitId} /> : <ResponderApp key={unitId} unitId={unitId} />;
  }
  if (route.startsWith('/command')) return <CommandApp route={route} />;
  return <CallerApp />;
}
