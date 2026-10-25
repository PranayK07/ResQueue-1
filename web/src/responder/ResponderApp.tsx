import '@fontsource/ibm-plex-mono/600.css';
import { useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useNow } from '../lib/useNow';
import { useWatchPosition } from '../lib/useWatchPosition';
import { activeMission, clockHM, etaMinutes, formatSlack, queueItems, requestCode, simNow, simToMs, type QueueItem } from '../ops/derive';
import { useResponderData } from '../ops/hooks';
import { distanceText, googleMapsUrl, progressAlong } from '../ops/navigation';
import { fetchRoute, metersBetween, type Route } from '../ops/routing';
import type { MissionOutcome } from '../ops/types';
import { ActiveMission } from './components/ActiveMission';
import { DangerLevelTag } from './components/DangerLevelTag';
import { DirectionsSheet, SHEET_PEEK } from './components/DirectionsSheet';
import { NavMap } from './components/NavMap';
import { QueueDropdown } from './components/QueueDropdown';
import brandMark from '../assets/figma/brand-mark.svg';
import './responder.css';

type LngLat = [number, number];
const OFF_ROUTE_M = 80; // GPS further than this from the line → re-route
const REROUTE_MIN_GAP_MS = 15_000;
const FAR_FROM_INCIDENT_M = 50_000;

/** Responsive responder workspace: mobile overlays become a desktop side pane. */
export function ResponderApp({ unitId }: { unitId: number }) {
  const { snapshot: s, source } = useResponderData(unitId);
  const nowMs = useNow(1000);
  const nowS = simNow(s.clock, nowMs);

  const items = queueItems(s);
  const active = activeMission(s, items);
  const me = s.units.find(u => u.id === s.me.unitId) ?? null;
  const callsign = me?.callsign ?? `Unit ${unitId}`;
  const myStops = items.filter(i => i.unitId === s.me.unitId && !i.committed);
  const stationStops = items.filter(i => i.unitId !== s.me.unitId);
  const onScene = me?.status === 'on_scene';

  // ─── UI state ───
  const [queueOpen, setQueueOpen] = useState(false);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [sheetH, setSheetH] = useState(SHEET_PEEK);
  const [previewId, setPreviewId] = useState<bigint | null>(null);
  const [useGps, setUseGps] = useState(false);
  const [follow, setFollow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appH, setAppH] = useState(() => window.innerHeight);
  // Keep this breakpoint in sync with responder.css.
  const desktop = useMediaQuery('(min-width: 1000px)');
  const mapBottom = desktop ? 0 : sheetH;
  useEffect(() => {
    const onResize = () => setAppH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ─── Where we're going, and from where ───
  const preview = previewId === null ? null : (items.find(i => i.request.id === previewId) ?? null);
  const target: QueueItem | null = preview ?? active ?? myStops[0] ?? null;
  const targetIdx = target ? myStops.indexOf(target) : -1;
  // Live guidance from the vehicle's position; a later stop is previewed from the stop before it.
  const live = !!target && (target === active || (!active && targetIdx === 0));
  const laterStops = (target === active ? myStops : targetIdx >= 0 ? myStops.slice(targetIdx + 1) : []).slice(0, 4);

  const gps = useWatchPosition(useGps);
  const gpsPos: LngLat | null = gps.status === 'tracking' ? [gps.lon, gps.lat] : null;
  const unitPos: LngLat | null = me ? [me.lon, me.lat] : null;
  const position = useGps ? gpsPos : unitPos;

  const chainOrigin: LngLat | null =
    !target || live
      ? null
      : targetIdx > 0
        ? [myStops[targetIdx - 1].request.lon, myStops[targetIdx - 1].request.lat]
        : targetIdx === 0 && active
          ? [active.request.lon, active.request.lat]
          : null;

  // ─── Route: fetched once per target and origin choice; re-routed on demand ───
  const [reroute, setReroute] = useState(0);
  const [route, setRoute] = useState<{ key: string; route: Route } | null>(null);
  const positionRef = useRef(position);
  useEffect(() => {
    positionRef.current = position;
  });
  const hasOrigin = !!(chainOrigin ?? position);
  const routeKey = target && hasOrigin ? `${target.request.id}:${target.request.lon},${target.request.lat}:${chainOrigin ? chainOrigin.join(',') : useGps ? 'gps' : 'unit'}:${reroute}` : '';
  const destLon = target?.request.lon;
  const destLat = target?.request.lat;
  useEffect(() => {
    if (!routeKey || destLon === undefined || destLat === undefined) return;
    const origin = chainOrigin ?? positionRef.current;
    if (!origin) return;
    let alive = true;
    fetchRoute(origin, [destLon, destLat]).then(r => alive && setRoute({ key: routeKey, route: r }));
    return () => {
      alive = false;
    };
    // routeKey encodes the target and origin choice; the live origin is read once, at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);
  const currentRoute = route?.key === routeKey ? route.route : null;

  const progress = currentRoute ? progressAlong(currentRoute, live && position ? position : currentRoute.coords[0]) : null;

  // Off the line with real GPS: get a fresh route (at most every 15 s).
  const lastReroute = useRef(0);
  const offRoute = !!(live && useGps && progress && progress.offRouteM > OFF_ROUTE_M);
  useEffect(() => {
    if (!offRoute || nowMs - lastReroute.current < REROUTE_MIN_GAP_MS) return;
    lastReroute.current = nowMs;
    const t = setTimeout(() => setReroute(n => n + 1));
    return () => clearTimeout(t);
  }, [offRoute, nowMs]);

  // ─── Actions ───
  async function complete(outcome: MissionOutcome) {
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      await source.completeMission(me.id, outcome);
      setPreviewId(null);
      setFollow(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the mission.');
    } finally {
      setBusy(false);
    }
  }
  const backToCurrent = () => {
    setPreviewId(null);
    setFollow(true);
  };

  const ago = Math.max(0, Math.round((nowMs - s.updatedAtMs) / 1000));
  const destName = target ? requestCode(target.request.id) : '';
  const etaText = target ? `ETA ${clockHM(simToMs(s.clock, target.etaS))} · ${etaMinutes(target.etaS, nowS)} min` : '';
  const farMeters = useGps && gpsPos && target ? metersBetween(gpsPos, [target.request.lon, target.request.lat]) : 0;
  const pinned = myStops.some(i => i.request.pinnedUnitId === s.me.unitId);
  const missionCard = active ? (
    <ActiveMission
      item={active}
      clock={s.clock}
      nowS={nowS}
      onScene={onScene}
      busy={busy}
      error={error}
      onComplete={() => complete('rescued')}
      onCantReach={() => complete('aborted')}
    />
  ) : null;

  return (
    <div className="rapp">
      <header className="rbar">
        <p className="rbar__updated" title="Last update from the queue">
          <img src={brandMark} width={11} height={14} alt="" />
          <b>ResQueue</b>
          <span className="rbar__time">{clockHM(s.updatedAtMs)} · {ago}s ago</span>
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

      <button type="button" className={`mbar${queueOpen ? ' is-open' : ''}`} aria-expanded={queueOpen} aria-controls="queue-dropdown" onClick={() => setQueueOpen(o => !o)}>
        <span className="mbar__mission">
          {target ? (
            <>
              <span className="mbar__label">
                {preview ? 'PREVIEW' : target === active ? (onScene ? 'ON SCENE' : me?.status === 'assigned' ? 'ASSIGNED' : 'EN ROUTE') : 'NEXT'} · {callsign}
              </span>
              <span className="mbar__line">
                <span className="mono mbar__code">{requestCode(target.request.id)}</span>
                <DangerLevelTag level={target.request.level} />
                <span className={`mono mbar__slack mbar__slack--${target.request.level}`}>{formatSlack(target.request.slackS)}</span>
              </span>
            </>
          ) : (
            <>
              <span className="mbar__label">
                {callsign} · {s.station.name}
              </span>
              <span className="mbar__line">No missions assigned</span>
            </>
          )}
        </span>
        <span className="mbar__queue">
          Queue · {myStops.length + (active ? 1 : 0)}
          <span aria-hidden className="mbar__chev">
            ▾
          </span>
        </span>
      </button>

      <div className={`rapp__stage${queueOpen ? ' rapp__stage--queue-open' : ''}`} style={{ ['--nav-top' as string]: '10px', ['--nav-bottom' as string]: `${mapBottom + 8}px` }}>
        <NavMap
          snapshot={s}
          target={target}
          route={currentRoute}
          position={live ? (onScene && target === active ? null : position) : chainOrigin}
          positionLabel={live ? callsign : `After ${targetIdx > 0 ? requestCode(myStops[targetIdx - 1].request.id) : active ? requestCode(active.request.id) : '—'}`}
          gps={live && useGps}
          laterStops={laterStops}
          follow={follow && live}
          onUserMove={() => setFollow(false)}
          padding={{ top: 0, bottom: mapBottom }}
        />

        {(!follow || !live) && (position || chainOrigin) && (
          <button type="button" className="recenter" style={{ bottom: mapBottom + 14 }} onClick={backToCurrent}>
            ◎ {preview ? 'Back to my route' : 'Recenter'}
          </button>
        )}

        {queueOpen && (
          <>
            <div className="qdrop-scrim" onClick={() => setQueueOpen(false)} aria-hidden />
            <div id="queue-dropdown" className="qdrop-wrap">
              <QueueDropdown
                callsign={callsign}
                stationName={s.station.name}
                mission={missionCard}
                myStops={myStops}
                stationStops={stationStops.filter(i => i !== active)}
                nowS={nowS}
                pinned={pinned}
                previewId={previewId}
                onPreview={item => {
                  setPreviewId(item === active ? null : item.request.id);
                  setFollow(item === active);
                  setQueueOpen(false);
                }}
                onSaveOrder={ids => source.setStopOrder(ids)}
                onResetOrder={() => source.resetStopOrder()}
              />
            </div>
          </>
        )}

        <DirectionsSheet
          docked={desktop}
          appHeight={appH}
          expanded={sheetExpanded}
          onExpandedChange={setSheetExpanded}
          onHeightChange={setSheetH}
          destination={destName}
          route={currentRoute}
          progress={progress}
          arrived={!!(onScene && target === active)}
          etaText={etaText}
          empty={target ? undefined : `No stops for ${callsign}. New missions appear here.`}
          notice={
            <>
              {preview && (
                <p className="dsheet__notice">
                  Previewing {targetIdx >= 0 ? `stop ${targetIdx + 2}` : `${preview.unitCallsign}’s stop`} · {destName}.{' '}
                  <button type="button" className="rlink" onClick={backToCurrent}>
                    Back to current
                  </button>
                </p>
              )}
              {useGps && gps.status === 'error' && <p className="dsheet__warn">{gps.message} Showing the unit’s position instead.</p>}
              {useGps && gps.status === 'locating' && <p className="dsheet__notice">Getting a GPS fix…</p>}
              {farMeters > FAR_FROM_INCIDENT_M && (
                <p className="dsheet__warn">This phone is {distanceText(farMeters)} from the simulated incident; directions from here are long.</p>
              )}
              {offRoute && <p className="dsheet__notice">Off route. Re-routing…</p>}
            </>
          }
          actions={
            <>
              {target && (
                <a
                  className="rchip rchip--primary"
                  href={googleMapsUrl(useGps ? null : (chainOrigin ?? unitPos), [target.request.lon, target.request.lat])}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Google Maps ↗
                </a>
              )}
              {target && <button type="button" className="rchip" onClick={() => setFollow(false)}>Show entire route</button>}
              <span className="rseg" role="group" aria-label="Route from">
                <button type="button" className={!useGps ? 'is-on' : ''} aria-pressed={!useGps} onClick={() => setUseGps(false)}>
                  Unit position
                </button>
                <button type="button" className={useGps ? 'is-on' : ''} aria-pressed={useGps} onClick={() => setUseGps(true)}>
                  Phone GPS
                </button>
              </span>
              {live && !(onScene && target === active) && (
                <button type="button" className="rchip" onClick={() => setReroute(n => n + 1)}>
                  Re-route
                </button>
              )}
            </>
          }
          arrivedContent={
            <div className="dsheet__arrived">
              <p>
                On scene at {destName}. {target?.request.headcount} {target?.request.headcount === 1 ? 'person' : 'people'} to extract.
              </p>
              <button type="button" className="raction raction--primary" disabled={busy} onClick={() => complete('rescued')}>
                {busy ? 'Saving…' : 'Mark complete'}
              </button>
              <button type="button" className="rlink" onClick={() => setQueueOpen(true)}>
                Mission details & Can’t reach
              </button>
            </div>
          }
          nextLeg={
            target === active && myStops[0] ? (
              <div className="dsheet__then">
                <span>
                  Then <b className="mono">{requestCode(myStops[0].request.id)}</b> · stop 2 · ETA {clockHM(simToMs(s.clock, myStops[0].etaS))}
                </span>
                <button
                  type="button"
                  className="rchip"
                  onClick={() => {
                    setPreviewId(myStops[0].request.id);
                    setFollow(false);
                  }}
                >
                  Preview route
                </button>
              </div>
            ) : null
          }
        />
      </div>
    </div>
  );
}
