import { useEffect, useState } from 'react';
import { isLive } from './live/config';
import { LiveCallerApp } from './live/LiveCallerApp';
import { coordsPlace, reverseGeocode, type Place } from './lib/geo';
import {
  CONSENT_MINUTES,
  EMPTY_DETAILS,
  loadRequest,
  newRequest,
  saveRequest,
  type CallerLocation,
  type Details,
  type HelpRequest,
  type MediaStatus,
} from './lib/request';
import {
  DEMO_DISPATCH,
  EN_ROUTE_AFTER_MS,
  sendLocationUpdate,
  submitHelpRequest,
  uploadMedia,
} from './lib/simulatedDispatch';
import { useCurrentPosition } from './lib/useCurrentPosition';
import { AssignedScreen } from './screens/AssignedScreen';
import { CorrectLocationScreen } from './screens/CorrectLocationScreen';
import { EnRouteScreen } from './screens/EnRouteScreen';
import { OfflineScreen } from './screens/OfflineScreen';
import { RequestHelpScreen } from './screens/RequestHelpScreen';
import { SendingScreen } from './screens/SendingScreen';
import { UpdateLocationScreen } from './screens/UpdateLocationScreen';

const MINUTE = 60_000;

/** Resident flow: C01–C07. */
export function CallerApp() {
  return isLive ? <LiveCallerApp /> : <SimulatedCallerApp />;
}

function SimulatedCallerApp() {
  const { position, retry } = useCurrentPosition();
  const [resolved, setResolved] = useState<Place | null>(null);
  const [corrected, setCorrected] = useState<CallerLocation | null>(null);
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const [request, setRequest] = useState<HelpRequest | null>(loadRequest);
  const [overlay, setOverlay] = useState<'correct' | 'update' | null>(null);

  // ─── Detected location → address ───
  const lat = position.status === 'found' ? position.lat : null;
  const lon = position.status === 'found' ? position.lon : null;
  useEffect(() => {
    if (lat === null || lon === null) return;
    const ctrl = new AbortController();
    reverseGeocode(lat, lon, ctrl.signal)
      .catch(() => coordsPlace(lat, lon))
      .then(place => !ctrl.signal.aborted && setResolved(place));
    return () => ctrl.abort();
  }, [lat, lon]);

  let detected: CallerLocation | null = null;
  if (lat !== null && lon !== null) {
    const place =
      resolved?.lat === lat && resolved.lon === lon
        ? resolved
        : { ...coordsPlace(lat, lon), street: 'Finding address…', area: '' };
    detected = { ...place, entrance: '' };
  }
  const location = corrected ?? detected;

  // ─── Request lifecycle (simulated until the backend is wired) ───
  useEffect(() => {
    saveRequest(request);
  }, [request]);

  const phase = request?.phase;
  const token = request?.token;

  // Send (and re-send) under the same token.
  useEffect(() => {
    if (phase !== 'sending' || !token) return;
    let cancelled = false;
    submitHelpRequest(token).then(
      () => {
        if (cancelled) return;
        const now = Date.now();
        setRequest(r =>
          r && {
            ...r,
            phase: 'assigned',
            receivedAt: now,
            updatedAt: now,
            dispatch: DEMO_DISPATCH,
            arrivalAt: now + (DEMO_DISPATCH.busyMin + DEMO_DISPATCH.travelMin) * MINUTE,
            sharedUntil: now + CONSENT_MINUTES * MINUTE,
          }
        );
      },
      () => !cancelled && setRequest(r => r && { ...r, phase: 'offline' })
    );
    return () => {
      cancelled = true;
    };
  }, [phase, token]);

  // The assigned unit finishes its current job and heads over.
  const receivedAt = request?.receivedAt;
  useEffect(() => {
    if (phase !== 'assigned' || !receivedAt) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      setRequest(
        r =>
          r && {
            ...r,
            phase: 'en_route',
            updatedAt: now,
            arrivalAt: now + (r.dispatch?.travelMin ?? 0) * MINUTE,
          }
      );
    }, Math.max(0, receivedAt + EN_ROUTE_AFTER_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [phase, receivedAt]);

  // Optional media uploads after receipt, separate from the alert itself.
  const received = phase === 'assigned' || phase === 'en_route';
  const pendingMedia = request?.details.media.filter(m => m.status === 'local').map(m => m.id) ?? [];
  const pendingKey = pendingMedia.join(',');
  useEffect(() => {
    if (!received || !pendingKey) return;
    const ids = pendingKey.split(',');
    const setStatus = (id: string, status: MediaStatus) =>
      setRequest(r => r && { ...r, details: { ...r.details, media: r.details.media.map(m => (m.id === id ? { ...m, status } : m)) } });
    for (const id of ids) {
      setStatus(id, 'uploading');
      uploadMedia().then(
        () => setStatus(id, 'shared'),
        () => setStatus(id, 'failed')
      );
    }
  }, [received, pendingKey]);

  // New screen → start at the top.
  const screenKey = `${overlay}:${phase}`;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screenKey]);

  // ─── Actions ───
  function cancelRequest() {
    // TODO(backend): close_my_request(requestId, '', 'safe'), which also purges the location.
    setRequest(null);
    setOverlay(null);
    setDetails(EMPTY_DETAILS);
  }

  function updateDetails(next: Details) {
    // TODO(backend): no reducer for editing details yet.
    setRequest(r => r && { ...r, details: next, updatedAt: Date.now() });
  }

  async function sendUpdatedLocation(next: CallerLocation) {
    await sendLocationUpdate();
    const now = Date.now();
    setRequest(r => r && { ...r, location: next, locationUpdatedAt: now, updatedAt: now });
    setOverlay(null);
  }

  // ─── Screens ───
  if (request) {
    if (overlay === 'update') {
      return <UpdateLocationScreen request={request} onSend={sendUpdatedLocation} onKeep={() => setOverlay(null)} />;
    }
    switch (request.phase) {
      case 'sending':
        return <SendingScreen request={request} />;
      case 'offline':
        return <OfflineScreen request={request} onRetry={() => setRequest({ ...request, phase: 'sending' })} />;
      case 'assigned':
        return (
          <AssignedScreen
            request={request}
            onDetailsChange={updateDetails}
            onLocationChanged={() => setOverlay('update')}
            onSafe={cancelRequest}
          />
        );
      case 'en_route':
        return (
          <EnRouteScreen
            request={request}
            onDetailsChange={updateDetails}
            onRetryMedia={() =>
              updateDetails({
                ...request.details,
                media: request.details.media.map(m => (m.status === 'failed' ? { ...m, status: 'local' } : m)),
              })
            }
            onLocationChanged={() => setOverlay('update')}
            onSafe={cancelRequest}
          />
        );
    }
  }

  if (overlay === 'correct') {
    return (
      <CorrectLocationScreen
        position={position}
        initial={location}
        onConfirm={l => {
          setCorrected(l);
          setOverlay(null);
        }}
      />
    );
  }

  return (
    <RequestHelpScreen
      position={position}
      location={location}
      corrected={corrected !== null}
      details={details}
      onDetailsChange={setDetails}
      onRetryLocate={retry}
      onAdjustLocation={() => setOverlay('correct')}
      onSend={() => {
        if (!location) return;
        // TODO(backend): submit_help_request({ lat, lon, headcount, needs, note, consentMinutes: CONSENT_MINUTES }).
        setRequest(newRequest(location, details));
      }}
    />
  );
}
