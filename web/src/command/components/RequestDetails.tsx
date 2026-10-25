import { useState } from 'react';
import arrowRightLeft from '../../assets/figma/command/arrow-right-left.svg';
import flagIcon from '../../assets/figma/command/flag.svg';
import shieldCheck from '../../assets/figma/command/shield-check.svg';
import { clockHM, clockHMTz, requestCode, simToMs } from '../../ops/derive';
import { useAddress } from '../../ops/hooks';
import type { CommandSource } from '../../ops/sources';
import type { CommandSnapshot, FlagKind } from '../../ops/types';
import { pad2, peopleNeedsLong, slackBreakdown, slackText, unitAvailability, type CommandRow } from '../derive';

interface Props {
  row: CommandRow;
  rank: number;
  total: number;
  snapshot: CommandSnapshot;
  source: CommandSource;
  nowMs: number;
  onSelectUnit: (unitId: number) => void;
}

const RESOLUTIONS = ['Air support requested', 'Shelter-in-place guidance sent', 'Reached by phone; self-evacuating', 'Manual ground override'];

/** Figma "Selected request details". (The policy-recommendation box is left out for now.) */
export function RequestDetails({ row, rank, total, snapshot, source, nowMs, onSelectUnit }: Props) {
  const { request: r } = row;
  const place = useAddress(r.id, r.lat, r.lon);
  const level = row.escalated ? 'unreachable' : r.level;
  const breakdown = slackBreakdown(row, snapshot, snapshot.policy.marginS);
  const openFlags = snapshot.flags.filter(f => f.requestId === r.id && !f.resolved);
  const consentLeft = Math.round((r.consentExpiresAtMs - nowMs) / 60000);

  const [mode, setMode] = useState<'none' | 'override' | 'flag'>('none');
  const [stationId, setStationId] = useState<number>(r.pinnedStationId);
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<FlagKind>('escalation');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode('none');
      setNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  const stationName = (id: number) => snapshot.stations.find(s => s.id === id)?.name ?? '—';

  return (
    <aside className="cdetail" aria-label={`Request ${requestCode(r.id)}`}>
      <div className="cdetail__heading">
        <div className="cdetail__identity">
          <h2 className="mono">{requestCode(r.id)}</h2>
          <span className={`cbadge cbadge--${level}`}>{level.toUpperCase()}</span>
        </div>
        <p className="mono cdetail__rank">
          RANK {pad2(rank)} / {total}
        </p>
      </div>

      <div className="cdetail__body">
        <div className="cdetail__consent">
          <img src={shieldCheck} width={16} height={16} alt="" />
          <div>
            <p className="cdetail__consent-title">
              {consentLeft > 0 ? `Consent active · expires ${clockHMTz(r.consentExpiresAtMs)}` : 'Consent expired · location will be deleted'}
            </p>
            <p className="cdetail__consent-sub">Help requested {clockHM(r.createdAtMs)} · location sharing confirmed</p>
          </div>
        </div>

        <div>
          <p className="cdetail__address">{place ? place.street : 'Finding address…'}</p>
          <p className="mono cdetail__coords">
            {r.lat.toFixed(4)}, {r.lon.toFixed(4)} · synthetic location
          </p>
        </div>

        <div className="cdetail__household">
          <div>
            <p className="cdetail__strong">{peopleNeedsLong(r)}</p>
            {r.note && <p className="cdetail__sub">“{r.note}”</p>}
          </div>
          <div>
            <p className="mono cdetail__strong">
              {row.station.name} /{' '}
              {row.escalated || !row.unit ? (
                'Review'
              ) : (
                <button type="button" className="clinkbtn" onClick={() => onSelectUnit(row.unit!.id)}>
                  {row.unit.callsign}
                </button>
              )}
            </p>
            <p className="cdetail__sub">
              {row.escalated ? 'No ground unit committed' : row.committed ? `${row.unit?.status === 'on_scene' ? 'On scene' : 'En route'} to this request` : unitAvailability(row.unit, snapshot, nowMs)}
              {r.pinnedStationId > 0 && ` · pinned to ${stationName(r.pinnedStationId)}`}
            </p>
          </div>
        </div>

        {openFlags.length > 0 && (
          <div className="cdetail__flags">
            {openFlags.map(f => (
              <div key={String(f.id)} className="cdetail__flag">
                <p className="cdetail__strong">
                  {f.kind === 'unreachable' ? 'Escalation · unreachable by ground' : `Flag · ${f.kind}`}
                </p>
                <p className="cdetail__sub">{f.detail}</p>
                {f.recommendation && <p className="cdetail__sub">{f.recommendation}</p>}
                <div className="cdetail__resolve">
                  {RESOLUTIONS.map(res => (
                    <button key={res} type="button" className="cbtn cbtn--small" disabled={busy} onClick={() => run(() => source.resolveFlag(f.id, res))}>
                      {res}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className={`cslack cslack--${level}`}>
          <div className="cslack__top">
            <div>
              <p className="mono cslack__value">{slackText(r.slackS)}</p>
              <p className="cslack__label">Safety-adjusted slack</p>
            </div>
            {!row.escalated && (
              <div className="cslack__eta">
                <p className="mono">
                  ETA {clockHM(simToMs(snapshot.clock, row.entry.etaS))} · {Math.max(0, Math.round((row.entry.etaS - snapshot.clock.simS) / 60))} min
                </p>
                {breakdown && (
                  <p className="cslack__label">
                    Unit wait {breakdown.wait}m + travel {breakdown.travel}m
                  </p>
                )}
              </div>
            )}
          </div>
          {breakdown && (
            <>
              <hr />
              <p className="mono cslack__formula">{row.escalated ? `Best case from any station: ${slackText(r.slackS)}` : breakdown.text}</p>
              <p className="cslack__explain">
                Conservative fire arrival p10 − (unit wait + travel + extraction) − safety margin. Fire p10: {clockHM(breakdown.fireP10Ms)}. Slack is
                the remaining buffer, not the ETA.
              </p>
            </>
          )}
        </div>

        {mode === 'override' && (
          <div className="cform">
            <label className="cform__label" htmlFor="override-station">
              Assign {requestCode(r.id)} to
            </label>
            {row.committed && (
              <p className="cdetail__sub">
                {row.unit?.callsign} is already {row.unit?.status === 'on_scene' ? 'on scene' : 'en route'}. A dispatched mission keeps its unit; this
                assignment applies only if the request returns to the queue.
              </p>
            )}
            <select id="override-station" value={stationId} onChange={e => setStationId(Number(e.target.value))}>
              <option value={0}>Policy decides (unpin)</option>
              {snapshot.stations.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input placeholder="Note for the log (optional)" value={note} onChange={e => setNote(e.target.value)} />
            <div className="cform__actions">
              <button type="button" className="cbtn" onClick={() => setMode('none')} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="cbtn cbtn--dark" disabled={busy} onClick={() => run(() => source.overrideAssignment(r.id, stationId, note))}>
                {busy ? 'Applying…' : 'Apply override'}
              </button>
            </div>
          </div>
        )}
        {mode === 'flag' && (
          <div className="cform">
            <label className="cform__label" htmlFor="flag-kind">
              Flag {requestCode(r.id)} as
            </label>
            <select id="flag-kind" value={kind} onChange={e => setKind(e.target.value as FlagKind)}>
              <option value="escalation">Escalation</option>
              <option value="suspect">Suspect / duplicate</option>
              <option value="unreachable">Unreachable</option>
            </select>
            <input placeholder="Detail (required)" value={note} onChange={e => setNote(e.target.value)} />
            <div className="cform__actions">
              <button type="button" className="cbtn" onClick={() => setMode('none')} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="cbtn cbtn--dark" disabled={busy || !note.trim()} onClick={() => run(() => source.flagRequest(r.id, kind, note.trim()))}>
                {busy ? 'Flagging…' : 'Flag request'}
              </button>
            </div>
          </div>
        )}
        {mode === 'none' && (
          <div className="cdetail__actions">
            <button type="button" className="cbtn cbtn--dark" onClick={() => setMode('override')}>
              <img src={arrowRightLeft} width={14} height={14} alt="" />
              Override assignment
            </button>
            <button type="button" className="cbtn" onClick={() => setMode('flag')}>
              <img src={flagIcon} width={14} height={14} alt="" />
              Flag request
            </button>
            <p className="cdetail__logged">Actions are logged</p>
          </div>
        )}
        {error && <p className="cerror">{error}</p>}
      </div>

    </aside>
  );
}
