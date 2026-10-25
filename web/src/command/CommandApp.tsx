import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { OverviewPage } from './OverviewPage';
import { QueuePage } from './QueuePage';
import './command.css';

/** Incident command: #/command (overview) and #/command/queue (queue management). */
export function CommandApp({ route }: { route: string }) {
  return route === '/command/queue' ? <QueuePage /> : <OverviewPage />;
}
