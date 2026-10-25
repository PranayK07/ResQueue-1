import { useState } from 'react';
import arrowDown from '../../assets/figma/responder/arrow-down.svg';
import type { QueueItem } from '../../ops/derive';
import { RequestCard } from './RequestCard';

const COLLAPSED_COUNT = 2;

interface Props {
  stationName: string;
  items: QueueItem[];
  active: QueueItem | null;
  /** Request currently routed on the map. */
  focusId: bigint | null;
  nowS: number;
  onOpen: (item: QueueItem) => void;
}

/** Figma "Station queue": this unit's mission, then the rest by least slack. */
export function QueuePane({ stationName, items, active, focusId, nowS, onOpen }: Props) {
  const [showAll, setShowAll] = useState(false);
  const rest = items.filter(i => i !== active);
  const visible = showAll ? rest : rest.slice(0, COLLAPSED_COUNT);
  const hidden = rest.length - visible.length;

  return (
    <section className="queue" aria-label={`${stationName} queue`}>
      <header className="queue__heading">
        <h1>{stationName}</h1>
        <p>
          {items.length} {items.length === 1 ? 'request' : 'requests'}
        </p>
      </header>

      <div className="queue__list">
        {active ? (
          <RequestCard item={active} nowS={nowS} active onMap={focusId === active.request.id} onOpen={() => onOpen(active)} />
        ) : (
          <p className="queue__empty">No active mission. The next request will be assigned automatically.</p>
        )}

        {rest.length > 0 && <p className="queue__rank-label">UP NEXT · SLACK ↑</p>}
        {visible.map(item => (
          <RequestCard key={String(item.request.id)} item={item} nowS={nowS} onOpen={() => onOpen(item)} />
        ))}

        {hidden > 0 && (
          <button type="button" className="queue__more" onClick={() => setShowAll(true)}>
            {hidden} more {hidden === 1 ? 'request' : 'requests'}
            <img src={arrowDown} width={13} height={13} alt="" />
          </button>
        )}
      </div>
    </section>
  );
}
