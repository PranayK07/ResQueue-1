import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { LiveGate } from '../live/LiveGate';
import { AuditPage } from './AuditPage';
import { OverviewPage } from './OverviewPage';
import { QueuePage } from './QueuePage';
import './command.css';

/** Incident command: #/command (overview), #/command/queue (queue management), #/command/audit (audit log).
 *  Live, the commander signs in first (claim_operator), so the ops_* views return every request. */
export function CommandApp({ route }: { route: string }) {
  let page = <OverviewPage />;
  if (route === '/command/queue') page = <QueuePage />;
  else if (route === '/command/audit') page = <AuditPage />;
  return (
    <LiveGate surface="command" role="commander" title="Incident command" subtitle="Sign in with the operator passcode.">
      {page}
    </LiveGate>
  );
}
