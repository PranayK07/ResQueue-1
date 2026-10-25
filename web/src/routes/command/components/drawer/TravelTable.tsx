import { Check, X } from 'lucide-react';
import type { OpsTravelRow, StationRow } from '@/lib/stdb';
import { DrawerSection } from './DrawerSection';
import { stationName } from './stationName';

export type TravelTableProps = {
  /** ops_travel rows for this request. */
  travel: readonly OpsTravelRow[];
  stations: readonly StationRow[];
  /** Station whose line the request is in, marked "current". */
  currentStationId?: number;
};

const sortKey = (s: number) => (Number.isFinite(s) ? s : Infinity);

function travelText(travelS: number): string {
  return Number.isFinite(travelS) ? `${Math.round(travelS / 60)} min` : 'No estimate';
}

/** Ground travel time from each station, quickest first, and whether it beats the fire. */
export function TravelTable({ travel, stations, currentStationId }: TravelTableProps) {
  if (travel.length === 0) {
    return (
      <DrawerSection title="Travel by station">
        <p className="text-sm text-muted-foreground">No travel estimates yet.</p>
      </DrawerSection>
    );
  }

  const rows = [...travel].sort((a, b) => sortKey(a.travelS) - sortKey(b.travelS));

  return (
    <DrawerSection title="Travel by station">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th scope="col" className="label-caps pb-1.5 text-left">
              Station
            </th>
            <th scope="col" className="label-caps pb-1.5 text-right">
              Travel
            </th>
            <th scope="col" className="label-caps pb-1.5 pl-4 text-right">
              Reachable
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(row => (
            <tr key={String(row.key)}>
              <td className="py-2 pr-2">
                {stationName(stations, row.stationId)}
                {row.stationId === currentStationId && (
                  <span className="mono-tag ml-2 text-muted-foreground">current</span>
                )}
              </td>
              <td className="py-2 text-right tabular-nums">{travelText(row.travelS)}</td>
              <td className="py-2 pl-4 text-right">
                <span className="inline-flex items-center gap-1">
                  {row.reachable ? (
                    <Check className="size-3.5 text-muted-foreground" aria-hidden />
                  ) : (
                    <X className="size-3.5 text-muted-foreground" aria-hidden />
                  )}
                  {row.reachable ? 'Yes' : 'No'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DrawerSection>
  );
}
