import { useState } from 'react';
import { OptionalDetailsForm } from '../components/OptionalDetailsForm';
import { Button, Note } from '../components/ui';
import { clock, type Details, type HelpRequest } from '../lib/request';

/** "Location update confirmed · crew not yet acknowledged" line, when relevant. */
export function LocationUpdateNote({ request }: { request: HelpRequest }) {
  if (!request.locationUpdatedAt) return null;
  return <Note>Update confirmed by the system {clock(request.locationUpdatedAt)} · Crew acknowledgment pending</Note>;
}

interface DetailsEditorProps {
  details: Details;
  onSave: (d: Details) => void;
  onClose: () => void;
}

/** Inline editor for optional details after the alert was sent. */
export function DetailsEditor({ details, onSave, onClose }: DetailsEditorProps) {
  const [draft, setDraft] = useState(details);
  return (
    <div className="details-editor">
      <OptionalDetailsForm idPrefix="status" value={draft} onChange={setDraft} />
      <div className="details-editor__actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => {
            onSave(draft);
            onClose();
          }}
        >
          Share details
        </Button>
      </div>
    </div>
  );
}

interface SharingControlsProps {
  request: HelpRequest;
  onLocationChanged: () => void;
  onSafe: () => void;
}

export function SharingControls({ request, onLocationChanged, onSafe }: SharingControlsProps) {
  return (
    <div className="stack-9">
      <Button onClick={onLocationChanged}>My location has changed</Button>
      <Button onClick={onSafe}>I’m safe — cancel request</Button>
      {request.sharedUntil && <Note size={11}>Shared until {clock(request.sharedUntil)}. Canceling stops sharing.</Note>}
      <Note tone="ink" size={13}>
        Follow evacuation orders. Do not wait for help.
      </Note>
    </div>
  );
}
