import { CircleOff } from 'lucide-react';
import { EmptyState } from '@/lib/ui/EmptyState';
import { Panel } from '@/lib/ui/Panel';
import { Call911Link } from './Call911Link';

/** No scenario running (the grid has no rows): requests can't be taken, so the only action is 911. */
export function RequestsClosed() {
  return (
    <Panel>
      <EmptyState
        icon={CircleOff}
        title="Help requests are closed right now."
        action={<Call911Link size="big" className="mt-3" />}
      />
    </Panel>
  );
}
