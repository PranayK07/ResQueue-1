import { useEffect, useState } from 'react';
import roadDemo from '../../public/replay/demo.json';
import { LiveMap } from '../components/LiveMap';
import { IncidentAreaWarning } from '../components/IncidentAreaWarning';
import { OptionalDetailsForm } from '../components/OptionalDetailsForm';
import { AppShell, Button, Heading, LocationBlock, Note, Panel, SafetyNotice, ScreenSection, StatusNotice } from '../components/ui';
import { defaultIncidentLocation, insideIncidentArea, validIncidentArea } from '../lib/incidentArea';
import { coordsPlace } from '../lib/geo';
import { CONSENT_MINUTES, EMPTY_DETAILS, NEED_LABELS, clock, newRequest, type CallerLocation, type Details, type Need, type HelpRequest } from '../lib/request';
import type { PositionState } from '../lib/useCurrentPosition';
import { simNow, simToMs } from '../ops/derive';
import { CorrectLocationScreen } from '../screens/CorrectLocationScreen';
import { RequestHelpScreen } from '../screens/RequestHelpScreen';
import { SendingScreen } from '../screens/SendingScreen';
import { UpdateLocationScreen } from '../screens/UpdateLocationScreen';
import { connection } from './connection';
import { errorCopy } from './errors';
import { SurfaceContext, useConnection, useLiveClock, useLiveRows } from './hooks';
import { callWithCopy } from './reducers';
import type { RowOf } from './tables';
import { tsToMs } from './time';

const ACTIVE = new Set(['pending', 'queued', 'assigned', 'en_route', 'on_scene']);
type Card = RowOf<'my_requests'>;
const detailsOf = (card: Card): Details => ({ headcount: card.headcount, needs: card.needs.split(',').filter(n => n in NEED_LABELS) as Need[], note: card.note, media: [] });
const locationOf = (card: Card): CallerLocation => ({ ...coordsPlace(card.lat, card.lon), entrance: card.entrance });
const TITLE: Record<string, string> = {
  pending: 'Your request was received', queued: 'Your request is in the rescue queue', assigned: 'A unit has been assigned',
  en_route: 'Your responder is en route', on_scene: 'Your responder is on scene', rescued: 'Assistance completed',
  safe: 'Your request is closed', revoked: 'Location sharing stopped', expired: 'Location sharing expired', not_found: 'Request closed by the crew',
};

/** The database card is the receipt and assignment authority. No local dispatch timers. */
export function LiveCallerApp() {
  useEffect(() => { connection.use('caller'); }, []);
  return <SurfaceContext.Provider value="caller"><CallerFlow /></SurfaceContext.Provider>;
}

function CallerFlow() {
  const conn = useConnection();
  const rows = useLiveRows('my_requests');
  const grids = useLiveRows('grid');
  const fires = useLiveRows('fire_cell');
  const incidents = useLiveRows('incident');
  const clocks = useLiveRows('sim_clock');
  const liveClock = useLiveClock();
  const [seed] = useState(() => Math.random());
  const [placedAt] = useState(() => Date.now());
  const scenario = clocks[0]?.scenario;
  const area = validIncidentArea(grids[0]) ? grids[0] : null;
  const incidentKey = area ? [scenario, incidents[0]?.key, area.originLat, area.originLon, area.rows, area.cols, area.cellSizeM].join(':') : null;
  const [placed, setPlaced] = useState<{ key: string; location: CallerLocation } | null>(null);
  const [corrected, setCorrected] = useState<{ key: string; location: CallerLocation } | null>(null);
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const [overlay, setOverlay] = useState<'correct' | 'update' | null>(null);
  const [dismissed, setDismissed] = useState<Set<bigint>>(() => new Set());
  const [pending, setPending] = useState<ReturnType<typeof newRequest> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<Details>(EMPTY_DETAILS);

  // Default from the loaded incident in every live environment, independently of local demo flags.
  if (incidentKey && placed?.key !== incidentKey && area) {
    const point = defaultIncidentLocation(area, fires, seed, incidents[0]?.key === roadDemo.sourceId ? roadDemo.callerLocations : []);
    if (point) setPlaced({ key: incidentKey, location: point });
  }

  const startingLocation = placed?.key === incidentKey ? placed.location : null;
  const correctedLocation = corrected?.key === incidentKey ? corrected.location : null;
  const position: PositionState = startingLocation
    ? { status: 'found', source: 'incident', lat: startingLocation.lat, lon: startingLocation.lon, accuracyM: 0, fixedAt: placedAt }
    : { status: 'locating', source: 'incident' };
  const location = correctedLocation ?? startingLocation;
  const locationInArea = !!location && insideIncidentArea(area, location);
  const card = [...rows].sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt)).find(r => ACTIVE.has(r.status))
    ?? [...rows].sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt)).find(r => !dismissed.has(r.requestId));

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); setEditing(false); }
    catch (e) { setError(errorCopy(e)); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!location || !locationInArea || !conn.canCall || busy) return;
    setPending(newRequest(location, details));
    await run(() => callWithCopy('submit_app_request', { lat: location.lat, lon: location.lon, entrance: location.entrance,
      headcount: details.headcount, needs: details.needs.join(','), note: details.note, consentMinutes: CONSENT_MINUTES }));
    setPending(null);
  }

  const connectionNotice = conn.surface !== 'caller' || !conn.ready
    ? <StatusNotice title="Connecting to the rescue queue">{conn.error || 'Waiting for the shared incident. Your alert has not been sent.'}</StatusNotice>
    : conn.state !== 'live' ? <StatusNotice title="Connection interrupted">Showing the last confirmed status. Reconnecting…</StatusNotice> : null;
  const errorNotice = error ? <StatusNotice title="Could not complete that action">{error}</StatusNotice> : null;

  if (card) {
    const active = ACTIVE.has(card.status);
    const confirmedLocation = locationOf(card);
    const currentDetails = detailsOf(card);
    const local: HelpRequest = { token: `live:${card.requestId}`, number: String(card.requestId), location: confirmedLocation,
      details: currentDetails, phase: 'assigned', createdAt: tsToMs(card.createdAt), receivedAt: tsToMs(card.createdAt),
      updatedAt: tsToMs(card.updatedAt), arrivalAt: null, sharedUntil: tsToMs(card.consentExpiresAt), dispatch: null, locationUpdatedAt: null };
    if (active && overlay === 'update') return <UpdateLocationScreen key={`${incidentKey}:${card.requestId}`} incidentArea={area} request={local} onKeep={() => setOverlay(null)} onSend={async next => {
      await callWithCopy('update_my_request', { requestId: card.requestId, lat: next.lat, lon: next.lon, entrance: next.entrance,
        headcount: card.headcount, needs: card.needs, note: card.note });
      if (incidentKey) setCorrected({ key: incidentKey, location: next }); setOverlay(null);
    }} />;
    const eta = liveClock && card.etaS !== undefined ? Math.max(0, Math.ceil((card.etaS - simNow(liveClock)) / 60)) : null;
    return <AppShell responderUnitId={card.unitId}>
      <ScreenSection>
        {connectionNotice}
        <Note>REQUEST Q-{String(card.requestId).padStart(3, '0')}</Note>
        <Heading>{TITLE[card.status] ?? card.status}</Heading>
        <Note tone="ink" size={14}>{card.reason || (active ? 'Incident command can see your request.' : 'Your location is no longer shared.')}</Note>
        {active && <>
          <LocationBlock label="Shared location" location={confirmedLocation} />
          <LiveMap point={confirmedLocation} height={220} />
          <Note>Your location and updates are visible to incident command and your assigned station.</Note>
        </>}
        {active && <Panel>
          <p className="panel__title">{card.unitCallsign || card.stationName || 'Awaiting assignment'}</p>
          {card.stationName && <Note>{card.stationName}</Note>}
          {eta !== null && <><p className="travel__eta">{eta} min</p><Note>Estimated arrival · {clock(simToMs(liveClock!, card.etaS!))} on the replay clock</Note></>}
          {card.queuePosition > 0 && <Note>Station queue position: {card.queuePosition}</Note>}
          {!card.unitCallsign && <Note>No unit is committed yet. This page updates when command assigns one.</Note>}
        </Panel>}
        {card.intakeReply && active && <Note>{card.intakeReply}</Note>}
      </ScreenSection>
      <ScreenSection secondary>
        {errorNotice}
        {active ? <>
          <Note tone="ink" size={14}>{card.headcount} {card.headcount === 1 ? 'person' : 'people'} · {card.needs || 'No listed needs'}</Note>
          {card.note && <Note>{card.note}</Note>}
          {editing ? <>
            <OptionalDetailsForm idPrefix="live-edit" value={edit} onChange={setEdit} allowMedia={false} />
            <Button variant="primary" disabled={busy || !conn.canCall} onClick={() => run(() => callWithCopy('update_my_request', {
              requestId: card.requestId, lat: card.lat, lon: card.lon, entrance: card.entrance,
              headcount: edit.headcount, needs: edit.needs.join(','), note: edit.note,
            }))}>Save details</Button>
            <Button onClick={() => setEditing(false)}>Cancel editing</Button>
          </> : <Button disabled={busy} onClick={() => { setEdit(currentDetails); setEditing(true); }}>Edit request details</Button>}
          <Button disabled={busy || !conn.canCall} onClick={() => setOverlay('update')}>My location has changed</Button>
          <Button disabled={busy || !conn.canCall} onClick={() => run(() => callWithCopy('close_my_request', { requestId: card.requestId, externalRef: '', outcome: 'safe' }))}>I’m safe — close request</Button>
          <Note>Location shared until {clock(tsToMs(card.consentExpiresAt))}. Closing the request stops sharing.</Note>
        </> : <Button onClick={() => { setDismissed(new Set(rows.filter(r => !ACTIVE.has(r.status)).map(r => r.requestId))); setDetails(EMPTY_DETAILS); setOverlay(null); }}>Start another request</Button>}
        <SafetyNotice />
      </ScreenSection>
    </AppShell>;
  }
  if (pending && busy) return <SendingScreen request={pending} />;
  if (overlay === 'correct') return <CorrectLocationScreen key={incidentKey} incidentArea={area} position={position} initial={location} onConfirm={next => { if (incidentKey) setCorrected({ key: incidentKey, location: next }); setOverlay(null); }} />;
  return <RequestHelpScreen position={position} location={location} corrected={!!correctedLocation} details={details} onDetailsChange={setDetails}
    onRetryLocate={() => {}} onAdjustLocation={() => setOverlay('correct')} onSend={send}
    canSend={conn.surface === 'caller' && conn.ready && conn.canCall && !busy && locationInArea} allowMedia={false}
    notice={<>{connectionNotice}{errorNotice}<IncidentAreaWarning area={area} point={location} /></>} />;
}
