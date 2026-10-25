import { Hammer } from 'lucide-react';
import { APP_NAME } from '@/lib/app';
import { EmptyState } from '@/lib/ui/EmptyState';

/** Stand-in until the screen's build phase replaces it. */
export function PendingScreen({ route }: { route: string }) {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <EmptyState icon={Hammer} title={`${APP_NAME} ${route}`} body="This screen is being built." />
    </main>
  );
}
