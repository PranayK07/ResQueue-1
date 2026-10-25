import { MapPinOff } from 'lucide-react';
import { parseNeeds } from '@/lib/domain/needs';
import type { OpsRequestRow } from '@/lib/stdb';
import { minsFromNow } from '@/lib/time/sim';
import { NeedChips } from '@/lib/ui/NeedChips';
import { Stat } from '@/lib/ui/Stat';
import { DrawerSection } from './DrawerSection';

export type RequestDetailsProps = {
  request: Pick<OpsRequestRow, 'note' | 'needs' | 'headcount' | 'slackS' | 'fireEtaS' | 'locationPurged'>;
  /** Sim now in seconds. Undefined until sim_clock arrives. */
  simNow: number | undefined;
};

function slackText(slackS: number | null | undefined): string {
  return slackS == null ? 'Not assessed' : `${Math.round(slackS / 60)} min`;
}

function untilFireText(fireEtaS: number | null | undefined, simNow: number | undefined): string {
  if (fireEtaS == null) return 'Not assessed';
  if (simNow === undefined) return 'Unavailable';
  const mins = minsFromNow(fireEtaS, simNow);
  return mins <= 0 ? 'Arrived' : `${Math.round(mins)} min`;
}

/** The resident's raw note, needs, headcount, slack and minutes until fire. Never shows lat/lon. */
export function RequestDetails({ request, simNow }: RequestDetailsProps) {
  const note = request.note.trim();
  const hasNeeds = parseNeeds(request.needs).length > 0;
  const people = request.headcount === 1 ? 'person' : 'people';

  return (
    <DrawerSection title="Details">
      {note === '' ? (
        <p className="text-sm text-muted-foreground">No note</p>
      ) : (
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">&ldquo;{note}&rdquo;</p>
      )}

      {hasNeeds ? (
        <NeedChips needs={request.needs} />
      ) : (
        <p className="text-sm text-muted-foreground">No needs listed</p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Headcount" value={`${request.headcount} ${people}`} />
        <Stat label="Slack" value={slackText(request.slackS)} />
        <Stat label="Until fire" value={untilFireText(request.fireEtaS, simNow)} />
      </div>

      {request.locationPurged && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <MapPinOff className="size-4 shrink-0" aria-hidden />
          Location deleted
        </p>
      )}
    </DrawerSection>
  );
}
