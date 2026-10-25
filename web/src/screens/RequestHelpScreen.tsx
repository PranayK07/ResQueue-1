import { useState } from 'react';
import { LiveMap } from '../components/LiveMap';
import { OptionalDetailsForm } from '../components/OptionalDetailsForm';
import { AppShell, Button, Heading, LocationBlock, Note, SafetyNotice } from '../components/ui';
import type { CallerLocation, Details } from '../lib/request';
import type { PositionState } from '../lib/useCurrentPosition';
import './screens.css';

interface Props {
  position: PositionState;
  location: CallerLocation | null;
  /** True once the caller confirmed a corrected location. */
  corrected: boolean;
  details: Details;
  onDetailsChange: (d: Details) => void;
  onRetryLocate: () => void;
  onAdjustLocation: () => void;
  onSend: () => void;
}

/** C01 · Caller · Request help (Figma 71:13275). */
export function RequestHelpScreen(props: Props) {
  const { position, location, corrected, details, onDetailsChange, onRetryLocate, onAdjustLocation, onSend } = props;
  // Reopen when coming back from Adjust location with details already entered.
  const [detailsOpen, setDetailsOpen] = useState(
    () => details.note !== '' || details.needs.length > 0 || details.media.length > 0 || details.headcount !== 1
  );
  const failed = !location && (position.status === 'denied' || position.status === 'unavailable');

  const shown: CallerLocation = location ?? {
    lat: 0,
    lon: 0,
    houseNumber: '',
    entrance: '',
    street: failed ? 'Location not available' : 'Finding your location…',
    area: failed ? 'Use Adjust location to enter an address.' : 'Allow location access if your browser asks.',
  };

  return (
    <AppShell>
      <div className="intro">
        <Heading>Where do you need help?</Heading>
        <Note size={14}>Check your location before sending.</Note>
      </div>

      <div aria-live="polite">
        <LocationBlock label={`${corrected ? 'Corrected location' : 'Current location'} · local preview`} location={shown} />
      </div>

      <LiveMap point={location} height={160}>
        {!location &&
          (failed ? (
            <>
              {position.message}
              <Button className="map-retry" onClick={onRetryLocate}>
                Try again
              </Button>
            </>
          ) : (
            'Finding your location…'
          ))}
      </LiveMap>

      <Button onClick={onAdjustLocation}>Adjust location</Button>

      <Note>▣ Only on this device · Not yet shared</Note>

      <div className="disclosure">
        <button
          type="button"
          className="disclosure__toggle"
          aria-expanded={detailsOpen}
          aria-controls="optional-details"
          onClick={() => setDetailsOpen(o => !o)}
        >
          <span>Add optional details</span>
          <span className="disclosure__icon" aria-hidden>
            {detailsOpen ? '－' : '＋'}
          </span>
        </button>
        {detailsOpen && (
          <div id="optional-details" className="disclosure__body">
            <OptionalDetailsForm idPrefix="request" value={details} onChange={onDetailsChange} />
          </div>
        )}
      </div>

      <div className="stack-12">
        <Note>
          By sending, you agree to share this location and any optional details with responders. Nothing is shared
          before you send.
        </Note>
        <Button variant="primary" disabled={!location} onClick={onSend}>
          Send help alert
        </Button>
        <SafetyNotice />
      </div>
    </AppShell>
  );
}
