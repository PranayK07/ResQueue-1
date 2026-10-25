import { CircleCheck, CircleDot, Flag } from 'lucide-react';
import type { OpsFlagRow } from '@/lib/stdb';
import { DrawerSection } from './DrawerSection';

export type FlagListProps = {
  /** ops_flag rows for this request. */
  flags: readonly OpsFlagRow[];
};

const KIND_LABEL: Record<string, string> = {
  unreachable: 'Unreachable by ground',
  suspect: 'Suspect',
  escalation: 'Escalation',
};

/** Open flags first, then newest first. Compares the bigint micros directly. */
function compareFlags(a: OpsFlagRow, b: OpsFlagRow): number {
  if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
  const am = a.createdAt.microsSinceUnixEpoch;
  const bm = b.createdAt.microsSinceUnixEpoch;
  return am === bm ? 0 : am < bm ? 1 : -1;
}

/** Every flag on the request: kind, detail, recommendation and how it was resolved. */
export function FlagList({ flags }: FlagListProps) {
  if (flags.length === 0) {
    return (
      <DrawerSection title="Flags">
        <p className="text-sm text-muted-foreground">No flags on this request.</p>
      </DrawerSection>
    );
  }

  const sorted = [...flags].sort(compareFlags);

  return (
    <DrawerSection title="Flags">
      <ul className="space-y-2">
        {sorted.map(f => {
          const detail = f.detail.trim();
          const recommendation = f.recommendation.trim();
          const resolution = f.resolution.trim();
          return (
            <li key={String(f.id)} className="space-y-1 rounded-card border border-border bg-surface-2 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Flag className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">{KIND_LABEL[f.kind] ?? f.kind}</span>
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                  {f.resolved ? (
                    <CircleCheck className="size-3.5" aria-hidden />
                  ) : (
                    <CircleDot className="size-3.5" aria-hidden />
                  )}
                  {f.resolved ? 'Resolved' : 'Open'}
                </span>
              </div>
              {detail !== '' && <p className="text-sm leading-relaxed">{detail}</p>}
              {recommendation !== '' && (
                <p className="text-sm text-muted-foreground">Recommendation: {recommendation}</p>
              )}
              {f.resolved && resolution !== '' && (
                <p className="text-xs text-muted-foreground">Resolution: {resolution}</p>
              )}
            </li>
          );
        })}
      </ul>
    </DrawerSection>
  );
}
