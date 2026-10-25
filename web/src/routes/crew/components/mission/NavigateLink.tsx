import { Navigation } from 'lucide-react';
import { Button } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

export type NavigateLinkProps = {
  lat: number;
  lon: number;
  className?: string;
};

/** Hands the request's location to the phone's maps app in a new tab. */
export function NavigateLink({ lat, lon, className }: NavigateLinkProps) {
  const href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  return (
    <Button asChild variant="outline" className={cn('h-auto min-h-12 w-full rounded-card text-sm', className)}>
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Navigation className="size-4" aria-hidden />
        Open in Maps
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </Button>
  );
}
