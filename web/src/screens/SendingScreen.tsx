import pendingIndicator from '../assets/figma/pending-indicator.svg';
import { AppShell, ScreenSection, Heading, LocationBlock, Note, Panel, SafetyNotice, StatusNotice } from '../components/ui';
import { localRef, type HelpRequest } from '../lib/request';
import './screens.css';

/** C03 · Caller · Sending (Figma 71:13368). */
export function SendingScreen({ request }: { request: HelpRequest }) {
  return (
    <AppShell>
      <ScreenSection>
        <div className="submitting" role="status" aria-live="polite">
          <div className="spinner" aria-hidden>
            <img src={pendingIndicator} width={42.6732} height={44} alt="" />
          </div>
          <Heading>Sending your request</Heading>
          <p className="submitting__state">Waiting for confirmation</p>
          <Note size={14}>We haven’t confirmed receipt yet. Keep this page open if you can.</Note>
        </div>

        <Panel>
          <LocationBlock label="Location confirmed on this device" location={request.location} />
          <Note>Local request reference: {localRef(request)}</Note>
        </Panel>
      </ScreenSection>
      <ScreenSection secondary>
        <StatusNotice title="◷ One request, even if we retry">
          Retries use the same local request token. They do not create duplicate help alerts.
        </StatusNotice>

        <Note size={13}>
          Optional photo, video, and description are saved locally. Media uploads will be handled separately and do not
          block the help alert.
        </Note>

        <div className="fallback">
          <Note tone="ink" size={14}>
            Do not wait for this screen in immediate danger.
          </Note>
          <SafetyNotice />
        </div>
      </ScreenSection>
    </AppShell>
  );
}
