import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { etaMinutes, formatSlack, needLines, peopleLabel, requestCode, type QueueItem } from '../../ops/derive';
import { DangerLevelTag } from './DangerLevelTag';

interface Props {
  callsign: string;
  stationName: string;
  /** The active mission card, if any. */
  mission: ReactNode;
  myStops: QueueItem[];
  /** Other units' stops at this station (read-only). */
  stationStops: QueueItem[];
  nowS: number;
  /** Stops the crew (or command) has put in a fixed order. */
  pinned: boolean;
  /** Stop whose route is being previewed on the map. */
  previewId: bigint | null;
  onPreview: (item: QueueItem) => void;
  onSaveOrder: (ids: bigint[]) => Promise<void>;
  onResetOrder: () => Promise<void>;
}

/** Drops down from the mission bar; never taller than half the screen. */
export function QueueDropdown(p: Props) {
  const [rearranging, setRearranging] = useState(false);
  const [draft, setDraft] = useState<bigint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(p.myStops.map(s => [s.request.id, s]));
  const order = rearranging ? draft.filter(id => byId.has(id)) : p.myStops.map(s => s.request.id);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setRearranging(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the order.');
    } finally {
      setBusy(false);
    }
  }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = order.slice();
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id);
    setDraft(next);
  };

  return (
    <div className="qdrop-panel" role="region" aria-label={`${p.callsign} queue`}>
      {p.mission ?? <p className="qdrop-panel__empty">No active mission. {p.myStops.length ? 'Your first stop below is dispatched on the next update.' : 'Nothing planned yet.'}</p>}

      <div className="qdrop-panel__section">
        <div className="qdrop-panel__heading">
          <p>
            MY NEXT STOPS · {p.callsign} · {p.myStops.length}
          </p>
          {p.myStops.length > 1 &&
            (rearranging ? (
              <span className="qdrop-panel__edit">
                <button type="button" className="rlink" disabled={busy} onClick={() => setRearranging(false)}>
                  Cancel
                </button>
                <button type="button" className="rchip rchip--primary" disabled={busy} onClick={() => run(() => p.onSaveOrder(order))}>
                  {busy ? 'Saving…' : 'Save order'}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="rchip"
                onClick={() => {
                  setDraft(p.myStops.map(s => s.request.id));
                  setRearranging(true);
                }}
              >
                Rearrange
              </button>
            ))}
        </div>
        {rearranging && <p className="qdrop-panel__hint">Drag ⠿ or use ↑ ↓. Saving fixes this order until you reset it.</p>}
        {p.myStops.length === 0 && <p className="qdrop-panel__empty">No further stops planned for {p.callsign}.</p>}
        <ReorderList ids={order} enabled={rearranging} onMove={move}>
          {(id, i, handle) => {
            const s = byId.get(id)!;
            return (
              <StopRow
                item={s}
                index={i + 2}
                nowS={p.nowS}
                previewing={p.previewId === id}
                onPreview={rearranging ? undefined : () => p.onPreview(s)}
                controls={
                  rearranging && (
                    <span className="stoprow__controls">
                      <button type="button" aria-label={`Move ${requestCode(id)} earlier`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                        ↑
                      </button>
                      <button type="button" aria-label={`Move ${requestCode(id)} later`} disabled={i === order.length - 1} onClick={() => move(i, i + 1)}>
                        ↓
                      </button>
                      {handle}
                    </span>
                  )
                }
              />
            );
          }}
        </ReorderList>
        {p.pinned && !rearranging && (
          <button type="button" className="rlink" disabled={busy} onClick={() => run(p.onResetOrder)}>
            Reset to automatic order
          </button>
        )}
        {error && <p className="mission__error">{error}</p>}
      </div>

      {p.stationStops.length > 0 && (
        <div className="qdrop-panel__section">
          <div className="qdrop-panel__heading">
            <p>
              {p.stationName.toUpperCase()} · OTHER UNITS · {p.stationStops.length}
            </p>
          </div>
          {p.stationStops.map(s => (
            <StopRow key={String(s.request.id)} item={s} nowS={p.nowS} showUnit previewing={p.previewId === s.request.id} onPreview={() => p.onPreview(s)} />
          ))}
        </div>
      )}
    </div>
  );
}

function StopRow({
  item,
  index,
  nowS,
  showUnit,
  previewing,
  onPreview,
  controls,
}: {
  item: QueueItem;
  index?: number;
  nowS: number;
  showUnit?: boolean;
  previewing: boolean;
  onPreview?: () => void;
  controls?: ReactNode;
}) {
  const r = item.request;
  const needs = needLines(r);
  const body = (
    <>
      {index !== undefined && <span className="stoprow__n mono">{index}</span>}
      <span className="stoprow__main">
        <span className="stoprow__top">
          <span className="mono stoprow__code">{requestCode(r.id)}</span>
          <DangerLevelTag level={r.level} />
        </span>
        <span className="stoprow__sub">
          {peopleLabel(r.headcount)}
          {needs.length ? ` · ${needs.join(', ')}` : ''}
        </span>
      </span>
      <span className="stoprow__right">
        <span className={`mono stoprow__slack stoprow__slack--${r.level}`}>{formatSlack(r.slackS)}</span>
        <span className="stoprow__eta">
          ETA {etaMinutes(item.etaS, nowS)} min{showUnit ? ` · ${item.committed ? `${item.unitCallsign} en route` : item.unitCallsign}` : ''}
        </span>
      </span>
    </>
  );
  return (
    <div className={`stoprow${previewing ? ' is-previewing' : ''}`}>
      {onPreview ? (
        <button type="button" className="stoprow__body" onClick={onPreview} aria-label={`Preview route to ${requestCode(r.id)}`}>
          {body}
        </button>
      ) : (
        <div className="stoprow__body">{body}</div>
      )}
      {controls}
    </div>
  );
}

/** Touch-friendly drag reordering: drag the ⠿ handle; rows swap as you pass them. */
function ReorderList({
  ids,
  enabled,
  onMove,
  children,
}: {
  ids: bigint[];
  enabled: boolean;
  onMove: (from: number, to: number) => void;
  children: (id: bigint, index: number, handle: ReactNode) => ReactNode;
}) {
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const drag = useRef<{ index: number; startY: number; h: number } | null>(null);
  const [dragging, setDragging] = useState<{ id: bigint; dy: number } | null>(null);

  const down = (i: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const h = rows.current[i]?.getBoundingClientRect().height ?? 56;
    drag.current = { index: i, startY: e.clientY, h };
    setDragging({ id: ids[i], dy: 0 });
  };
  const moveTo = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    let dy = e.clientY - d.startY;
    if (dy > d.h / 2 && d.index < ids.length - 1) {
      onMove(d.index, d.index + 1);
      d.index++;
      d.startY += d.h;
      dy -= d.h;
    } else if (dy < -d.h / 2 && d.index > 0) {
      onMove(d.index, d.index - 1);
      d.index--;
      d.startY -= d.h;
      dy += d.h;
    }
    setDragging(cur => (cur ? { ...cur, dy } : cur));
  };
  const up = () => {
    drag.current = null;
    setDragging(null);
  };

  return (
    <ol className="reorder">
      {ids.map((id, i) => (
        <li
          key={String(id)}
          ref={node => {
            rows.current[i] = node;
          }}
          className={dragging?.id === id ? 'is-dragging' : ''}
          style={dragging?.id === id ? { transform: `translateY(${dragging.dy}px)` } : undefined}
        >
          {children(
            id,
            i,
            enabled && (
              <button type="button" className="stoprow__grip" aria-label="Drag to reorder" onPointerDown={down(i)} onPointerMove={moveTo} onPointerUp={up} onPointerCancel={up}>
                ⠿
              </button>
            )
          )}
        </li>
      ))}
    </ol>
  );
}
