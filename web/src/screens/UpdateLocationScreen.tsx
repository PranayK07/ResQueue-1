import { useState } from 'react';
import { LiveMap } from '../components/LiveMap';
import { AppShell, Button, Eyebrow, Heading, LocationBlock, Note, Panel, SafetyNotice, StatusNotice, TextField } from '../components/ui';
import { ticket, type CallerLocation, type HelpRequest } from '../lib/request';
import { usePickedLocation } from '../lib/usePickedLocation';
import './screens.css';

interface Props {
  request: HelpRequest;
  /** Resolves once the system confirms the update; rejects if it couldn't be sent. */
  onSend: (location: CallerLocation) => Promise<void>;
  onKeep: () => void;
}

/** C07 · Caller · Update shared location (Figma 71:13524). */
export function UpdateLocationScreen({ request, onSend, onKeep }: Props) {
  const shared = request.location;
  const { location, lookingUp, pick, setEntrance } = usePickedLocation(shared);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const moved = !!location && (location.lat !== shared.lat || location.lon !== shared.lon);
  const changed = !!location && (moved || location.entrance !== shared.entrance);

  async function send() {
    if (!location) return;
    setSending(true);
    setFailed(false);
    try {
      await onSend(location);
    } catch {
      setFailed(true);
      setSending(false);
    }
  }

  return (
    <AppShell>
      <Eyebrow>EXISTING REQUEST · {ticket(request)}</Eyebrow>
      <Heading>Update your shared location</Heading>

      <Panel>
        <LocationBlock label="Currently shared · last confirmed" location={shared} />
        <Note>This location remains active until your update is confirmed by the system.</Note>
      </Panel>

      <LiveMap point={location} height={150} editable onPick={(lat, lon) => pick(lat, lon)} />
      {moved && location && (
        <div className="stack-5">
          <Eyebrow>Proposed pin</Eyebrow>
          <Note tone="ink" size={13}>
            {location.street}
            {location.area && ` · ${location.area}`}
          </Note>
        </div>
      )}

      <TextField
        id="proposed-entrance"
        label="Proposed entrance correction"
        value={location?.entrance ?? ''}
        placeholder="e.g. Front entrance at the same address"
        onChange={setEntrance}
      />

      <ol className="states">
        <li className={changed ? 'states__item states__item--current' : 'states__item'}>
          <span aria-hidden>①</span> Device preview · {sending ? 'Sending…' : changed ? 'Local only' : 'No changes yet'}
        </li>
        <li className="states__item">
          <span aria-hidden>②</span> System-shared location · Still the last confirmed address above
        </li>
        <li className="states__item">
          <span aria-hidden>③</span> Crew acknowledgment · No new update sent or acknowledged
        </li>
      </ol>

      {failed ? (
        <StatusNotice title="⊘ Update not sent">
          Your connection was lost. The last confirmed address above is still shared with responders. Try again when
          you’re back online.
        </StatusNotice>
      ) : (
        <StatusNotice title="Same request—not a new help alert">
          Sending shares this {moved ? 'location update' : 'entrance correction'} for {ticket(request)}. System
          confirmation and crew acknowledgment are separate steps.
        </StatusNotice>
      )}

      <Button variant="primary" disabled={!changed || sending || lookingUp} onClick={send}>
        {sending ? 'Sending update…' : 'Send updated location'}
      </Button>
      <Button onClick={onKeep} disabled={sending}>
        Keep current shared location
      </Button>
      <SafetyNotice />
    </AppShell>
  );
}
