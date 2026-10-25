import { useRef, useState } from 'react';
import { DEMO_MODE } from '../live/config';
import { AddressField } from '../components/AddressField';
import { LiveMap, type LiveMapApi } from '../components/LiveMap';
import { AppShell, ScreenSection, Button, Heading, Note, SafetyNotice, StatusNotice, TextField } from '../components/ui';
import { INCIDENT_AREA } from '../lib/geo';
import { clock, type CallerLocation } from '../lib/request';
import type { PositionState } from '../lib/useCurrentPosition';
import { usePickedLocation } from '../lib/usePickedLocation';
import './screens.css';

interface Props {
  position: PositionState;
  initial: CallerLocation | null;
  onConfirm: (location: CallerLocation) => void;
}

/** C02 · Caller · Correct location (Figma 71:13318). */
export function CorrectLocationScreen({ position, initial, onConfirm }: Props) {
  const { location, lookingUp, pick, choose, setEntrance } = usePickedLocation(initial);
  const [address, setAddress] = useState(initial?.street ?? '');
  const mapApi = useRef<LiveMapApi>(null);

  const gpsDown = position.status === 'denied' || position.status === 'unavailable';

  async function dropPin(lat: number, lon: number) {
    setAddress('Finding address…');
    const place = await pick(lat, lon);
    setAddress(place.street);
  }

  return (
    <AppShell>
      <ScreenSection>
        <Heading>Correct your location</Heading>

        {gpsDown && (
          <StatusNotice title="⊘ Device GPS unavailable">
            {position.status === 'denied'
              ? 'Location permission is denied. Enter an address without granting GPS access.'
              : 'Your device couldn’t get a GPS fix. Enter an address instead.'}
          </StatusNotice>
        )}

        <AddressField
          value={address}
          onValueChange={setAddress}
          near={location ?? INCIDENT_AREA}
          onChoose={place => {
            choose(place);
            setAddress(place.street);
          }}
        />

        {location?.area && <Note>{location.area}</Note>}

        <LiveMap point={location} height={150} editable onPick={dropPin} apiRef={mapApi} />

        <Button
          onClick={() => {
            const c = mapApi.current?.center();
            if (c) dropPin(c.lat, c.lon);
          }}
        >
          Place entrance pin
        </Button>
      </ScreenSection>
      <ScreenSection secondary>
        <TextField
          id="entrance"
          label="Entrance correction"
          value={location?.entrance ?? ''}
          placeholder="e.g. Front entrance"
          onChange={setEntrance}
          inputProps={{ disabled: !location }}
        />

        <Note>
          {DEMO_MODE ? 'Confirm the address and entrance before sending your alert.' : position.status === 'found'
            ? `GPS fix at ${clock(position.fixedAt)}, accurate to about ±${Math.round(position.accuracyM)} m. Drag the pin to your entrance and confirm the address yourself.`
            : 'Any last-known device location is unconfirmed. GPS accuracy and fix time are unavailable. Confirm the address and entrance yourself.'}
        </Note>

        <div className="stack-10">
          <Button variant="primary" disabled={!location || lookingUp} onClick={() => location && onConfirm(location)}>
            Confirm location on this device
          </Button>
          <Note>Sends no alert. Your correction stays local until you choose Send help alert.</Note>
          <SafetyNotice />
        </div>
      </ScreenSection>
    </AppShell>
  );
}
