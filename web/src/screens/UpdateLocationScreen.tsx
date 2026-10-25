import { useState } from 'react';
import { LiveMap } from '../components/LiveMap';
import { IncidentAreaWarning } from '../components/IncidentAreaWarning';
import { AppShell, ScreenSection, Button, Eyebrow, Heading, LocationBlock, Note, Panel, SafetyNotice, StatusNotice, TextField } from '../components/ui';
import { ticket, type CallerLocation, type HelpRequest } from '../lib/request';
import { usePickedLocation } from '../lib/usePickedLocation';
import { errorCopy } from '../live/errors';
import { defaultIncidentLocation, insideIncidentArea, type IncidentArea } from '../lib/incidentArea';
import './screens.css';

interface Props {
  request: HelpRequest;
  incidentArea?: IncidentArea | null;
  /** Resolves once the system confirms the update; rejects if it couldn't be sent. */
  onSend: (location: CallerLocation) => Promise<void>;
  onKeep: () => void;
}

/** C07 · Caller · Update shared location (Figma 71:13524). */
export function UpdateLocationScreen({ request, incidentArea, onSend, onKeep }: Props) {
  const shared = request.location;
  const { location, lookingUp, pick, choose, setEntrance } = usePickedLocation(shared);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');

  const moved = !!location && (location.lat !== shared.lat || location.lon !== shared.lon);
  const changed = !!location && (moved || location.entrance !== shared.entrance);
  const inside = incidentArea === undefined || (!!location && insideIncidentArea(incidentArea, location));

  async function send() {
    if (!location || !inside) return;
    setSending(true);
    setFailure('');
    try {
      await onSend(location);
    } catch (error) {
      setFailure(errorCopy(error));
      setSending(false);
    }
  }

  return (
    <AppShell>
      <ScreenSection>
        <Eyebrow>EXISTING REQUEST · {ticket(request)}</Eyebrow>
        <Heading>Update your shared location</Heading>

        <Panel>
          <LocationBlock label="Currently shared · last confirmed" location={shared} />
          <Note>This location remains active until your update is confirmed by the system.</Note>
        </Panel>

        <LiveMap point={location} height={150} editable onPick={(lat, lon) => pick(lat, lon)} />
        <IncidentAreaWarning area={incidentArea} point={location} onReturn={() => {
          const point = insideIncidentArea(incidentArea, shared) ? shared : defaultIncidentLocation(incidentArea, []);
          if (point) choose(point);
        }} />
        {moved && location && (
          <div className="stack-5">
            <Eyebrow>Proposed pin</Eyebrow>
            <Note tone="ink" size={13}>
              {location.street}
              {location.area && ` · ${location.area}`}
            </Note>
          </div>
        )}
      </ScreenSection>
      <ScreenSection secondary>
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

        {failure ? (
          <StatusNotice title="⊘ Update not sent">
            {failure} The last confirmed address above is still shared with responders.
          </StatusNotice>
        ) : (
          <StatusNotice title="Same request—not a new help alert">
            Sending shares this {moved ? 'location update' : 'entrance correction'} for {ticket(request)}. System
            confirmation and crew acknowledgment are separate steps.
          </StatusNotice>
        )}

        <Button variant="primary" disabled={!changed || sending || lookingUp || !inside} onClick={send}>
          {sending ? 'Sending update…' : 'Send updated location'}
        </Button>
        <Button onClick={onKeep} disabled={sending}>
          Keep current shared location
        </Button>
        <SafetyNotice />
      </ScreenSection>
    </AppShell>
  );
}
