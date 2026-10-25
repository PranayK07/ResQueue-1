import { useState } from 'react';
import { AppShell, ScreenSection, LocationBlock, Note, Panel, RequestProgress, SafetyNotice } from '../components/ui';
import { clock, mediaLabel, ordinal, peopleSummary, ticket, type Details, type HelpRequest } from '../lib/request';
import { useNow } from '../lib/useNow';
import { DetailsEditor, LocationUpdateNote, SharingControls } from './statusParts';
import './screens.css';

interface Props {
  request: HelpRequest;
  onDetailsChange: (d: Details) => void;
  onLocationChanged: () => void;
  onSafe: () => void;
}

/** C05 · Caller · Received and assigned (Figma 71:13428). */
export function AssignedScreen({ request, onDetailsChange, onLocationChanged, onSafe }: Props) {
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const d = request.dispatch!;
  const etaMin = Math.max(1, Math.ceil((request.arrivalAt! - now) / 60_000));
  const { details } = request;

  return (
    <AppShell>
      <ScreenSection>
        <div className="stack-9">
          <p className="confirmed">✓ RECEIPT CONFIRMED · {ticket(request)}</p>
          <h1 className="heading heading--27">
            Unit assigned—
            <br />
            not yet en route
          </h1>
          <Note>
            Updated {clock(request.updatedAt)} · {d.fire}
          </Note>
        </div>

        <RequestProgress current="Assigned" />

        <Panel>
          <div className="estimates">
            <div className="estimate">
              <Note>Estimated arrival</Note>
              <p className="estimate__value">{etaMin} min</p>
              <Note>{clock(request.arrivalAt!)}</Note>
            </div>
            <div className="estimates__divider" />
            <div className="estimate">
              <Note>Station queue</Note>
              <p className="estimate__value">{ordinal(d.queueRank)}</p>
              <Note>{d.station}</Note>
            </div>
          </div>
          <Note>
            {d.unit} busy for {d.busyMin} min, then {d.travelMin} min travel. Estimates may change; arrival is not
            guaranteed.
          </Note>
        </Panel>
      </ScreenSection>
      <ScreenSection secondary>
        <div className="stack-5">
          <LocationBlock label="Confirmed location" location={request.location} />
          <LocationUpdateNote request={request} />
        </div>

        <Note tone="ink" size={13}>
          {d.station} / {d.unit} · {peopleSummary(details)}
        </Note>

        <div className="details-card">
          <button
            type="button"
            className="details-card__toggle"
            aria-expanded={editing}
            onClick={() => setEditing(e => !e)}
          >
            Optional details · Edit / add ＋
          </button>
          {editing ? (
            <DetailsEditor details={details} onSave={onDetailsChange} onClose={() => setEditing(false)} />
          ) : (
            <>
              {details.note && (
                <Note tone="ink" size={13}>
                  {details.note}
                </Note>
              )}
              <Note>
                {details.media.length > 0 && `Media: ${details.media.map(mediaLabel).join(' · ')}. `}
                You can update needs or headcount here.
              </Note>
            </>
          )}
        </div>

        <SharingControls request={request} onLocationChanged={onLocationChanged} onSafe={onSafe} />
        <SafetyNotice />
      </ScreenSection>
    </AppShell>
  );
}
