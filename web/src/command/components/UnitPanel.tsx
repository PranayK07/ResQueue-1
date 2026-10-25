import { useState } from 'react';
import arrowLeft from '../../assets/figma/command/arrow-left.svg';
import { clockHM, requestCode, simNow, simToMs } from '../../ops/derive';
import type { CommandSource } from '../../ops/sources';
import type { CommandSnapshot, Unit } from '../../ops/types';
import { UNIT_STATUS, peopleNeeds, slackText, unitJourney, type CommandRow } from '../derive';

interface Props {
  snapshot: CommandSnapshot;
  source: CommandSource;
  rows: CommandRow[];
  unitId: number | null;
  nowMs: number;
  onSelectUnit: (unitId: number | null) => void;
  onSelectRequest: (requestId: bigint) => void;
}

/** Units tab: every unit at a glance, or one unit's journey with queue controls. */
export function UnitPanel(props: Props) {
  const { snapshot: s, rows, unitId } = props;
  const unit = unitId === null ? null : s.units.find(u => u.id === unitId) ?? null;
  return unit ? <UnitDetail {...props} unit={unit} /> : <UnitList snapshot={s} rows={rows} nowMs={props.nowMs} onSelectUnit={props.onSelectUnit} />;
}

function etaMin(s: CommandSnapshot, etaS: number, nowMs: number) {
  return Math.max(0, Math.round((etaS - simNow(s.clock, nowMs)) / 60));
}

function UnitList({ snapshot: s, rows, nowMs, onSelectUnit }: Pick<Props, 'snapshot' | 'rows' | 'nowMs' | 'onSelectUnit'>) {
  return (
    <div className="cunits">
      {s.stations.map(st => (
        <div key={st.id} className="cunits__station">
          <p className="clabel mono">{st.name.toUpperCase()}</p>
          {s.units
            .filter(u => u.stationId === st.id)
            .map(u => {
              const { current, stops } = unitJourney(rows, u.id);
              return (
                <button key={u.id} type="button" className="cunit" onClick={() => onSelectUnit(u.id)}>
                  <span className="mono cunit__callsign">{u.callsign}</span>
                  <span className={`cpill cpill--${u.status}`}>{UNIT_STATUS[u.status]}</span>
                  <span className="cunit__now">
                    {current
                      ? `${requestCode(current.request.id)} · ${u.status === 'on_scene' ? 'on scene' : `ETA ${etaMin(s, current.entry.etaS, nowMs)} min`}`
                      : 'No mission'}
                  </span>
                  <span className="cunit__next">
                    {stops.length ? `+${stops.length} planned` : 'Nothing planned'}
                    <span aria-hidden> →</span>
                  </span>
                </button>
              );
            })}
        </div>
      ))}
      <p className="csub cunits__hint">Select a unit to see its route on the map and manage its stops.</p>
    </div>
  );
}

function UnitDetail({ snapshot: s, source, rows, unit, nowMs, onSelectUnit, onSelectRequest }: Props & { unit: Unit }) {
  const { current, stops } = unitJourney(rows, unit.id);
  const station = s.stations.find(st => st.id === unit.stationId)!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  const move = (i: number, delta: number) => {
    const ids = stops.map(r => r.request.id);
    [ids[i], ids[i + delta]] = [ids[i + delta], ids[i]];
    return run(() => source.setUnitOrder(unit.id, ids));
  };

  // Anything not already dispatched can be given to this unit, including
  // escalations (a deliberate ground attempt against the forecast).
  const candidates = rows.filter(r => !r.committed && r.entry.unitId !== unit.id);
  const others = s.units.filter(u => u.id !== unit.id);
  const pinnedHere = rows.some(r => r.request.pinnedUnitId === unit.id && !r.committed);
  const last = stops[stops.length - 1] ?? current;
  const freeAtS = last ? last.entry.etaS + last.request.extractS : simNow(s.clock, nowMs);

  return (
    <div className="cunitdetail">
      <button type="button" className="cback" onClick={() => onSelectUnit(null)}>
        <img src={arrowLeft} width={14} height={14} alt="" />
        All units
      </button>

      <div className="cunitdetail__heading">
        <div>
          <h2 className="mono">
            {unit.callsign} <span>· {station.name}</span>
          </h2>
          <p className="csub">
            {unit.kind[0].toUpperCase() + unit.kind.slice(1)} · {unit.capacity} seats · free after last stop ~{clockHM(simToMs(s.clock, freeAtS))}
          </p>
        </div>
        <span className={`cpill cpill--${unit.status}`}>{UNIT_STATUS[unit.status]}</span>
      </div>

      <a className="cbtn cunitdetail__phone" href={`#/responder/${unit.id}`}>
        Open {unit.callsign} phone view →
      </a>

      <section>
        <p className="clabel mono">CURRENT MISSION</p>
        {current ? (
          <div className="cstop cstop--current">
            <span className="cstop__n mono">▶</span>
            <div className="cstop__body">
              <p>
                <button type="button" className="clinkbtn mono" onClick={() => onSelectRequest(current.request.id)}>
                  {requestCode(current.request.id)}
                </button>{' '}
                {peopleNeeds(current.request)}
              </p>
              <p className="csub">
                {unit.status === 'on_scene' ? 'On scene' : `En route · ETA ${clockHM(simToMs(s.clock, current.entry.etaS))} (${etaMin(s, current.entry.etaS, nowMs)} min)`} · locked
              </p>
            </div>
            <span className={`mono cslack-text cslack-text--${current.request.level}`}>{slackText(current.request.slackS)}</span>
          </div>
        ) : (
          <p className="csub">No mission dispatched. The next planned stop goes out on the next recompute.</p>
        )}
      </section>

      <section>
        <p className="clabel mono">PLANNED STOPS · IN ORDER</p>
        {stops.length === 0 && <p className="csub">Nothing planned for {unit.callsign}.</p>}
        <ol className="cstops">
          {stops.map((r, i) => {
            const level = r.request.level;
            return (
              <li key={String(r.request.id)} className="cstop">
                <span className="cstop__n mono">{i + 1}</span>
                <div className="cstop__body">
                  <p>
                    <button type="button" className="clinkbtn mono" onClick={() => onSelectRequest(r.request.id)}>
                      {requestCode(r.request.id)}
                    </button>{' '}
                    {peopleNeeds(r.request)}
                    {r.request.pinnedUnitId === unit.id && <span className="cbadge cbadge--amber cstop__pin">Assigned</span>}
                  </p>
                  <p className="csub">
                    ETA {clockHM(simToMs(s.clock, r.entry.etaS))} · {r.entry.reason}
                  </p>
                  <div className="cstop__actions">
                    <button type="button" className="cbtn cbtn--small" disabled={busy || i === 0} aria-label={`Move ${requestCode(r.request.id)} earlier`} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="cbtn cbtn--small"
                      disabled={busy || i === stops.length - 1}
                      aria-label={`Move ${requestCode(r.request.id)} later`}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <select
                      className="cbtn cbtn--small"
                      aria-label={`Move ${requestCode(r.request.id)} to another unit`}
                      value=""
                      disabled={busy}
                      onChange={e => e.target.value && run(() => source.assignToUnit(r.request.id, Number(e.target.value)))}
                    >
                      <option value="">Move to unit…</option>
                      {others.map(u => (
                        <option key={u.id} value={u.id}>
                          {u.callsign} · {s.stations.find(st => st.id === u.stationId)!.name.split(' ')[0]}
                        </option>
                      ))}
                    </select>
                    {r.request.pinnedUnitId === unit.id && (
                      <button type="button" className="qlink" disabled={busy} onClick={() => run(() => source.assignToUnit(r.request.id, 0))}>
                        Release
                      </button>
                    )}
                  </div>
                </div>
                <span className={`mono cslack-text cslack-text--${level}`}>{slackText(r.request.slackS)}</span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="cunitdetail__add">
        <label className="clabel mono" htmlFor="unit-add">
          ADD A REQUEST TO {unit.callsign}
        </label>
        <div>
          <select id="unit-add" className="cbtn" value={adding} onChange={e => setAdding(e.target.value)}>
            <option value="">Choose a waiting request…</option>
            {candidates.map(r => (
              <option key={String(r.request.id)} value={String(r.request.id)}>
                {requestCode(r.request.id)} · {slackText(r.request.slackS)} · {r.escalated ? 'escalated' : `${r.station.name.split(' ')[0]} / ${r.unit?.callsign ?? '—'}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="cbtn cbtn--dark"
            disabled={busy || !adding}
            onClick={() =>
              run(async () => {
                await source.assignToUnit(BigInt(adding), unit.id);
                setAdding('');
              })
            }
          >
            Assign
          </button>
        </div>
      </section>

      {error && <p className="cerror">{error}</p>}
      <div className="cunitdetail__footer">
        <p className="csub">Changes apply to the live queue immediately and are logged. Slack is recomputed after each change.</p>
        {pinnedHere && (
          <button type="button" className="qlink" disabled={busy} onClick={() => run(() => source.releaseUnit(unit.id))}>
            Release all manual assignments
          </button>
        )}
      </div>
    </div>
  );
}
