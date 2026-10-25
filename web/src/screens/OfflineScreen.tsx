import { AppShell, Button, Heading, LocationBlock, Note, Panel, SafetyNotice, StatusNotice } from '../components/ui';
import { localRef, type HelpRequest } from '../lib/request';
import './screens.css';

/** C04 · Caller · Not sent / offline (Figma 71:13397). */
export function OfflineScreen({ request, onRetry }: { request: HelpRequest; onRetry: () => void }) {
  return (
    <AppShell>
      <span className="badge badge--danger">⊘ OFFLINE</span>
      <Heading>Unable to confirm your alert</Heading>
      <Note tone="ink" size={16}>
        Your connection was lost. We cannot confirm receipt or that a responder has been assigned.
      </Note>

      <Panel>
        <p className="panel__title">Saved on this device</p>
        <LocationBlock label="Your confirmed address" location={request.location} />
        <Note size={13}>Local reference {localRef(request)} · Location and optional details are saved for retry.</Note>
      </Panel>

      <Button variant="primary" onClick={onRetry}>
        Retry same request
      </Button>
      <Note size={13}>
        Uses the same request token—not a new alert. If the first attempt arrived, retrying won’t create a duplicate.
      </Note>

      <StatusNotice title="Alert confirmation failed">
        This is not just an attachment upload problem. Optional media remains local and will retry separately after alert
        receipt is confirmed.
      </StatusNotice>

      <div className="stack-10">
        <Note tone="ink" size={14}>
          Follow evacuation orders. Do not wait for a connection.
        </Note>
        <SafetyNotice />
      </div>
    </AppShell>
  );
}
