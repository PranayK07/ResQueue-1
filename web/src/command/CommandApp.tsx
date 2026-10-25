import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { AuditPage } from './AuditPage';
import { OverviewPage } from './OverviewPage';
import { QueuePage } from './QueuePage';
import './command.css';

/** Incident command: #/command (overview), #/command/queue (queue management), #/command/audit (audit log). */
export function CommandApp({ route }: { route: string }) {
  if (route === '/command/queue') return <QueuePage />;
  if (route === '/command/audit') return <AuditPage />;
  return <OverviewPage />;
}
