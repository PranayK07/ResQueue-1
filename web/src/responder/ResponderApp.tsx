import '@fontsource/ibm-plex-mono/600.css';
import { useEffect, useState } from 'react';
import { useNow } from '../lib/useNow';
import { MissionDetail } from './components/MissionDetail';
import { QueuePane } from './components/QueuePane';
import { ResponderMap } from './components/ResponderMap';
import { activeMission, clockHMSTz, queueItems, simNow } from '../ops/derive';
import { fetchRoute, type Route } from '../ops/routing';
import type { MissionOutcome } from '../ops/types';
import { useResponderData } from '../ops/hooks';
import './responder.css';

/** Responder phone: split map + station queue, mission detail, expanded map (Figma 32:1253 / 32:1356 / 32:1440). */
export function ResponderApp({ unitId }: { unitId: number }) {
  const { snapshot, source } = useResponderData(unitId);
  const nowMs = useNow(1000);
  const nowS = simNow(snapshot.clock, nowMs);

  const items = queueItems(snapshot);
  const active = activeMission(snapshot, items);
  const me = snapshot.units.find(u => u.id === snapshot.me.unitId) ?? null;

  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A request that was completed or reassigned away disappears from the view.
  const selected = selectedId === null ? null : (items.find(i => i.request.id === selectedId) ?? null);
  const focus = selected ?? active ?? items[0] ?? null;
  const routeUnit = (focus && snapshot.units.find(u => u.id === focus.unitId)) || me;

  // Road route for whatever is in focus.
  const [route, setRoute] = useState<{ key: string; route: Route } | null>(null);
  const from: [number, number] | null = routeUnit ? [routeUnit.lon, routeUnit.lat] : null;
  const to: [number, number] | null = focus ? [focus.request.lon, focus.request.lat] : null;
  const routeKey = from && to ? [...from, ...to].join(',') : '';
  useEffect(() => {
    if (!routeKey) return;
    let live = true;
    const [a, b, c, d] = routeKey.split(',').map(Number);
    fetchRoute([a, b], [c, d]).then(r => live && setRoute({ key: routeKey, route: r }));
    return () => {
      live = false;
    };
  }, [routeKey]);

  async function complete(outcome: MissionOutcome) {
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      await source.completeMission(me.id, outcome);
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the mission.');
    } finally {
      setBusy(false);
    }
  }

  const ago = Math.max(0, Math.round((nowMs - snapshot.updatedAtMs) / 1000));

  return (
    <div className="rapp">
      <header className="rbar">
        <p className="rbar__updated">
          Updated {clockHMSTz(snapshot.updatedAtMs).split(' ')[0]} · {ago}s ago
        </p>
        <div className="rbar__right">
          <span className="rbar__sim">SIM</span>
          <a className="rbar__switch" href="#/">
            Caller view
          </a>
          <a className="rbar__switch" href="#/command">
            Command view
          </a>
        </div>
      </header>

      <div className="rapp__panes">
        <ResponderMap
          snapshot={snapshot}
          nowS={nowS}
          focus={focus}
          unit={routeUnit}
          route={route?.key === routeKey ? route.route : null}
          expanded={expanded}
          onToggleExpanded={() => setExpanded(e => !e)}
        />
        {!expanded &&
          (selected ? (
            <MissionDetail
              key={String(selected.request.id)}
              item={selected}
              mine={selected === active}
              clock={snapshot.clock}
              nowS={nowS}
              busy={busy}
              error={error}
              onBack={() => setSelectedId(null)}
              onComplete={() => complete('rescued')}
              onCantReach={() => complete('aborted')}
            />
          ) : (
            <QueuePane
              stationName={snapshot.station.name}
              items={items}
              active={active}
              focusId={focus?.request.id ?? null}
              nowS={nowS}
              onOpen={item => {
                setError(null);
                setSelectedId(item.request.id);
              }}
            />
          ))}
      </div>
    </div>
  );
}
