import { useState } from 'react';
import { AppShell, Button, Heading, LocationBlock, Note, Panel, RequestProgress, SafetyNotice, StatusNotice } from '../components/ui';
import { clock, failedMedia, mediaLabel, ticket, type Details, type HelpRequest } from '../lib/request';
import { useNow } from '../lib/useNow';
import { DetailsEditor, LocationUpdateNote, SharingControls } from './statusParts';
import './screens.css';

interface Props {
  request: HelpRequest;
  onDetailsChange: (d: Details) => void;
  onRetryMedia: () => void;
  onLocationChanged: () => void;
  onSafe: () => void;
}

/** C06 · Caller · Responder en route (Figma 71:13477). */
export function EnRouteScreen({ request, onDetailsChange, onRetryMedia, onLocationChanged, onSafe }: Props) {
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const d = request.dispatch!;
  const etaMin = Math.max(1, Math.ceil((request.arrivalAt! - now) / 60_000));
  const { details } = request;
  const failed = failedMedia(details);

  return (
    <AppShell>
      <div className="stack-8">
        <p className="eyebrow">
          {ticket(request)} · UPDATED {clock(request.updatedAt)}
        </p>
        <Heading>Responder en route</Heading>
        <Note size={14}>
          {d.station} / {d.unit} · Next stop: you
        </Note>
      </div>

      <RequestProgress current="En route" />

      <Panel>
        <Note size={13}>Estimated arrival</Note>
        <div className="travel">
          <p className="travel__eta">{etaMin} min</p>
          <p className="travel__time">{clock(request.arrivalAt!)}</p>
        </div>
        <Note>Estimate as of {clock(request.updatedAt)}. Arrival is not guaranteed.</Note>
      </Panel>

      <div className="stack-5">
        <LocationBlock label="Confirmed location" location={request.location} />
        <LocationUpdateNote request={request} />
      </div>

      {failed.length > 0 && (
        <StatusNotice title="◷ Alert received—media pending">
          Help continues. Your optional {failed.length === 1 ? failed[0].kind : 'media'} resend failed
          {details.media.some(m => m.status === 'shared') && '; the previously shared files remain available'}. This
          does not affect your alert.
        </StatusNotice>
      )}

      <div className="stack-8">
        {details.media.length > 0 && <p className="media-line">{details.media.map(mediaLabel).join('   /   ')}</p>}
        {failed.length > 0 && (
          <Button onClick={onRetryMedia}>
            Retry optional {failed.length === 1 ? failed[0].kind : 'media'} resend
          </Button>
        )}
        {details.note && (
          <Note tone="ink" size={13}>
            {details.note}
          </Note>
        )}
        {editing ? (
          <div className="details-card">
            <DetailsEditor details={details} onSave={onDetailsChange} onClose={() => setEditing(false)} />
          </div>
        ) : (
          <Button onClick={() => setEditing(true)}>View / edit optional details</Button>
        )}
      </div>

      <SharingControls request={request} onLocationChanged={onLocationChanged} onSafe={onSafe} />
      <SafetyNotice />
    </AppShell>
  );
}
