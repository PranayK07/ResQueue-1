import { useEffect, useState, type ReactNode } from 'react';
import { LiveMap } from '../components/LiveMap';
import { OptionalDetailsForm } from '../components/OptionalDetailsForm';
import { AppShell, Button, Heading, LocationBlock, Note, Panel, RequestProgress, SafetyNotice, ScreenSection, StatusNotice } from '../components/ui';
import { coordsPlace, reverseGeocode, type Place } from '../lib/geo';
import { CONSENT_MINUTES, EMPTY_DETAILS, NEED_LABELS, clock, newRequest, peopleSummary, type CallerLocation, type Details, type HelpRequest, type Need } from '../lib/request';
import { useCurrentPosition } from '../lib/useCurrentPosition';
import { simToMs } from '../ops/derive';
import { CorrectLocationScreen } from '../screens/CorrectLocationScreen';
import { RequestHelpScreen } from '../screens/RequestHelpScreen';
import { SendingScreen } from '../screens/SendingScreen';
import { UpdateLocationScreen } from '../screens/UpdateLocationScreen';
import { STDB_DB, STDB_URI } from './config';
import { connection } from './connection';
import { errorCopy, mapCallError } from './errors';
import { useConnection, useLiveClock, useLiveRows, useSimNow } from './hooks';
import { call, callWithCopy } from './reducers';
import type { RowOf } from './tables';
import { tsToMs } from './time';
import '../screens/screens.css';

const ACTIVE = new Set(['pending', 'queued', 'assigned', 'en_route', 'on_scene']);
const DRAFT_KEY = `wrq.live.draft:${STDB_URI}/${STDB_DB}`;
type Card = RowOf<'my_requests'>;

function loadDraft(): HelpRequest | null {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as HelpRequest | null;
    return draft?.location && draft?.details && draft?.token ? draft : null;
  } catch { return null; }
}

function unpackNote(note: string) {
  const firstBreak = note.indexOf('\n');
  if (!note.startsWith('Entrance: ')) return { entrance: '', note };
  return { entrance: note.slice(10, firstBreak < 0 ? undefined : firstBreak), note: firstBreak < 0 ? '' : note.slice(firstBreak + 1) };
}

function packedNote(location: CallerLocation, details: Details) {
  const text = [location.entrance.trim() ? `Entrance: ${location.entrance.trim()}` : '', details.note].filter(Boolean).join('\n');
  if (text.length > 500) throw new Error('Keep the entrance correction and description under 500 characters combined.');
  return text;
}

/** A resident's real identity and private subscription are the authority, including after reload or reconnect. */
export function LiveCallerApp() {
  useEffect(() => { connection.use('caller'); }, []);
  const conn = useConnection();
  const cards = useLiveRows('my_requests', 'caller');
  const grids = useLiveRows('grid', 'caller');
  const liveClock = useLiveClock('caller');
  const simS = useSimNow(liveClock);
  const { position, retry } = useCurrentPosition();
  const [resolved, setResolved] = useState<Place | null>(null);
  const [corrected, setCorrected] = useState<CallerLocation | null>(null);
  const [draft, setDraft] = useState<HelpRequest | null>(loadDraft);
  const [details, setDetails] = useState<Details>(() => loadDraft()?.details ?? EMPTY_DETAILS);
  const [overlay, setOverlay] = useState<'correct' | 'update' | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState<bigint | null>(null);

  const mine = conn.surface === 'caller';
  const ordered = [...cards].sort((a, b) => a.createdAt.microsSinceUnixEpoch > b.createdAt.microsSinceUnixEpoch ? -1 : 1);
  const card = ordered.find(c => ACTIVE.has(c.status));
  const closed = !card && ordered[0]?.requestId !== dismissed ? ordered[0] : undefined;
  const lat = position.status === 'found' ? position.lat : null;
  const lon = position.status === 'found' ? position.lon : null;
  useEffect(() => {
    if (lat === null || lon === null) return;
    const controller = new AbortController();
    reverseGeocode(lat, lon, controller.signal).catch(() => coordsPlace(lat, lon)).then(place => {
      if (!controller.signal.aborted) setResolved(place);
    });
    return () => controller.abort();
  }, [lat, lon]);
  useEffect(() => {
    if (card) localStorage.removeItem(DRAFT_KEY);
    else if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  }, [draft, card]);

  const detected = lat === null || lon === null ? null : { ...(resolved?.lat === lat && resolved.lon === lon ? resolved : coordsPlace(lat, lon)), entrance: '' };
  const location = corrected ?? draft?.location ?? detected;
  const grid = grids.find(g => g.id === 0) ?? grids[0];
  const incidentCenter = grid?.rows ? {
    lat: grid.originLat + grid.rows * grid.cellSizeM / 111_320 / 2,
    lon: grid.originLon + grid.cols * grid.cellSizeM / (111_320 * Math.cos(grid.originLat * Math.PI / 180)) / 2,
  } : undefined;

  async function submit() {
    if (!location || busy) return;
    setError('');
    setBusy(true);
    setSubmitting(true);
    try {
      const note = packedNote(location, details);
      setDraft(newRequest(location, details));
      await call('submit_help_request', { lat: location.lat, lon: location.lon, headcount: details.headcount,
        needs: details.needs.join(','), note, consentMinutes: CONSENT_MINUTES });
    } catch (e) {
      // A retry after a lost acknowledgement loads the existing subscribed card instead of creating a second call.
      if (mapCallError(e).kind !== 'already_active') setError(errorCopy(e));
    } finally { setBusy(false); setSubmitting(false); }
  }

  async function update(nextLocation: CallerLocation, nextDetails: Details) {
    if (!card) throw new Error('This request is no longer active.');
    await callWithCopy('update_my_request', { requestId: card.requestId, lat: nextLocation.lat, lon: nextLocation.lon,
      headcount: nextDetails.headcount, needs: nextDetails.needs.join(','), note: packedNote(nextLocation, nextDetails) });
  }

  async function close() {
    if (!card || busy) return;
    setBusy(true); setError('');
    try { await callWithCopy('close_my_request', { requestId: card.requestId, externalRef: '', outcome: 'safe' }); }
    catch (e) { setError(errorCopy(e)); }
    finally { setBusy(false); }
  }

  const connectionNotice = !mine || !conn.ready || !conn.canCall ? (
    <StatusNotice title={conn.state === 'offline' ? 'You are offline' : 'Connecting to the rescue queue'}>
      {card ? 'Showing the last confirmed status. Updates will resume when connected.' : 'You can check your location now. Connect before sending your help alert.'}
    </StatusNotice>
  ) : null;

  if (card) {
    const note = unpackNote(card.note);
    const confirmedLocation: CallerLocation = { ...(location && location.lat === card.lat && location.lon === card.lon ? location : coordsPlace(card.lat, card.lon)), entrance: note.entrance };
    const confirmedDetails: Details = { headcount: card.headcount, needs: card.needs.split(',').filter(n => n in NEED_LABELS) as Need[], note: note.note, media: [] };
    const request: HelpRequest = { token: `server:${card.requestId}`, number: String(card.requestId), location: confirmedLocation,
      details: confirmedDetails, phase: card.status === 'en_route' || card.status === 'on_scene' ? 'en_route' : 'assigned',
      createdAt: tsToMs(card.createdAt), receivedAt: tsToMs(card.createdAt), updatedAt: tsToMs(card.updatedAt), arrivalAt: null,
      sharedUntil: tsToMs(card.consentExpiresAt), dispatch: null, locationUpdatedAt: null };
    if (overlay === 'update') return <UpdateLocationScreen request={request} onKeep={() => setOverlay(null)} onSend={async next => { await update(next, confirmedDetails); setCorrected(next); setOverlay(null); }} />;
    return <LiveRequestScreen key={String(card.requestId)} card={card} request={request} connectionNotice={connectionNotice}
      etaMin={card.etaS !== undefined && simS !== undefined ? Math.max(0, Math.ceil((card.etaS - simS) / 60)) : null}
      etaAt={card.etaS !== undefined && liveClock ? simToMs(liveClock, card.etaS) : null}
      busy={busy} canCall={mine && conn.ready && conn.canCall} error={error} onClose={close}
      onMove={() => setOverlay('update')} onUpdate={next => update(confirmedLocation, next)} />;
  }
  if (mine && conn.ready && closed && !busy) return (
    <AppShell><ScreenSection><Heading>{closed.status === 'rescued' ? 'Rescue completed' : closed.status === 'expired' ? 'Location sharing expired' : 'Request closed'}</Heading>
      <Note>Request Q-{String(closed.requestId).padStart(3, '0')} is {closed.status}. Your location is no longer shared.</Note>
    </ScreenSection><ScreenSection secondary><Button variant="primary" onClick={() => { setDismissed(closed.requestId); setDraft(null); setDetails(EMPTY_DETAILS); setOverlay(null); setError(''); }}>Start another request</Button><SafetyNotice /></ScreenSection></AppShell>
  );
  if (overlay === 'correct') return <CorrectLocationScreen position={position} initial={location} incidentCenter={incidentCenter} onConfirm={next => { setCorrected(next); setOverlay(null); setError(''); }} />;
  if (draft && submitting) return <SendingScreen request={draft} live />;
  return <RequestHelpScreen position={position} location={location} corrected={corrected !== null} details={details}
    onDetailsChange={setDetails} onRetryLocate={retry} onAdjustLocation={() => setOverlay('correct')} onSend={submit}
    allowMedia={false} incidentCenter={incidentCenter} sendDisabled={!mine || !conn.ready || !conn.canCall || !grid?.rows || busy}
    notice={<>{connectionNotice}{mine && conn.ready && !grid?.rows && <StatusNotice title="No active incident">An incident must be loaded before sending a help alert.</StatusNotice>}{error && <StatusNotice title="Help alert not confirmed">{error}</StatusNotice>}</>} />;
}

function LiveRequestScreen({ card, request, connectionNotice, etaMin, etaAt, busy, canCall, error, onClose, onMove, onUpdate }: {
  card: Card; request: HelpRequest; connectionNotice: ReactNode; etaMin: number | null; etaAt: number | null;
  busy: boolean; canCall: boolean; error: string; onClose: () => void; onMove: () => void; onUpdate: (details: Details) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(request.details);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const title = { pending: 'Help alert received', queued: 'Waiting for a unit', assigned: 'Unit assigned', en_route: 'Responder en route', on_scene: 'Responder on scene' }[card.status] ?? 'Help alert received';
  return <AppShell>
    <ScreenSection>
      {connectionNotice}
      <div className="intro"><p className="confirmed">✓ RECEIPT CONFIRMED · Q-{String(card.requestId).padStart(3, '0')}</p><Heading>{title}</Heading>
        <Note>Updated {clock(tsToMs(card.updatedAt))}</Note></div>
      <RequestProgress current={card.status === 'en_route' || card.status === 'on_scene' ? 'En route' : card.unitCallsign ? 'Assigned' : 'Received'} />
      <LocationBlock label="Shared location · confirmed by the server" location={request.location} />
      <LiveMap point={request.location} height={160} />
    </ScreenSection>
    <ScreenSection secondary>
      <Panel><p className="panel__title">{card.unitCallsign || 'Awaiting unit assignment'}</p>
        {card.stationName && <Note tone="ink" size={14}>{card.stationName}</Note>}
        {etaMin !== null && <><p className="estimate__value">{etaMin} min</p><Note>Estimated arrival{etaAt !== null ? ` · ${clock(etaAt)}` : ''}. Estimates can change.</Note></>}
        {card.queuePosition > 0 && <Note>Station queue position: {card.queuePosition}</Note>}
        <Note>{card.reason}</Note>
        {!card.unitCallsign && <Note>No unit has been dispatched yet.</Note>}
      </Panel>
      {card.intakeReply && <StatusNotice title="Intake update">{card.intakeReply}</StatusNotice>}
      <Note tone="ink" size={14}>{peopleSummary(request.details)}</Note>
      {request.details.note && <Note>{request.details.note}</Note>}
      {editing ? <div className="details-editor"><OptionalDetailsForm idPrefix="live-details" value={draft} onChange={setDraft} allowMedia={false} />
        {editError && <StatusNotice title="Details not updated">{editError}</StatusNotice>}
        <div className="details-editor__actions"><Button disabled={saving} onClick={() => setEditing(false)}>Cancel</Button>
          <Button variant="primary" disabled={saving || !canCall} onClick={async () => { setSaving(true); setEditError(''); try { await onUpdate(draft); setEditing(false); } catch (e) { setEditError(errorCopy(e)); } finally { setSaving(false); } }}>Share details</Button></div>
      </div> : <Button disabled={!canCall} onClick={() => { setDraft(request.details); setEditing(true); }}>Edit assistance details</Button>}
      <Button disabled={busy || !canCall} onClick={onMove}>My location has changed</Button>
      <Button disabled={busy || !canCall} onClick={onClose}>{busy ? 'Updating…' : 'I’m safe — cancel request'}</Button>
      {error && <StatusNotice title="Request not updated">{error}</StatusNotice>}
      <Note>Location shared until {clock(tsToMs(card.consentExpiresAt))}. Canceling stops sharing.</Note><SafetyNotice />
    </ScreenSection>
  </AppShell>;
}
