import { useMemo, useState, type ReactNode } from 'react';
import arrowLeft from '../assets/figma/command/arrow-left.svg';
import arrowUpRight from '../assets/figma/command/arrow-up-right.svg';
import checkCircle from '../assets/figma/command/check-circle2.svg';
import checkIcon from '../assets/figma/command/check1.svg';
import gitPullRequest from '../assets/figma/command/git-pull-request.svg';
import gripActive from '../assets/figma/command/grip-vertical1.svg';
import grip from '../assets/figma/command/grip-vertical.svg';
import historyIcon from '../assets/figma/command/history.svg';
import listRestart from '../assets/figma/command/list-restart.svg';
import mousePointer from '../assets/figma/command/mouse-pointer2.svg';
import plusIcon from '../assets/figma/command/plus.svg';
import refreshIcon from '../assets/figma/command/refresh-cw.svg';
import rotateCcw from '../assets/figma/command/rotate-ccw.svg';
import searchIcon from '../assets/figma/command/search.svg';
import shieldCheck from '../assets/figma/command/shield-check--queue.svg';
import slidersIcon from '../assets/figma/command/sliders-horizontal--queue.svg';
import triangleAlert from '../assets/figma/command/triangle-alert--queue.svg';
import triangleSmall from '../assets/figma/command/triangle-alert1.svg';
import { clockHMSTz, clockHMTz, requestCode } from '../ops/derive';
import { useCommandData } from '../ops/hooks';
import type { PlanPreview } from '../ops/sim/world';
import type { CommandSnapshot, DangerLevel, PlanPolicy, PositionPin } from '../ops/types';
import { useNow } from '../lib/useNow';
import { CommandNav, SafetyFooter } from './components/CommandNav';
import { alertStatus, commandRows, counts, mph, mps, pad2, peopleNeedsLong, slackText, stationShort, type CommandRow } from './derive';

const PAGE = 7;
const DRAFT_KEY = 'wrq.command.draft';
const ME = 'A. LEE';

interface Draft {
  pins: [string, number][]; // requestId, ground position
  policy: PlanPolicy;
  windMph: number;
  windFromDeg: number;
  gustMph: number;
  basis: 'road' | 'straight';
  reason: string;
}

const isCritical = (l: DangerLevel) => l === 'critical' || l === 'unreachable';

/** Algorithm order with pins placed at their positions; everyone else shifts. */
function applyPins(order: bigint[], pins: Map<bigint, number>, firstMovable: number) {
  const fixed = order.slice(0, firstMovable - 1);
  const movable = order.slice(firstMovable - 1).filter(id => !pins.has(id));
  const out: bigint[] = [...fixed];
  const byPos = [...pins.entries()].filter(([id]) => order.includes(id)).sort((a, b) => a[1] - b[1]);
  let pos = firstMovable;
  while (movable.length || byPos.length) {
    const pin = byPos.find(([, p]) => p <= pos);
    if (pin) {
      out.push(pin[0]);
      byPos.splice(byPos.indexOf(pin), 1);
    } else if (movable.length) out.push(movable.shift()!);
    else out.push(byPos.shift()![0]);
    pos++;
  }
  return out;
}

/** Figma 8:1397 "Rescue queue management". */
export function QueuePage() {
  const { snapshot: s, source } = useCommandData();
  const nowMs = useNow(1000);
  const rows = useMemo(() => commandRows(s), [s]);
  const c = counts(s, rows);
  const escalated = rows.filter(r => r.escalated);
  // Draggable queue = waiting requests; dispatched missions are shown apart and can't move.
  const ground = rows.filter(r => !r.escalated && !r.committed);
  const inProgress = rows.filter(r => r.committed);
  const byId = new Map(rows.map(r => [r.request.id, r]));
  const algoOrder = ground.map(r => r.request.id);
  const firstMovable = 1;
  const algoPos = new Map(algoOrder.map((id, i) => [id, i + 1]));
  const algoRank = (id: bigint) => algoPos.get(id) ?? 0;

  // ─── Draft ───
  const defaults = (snap = s): Draft => ({
    pins: snap.pins.map(p => [String(p.requestId), p.position]),
    policy: snap.policy,
    windMph: mph(snap.weather.windSpeedMps),
    windFromDeg: Math.round(snap.weather.windFromDeg),
    gustMph: mph(snap.weather.gustMps),
    basis: 'road',
    reason: '',
  });
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) return JSON.parse(saved) as Draft;
    } catch {
      /* fall through */
    }
    return defaults();
  });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));
  const setPolicy = (patch: Partial<PlanPolicy>) => setDraft(d => ({ ...d, policy: { ...d.policy, ...patch } }));

  const pins = new Map(draft.pins.filter(([id]) => byId.has(BigInt(id)) && !byId.get(BigInt(id))!.committed).map(([id, p]) => [BigInt(id), Math.max(firstMovable, p)]));
  const order = applyPins(algoOrder, pins, firstMovable);
  const draftPos = new Map(order.map((id, i) => [id, i + 1]));

  const livePins = new Map(s.pins.map(p => [p.requestId, p.position]));
  const pinChanges = [...pins.entries()].filter(([id, p]) => livePins.get(id) !== p).length + [...livePins.keys()].filter(id => !pins.has(id)).length;
  const paramChanges = [
    draft.policy.distancePreference.enabled !== s.policy.distancePreference.enabled || draft.policy.distancePreference.weight !== s.policy.distancePreference.weight,
    draft.windMph !== mph(s.weather.windSpeedMps) || draft.windFromDeg !== Math.round(s.weather.windFromDeg),
    draft.policy.includeGusts !== s.policy.includeGusts || draft.policy.includeHumidity !== s.policy.includeHumidity || (draft.policy.includeGusts && draft.gustMph !== mph(s.weather.gustMps)) || (draft.policy.includeHumidity && draft.policy.humidityPct !== s.policy.humidityPct),
    draft.policy.keepPinsOnRerank !== s.policy.keepPinsOnRerank,
  ].filter(Boolean).length;
  const dirty = pinChanges + paramChanges > 0;

  const displaced = order.filter(id => {
    const r = byId.get(id)!;
    return !pins.has(id) && isCritical(r.request.level) && (draftPos.get(id) ?? 0) > (algoPos.get(id) ?? 0);
  });

  // ─── Preview ───
  const weatherInput = { windSpeedMps: mps(draft.windMph), windFromDeg: draft.windFromDeg, gustMps: mps(draft.gustMph) };
  const positionPins: PositionPin[] = [...pins.entries()].map(([requestId, position]) => ({ requestId, position, reason: draft.reason, by: ME, atMs: nowMs }));
  const draftKey = JSON.stringify({ ...draft, reason: '' });
  const [preview, setPreview] = useState<{ key: string; result: PlanPreview } | null>(null);
  const previewFresh = preview?.key === draftKey;
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [ack, setAck] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generatePreview() {
    setBusy('preview');
    setError(null);
    try {
      setPreview({ key: draftKey, result: await source.previewPlan(draft.policy, weatherInput, positionPins) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed.');
    } finally {
      setBusy(null);
    }
  }

  const needsReason = pins.size > 0;
  const needsAck = displaced.length > 0;
  const canApply = dirty && previewFresh && (!needsReason || draft.reason.trim()) && (!needsAck || ack) && !busy;

  async function apply() {
    setBusy('apply');
    setError(null);
    try {
      await source.applyPlan(draft.policy, weatherInput, positionPins, draft.reason.trim());
      localStorage.removeItem(DRAFT_KEY);
      // The live state is now the baseline for the next draft.
      const live = source.getSnapshot();
      setDraft(d => ({ ...defaults(live), basis: d.basis }));
      setApplied(live.lastPlan.atMs);
      setAck(false);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed.');
    } finally {
      setBusy(null);
    }
  }

  // ─── Table: filters, paging, drag and drop ───
  const [stationFilter, setStationFilter] = useState(0);
  const [levelFilter, setLevelFilter] = useState<DangerLevel | ''>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const filtering = !!(stationFilter || levelFilter || search.trim());
  const visibleIds = order.filter(id => {
    const r = byId.get(id)!;
    return (
      (!stationFilter || r.station.id === stationFilter) &&
      (!levelFilter || r.request.level === levelFilter) &&
      (!search.trim() || requestCode(id).toLowerCase().includes(search.trim().toLowerCase()) || r.station.name.toLowerCase().includes(search.trim().toLowerCase()))
    );
  });
  const pages = Math.max(1, Math.ceil(visibleIds.length / PAGE));
  const pageIdx = Math.min(page, pages - 1);
  const pageIds = visibleIds.slice(pageIdx * PAGE, pageIdx * PAGE + PAGE);
  const [dragId, setDragId] = useState<bigint | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  function moveTo(id: bigint, position: number) {
    const p = Math.max(firstMovable, Math.min(order.length, position));
    const next = draft.pins.filter(([x]) => x !== String(id));
    if (p !== algoPos.get(id)) next.push([String(id), p]);
    set({ pins: next });
  }
  const release = (id: bigint) => set({ pins: draft.pins.filter(([x]) => x !== String(id)) });

  const stationsCount = (id: number) => rows.filter(r => r.station.id === id).length;
  const step = !dirty ? 1 : previewFresh ? 3 : 2;

  return (
    <div className="cpage">
      <CommandNav />

      <section className="qheader">
        <div className="qheader__crumbs">
          <a href="#/command">
            <img src={arrowLeft} width={14} height={14} alt="" />
            Incident overview
          </a>
          <span>/</span>
          <span>Rescue queue</span>
          <p className="mono">
            QUEUE {clockHMSTz(s.lastPlan.atMs).split(' ')[0]} · SNAPSHOT {clockHMSTz(s.updatedAtMs)}
          </p>
        </div>
        <div className="qheader__identity">
          <div>
            <h1>
              Rescue queue management {dirty && <span className="cbadge cbadge--amber">UNAPPLIED DRAFT</span>}
            </h1>
            <p className="csub">
              {s.incident.name} · INCIDENT {s.incident.id} · {s.incident.area}
            </p>
          </div>
          <div className="qheader__actions">
            <a className="cbtn" href="#/command/audit">
              <img src={historyIcon} width={14} height={14} alt="" />
              View audit log
            </a>
            <button
              type="button"
              className="cbtn"
              disabled={!dirty}
              onClick={() => {
                localStorage.removeItem(DRAFT_KEY);
                setDraft(defaults());
                setPreview(null);
                setAck(false);
              }}
            >
              <img src={rotateCcw} width={14} height={14} alt="" />
              Discard draft
            </button>
          </div>
        </div>
        <div className="qsummary">
          <p>
            <b className="mono">{c.requests}</b> consented requests · {c.people} people
          </p>
          <p className="tone-red">
            <b className="mono">{pad2(c.escalated)}</b> ground escalation
          </p>
          <p className="tone-red">
            <b className="mono">{pad2(c.critical)}</b> critical
          </p>
          <p className="tone-amber">
            <b className="mono">{pad2(c.high)}</b> high
          </p>
          <p className="muted">
            <b className="mono">{pad2(c.moderate)}</b> moderate
          </p>
          <p className="qsummary__capacity">
            {c.stations} stations · {c.unitsAvailable} / {c.unitsTotal} units ready
          </p>
        </div>
      </section>

      {(dirty || applied) && (
        <div className={`qdraftbar${!dirty ? ' qdraftbar--done' : ''}`}>
          <img src={gitPullRequest} width={16} height={16} alt="" />
          {dirty ? (
            <>
              <strong>
                {pinChanges} manual override{pinChanges === 1 ? '' : 's'} · {paramChanges} proposed parameter change{paramChanges === 1 ? '' : 's'}
              </strong>
              <span>Live queue unchanged. Review safety impacts and generate a preview before applying.</span>
              <span className="qdraftbar__by">DRAFT BY {ME}</span>
            </>
          ) : (
            <>
              <strong>Draft applied {clockHMTz(applied!)}</strong>
              <span>The live queue now follows the new policy. Logged to the audit trail.</span>
            </>
          )}
        </div>
      )}

      <main className="qworkspace">
        <div className="qleft">
          <section className="cpanel">
            <div className="qqueue__heading">
              <h2>
                Rescue queue <span className="cbadge cbadge--muted">{ground.length} waiting · {inProgress.length} in progress</span>
                {pins.size > 0 && <span className="cbadge cbadge--amber">Manual draft</span>}
              </h2>
              <button type="button" className="cbtn" disabled={!pins.size} onClick={() => set({ pins: [] })}>
                <img src={listRestart} width={14} height={14} alt="" />
                Restore algorithm order
              </button>
            </div>

            <div className="qfilters">
              <div className="qfilters__tabs" role="tablist" aria-label="Station">
                <button type="button" role="tab" aria-selected={!stationFilter} className={`cbtn${!stationFilter ? ' is-on' : ''}`} onClick={() => setStationFilter(0)}>
                  All stations · {rows.length}
                </button>
                {s.stations.map(st => (
                  <button
                    key={st.id}
                    type="button"
                    role="tab"
                    aria-selected={stationFilter === st.id}
                    className={`cbtn${stationFilter === st.id ? ' is-on' : ''}`}
                    onClick={() => {
                      setStationFilter(st.id);
                      setPage(0);
                    }}
                  >
                    {stationShort(st.name)} · {stationsCount(st.id)}
                  </button>
                ))}
              </div>
              <label className="qsearch">
                <img src={searchIcon} width={14} height={14} alt="" />
                <input
                  placeholder="Find request ID or station"
                  value={search}
                  onChange={e => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                />
              </label>
              <select className="cbtn" aria-label="Safety level" value={levelFilter} onChange={e => setLevelFilter(e.target.value as DangerLevel | '')}>
                <option value="">All safety levels</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="moderate">Moderate</option>
              </select>
            </div>

            {escalated.map(r => (
              <div key={String(r.request.id)} className="qescalation">
                <img src={triangleAlert} width={19} height={19} alt="" />
                <div>
                  <p className="qescalation__title">
                    {requestCode(r.request.id)} · Unreachable by ground · {slackText(r.request.slackS)} slack
                  </p>
                  <p>
                    {peopleNeedsLong(r.request)} · {stationShort(r.station.name)} review · no ETA · algorithm rank {pad2(rows.indexOf(r) + 1)}
                  </p>
                  <p className="tone-red">Outside the draggable queue. Commander review for alternate support; no ground dispatch.</p>
                </div>
                <a className="cbtn" href="#/command">
                  <img src={arrowUpRight} width={14} height={14} alt="" />
                  Review escalation
                </a>
              </div>
            ))}

            {inProgress.length > 0 && (
              <p className="qinprogress">
                <span className="clabel">IN PROGRESS · LOCKED</span>
                {inProgress.map(r => (
                  <span key={String(r.request.id)} className="mono">
                    {requestCode(r.request.id)} · {r.unit?.callsign} {r.unit?.status === 'on_scene' ? 'on scene' : 'en route'}
                  </span>
                ))}
              </p>
            )}

            <div className="qhint">
              <img src={mousePointer} width={14} height={14} alt="" />
              <p>
                {filtering
                  ? 'Clear filters to reorder: positions are incident-wide.'
                  : 'Drag handles (or focus a handle and press ↑/↓) to reorder ground positions. Displayed slack stays at the snapshot.'}
              </p>
              {pins.size > 0 && (
                <span className="cbadge cbadge--amber">
                  {pins.size} override{pins.size === 1 ? '' : 's'}
                </span>
              )}
            </div>

            <table className="ctable qtable">
              <thead>
                <tr>
                  <th aria-label="Reorder" />
                  <th>DRAFT</th>
                  <th>ALGO #</th>
                  <th>REQUEST / NEEDS</th>
                  <th>STATION / UNIT</th>
                  <th>ETA¹</th>
                  <th>SLACK²</th>
                  <th>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {pageIds.map(id => {
                  const r = byId.get(id)!;
                  const pos = draftPos.get(id)!;
                  const algo = algoPos.get(id)!;
                  const pinned = pins.has(id);
                  const locked = r.committed;
                  const canDrag = !locked && !filtering;
                  return (
                    <Row
                      key={String(id)}
                      row={r}
                      draftPos={pos}
                      algoRank={algoRank(id)}
                      algoPos={algo}
                      pinned={pinned}
                      locked={locked}
                      snapshot={s}
                      canDrag={canDrag}
                      nowS={s.clock.simS}
                      dropBefore={dropAt === pos && dragId !== null && dragId !== id}
                      onDragStart={() => setDragId(id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropAt(null);
                      }}
                      onDragOver={() => canDrag && setDropAt(pos)}
                      onDrop={() => {
                        if (dragId !== null && canDrag) moveTo(dragId, pos);
                        setDragId(null);
                        setDropAt(null);
                      }}
                      onMove={delta => moveTo(id, pos + delta)}
                      onRelease={() => release(id)}
                    />
                  );
                })}
              </tbody>
            </table>

            <div className="cpager cpager--table">
              <p>
                Showing {visibleIds.length ? pageIdx * PAGE + 1 : 0}–{Math.min(visibleIds.length, (pageIdx + 1) * PAGE)} of {visibleIds.length} waiting ground requests · {escalated.length} escalation{escalated.length === 1 ? '' : 's'} above
              </p>
              <div>
                <button type="button" disabled={pageIdx === 0} onClick={() => setPage(pageIdx - 1)}>
                  ← Previous
                </button>
                <span className="mono">
                  {pageIdx + 1} / {pages}
                </span>
                <button type="button" disabled={pageIdx >= pages - 1} onClick={() => setPage(pageIdx + 1)}>
                  Next →
                </button>
              </div>
            </div>
            <div className="qformula">
              <p className="mono">Slack = fire-arrival p10 − (unit wait + travel + extraction) − safety margin</p>
              <p>² &lt;0 unreachable · 0–10m critical · &gt;10–30m high · &gt;30m moderate. ¹ ETA = wait + travel, excluding extraction.</p>
            </div>
          </section>

          <section className="cpanel qapply">
            <div>
              <h2>Apply changes</h2>
              <ol className="qsteps">
                <li className={step > 1 ? 'is-done' : 'is-current'}>{step > 1 && <img src={checkCircle} width={14} height={14} alt="" />}1 Edit draft</li>
                <li aria-hidden>→</li>
                <li className={step === 2 ? 'is-current' : step > 2 ? 'is-done' : ''}>{step > 2 && <img src={checkCircle} width={14} height={14} alt="" />}2 Preview &amp; review</li>
                <li aria-hidden>→</li>
                <li className={step === 3 ? 'is-current' : ''}>3 Apply</li>
              </ol>
            </div>
            <div className="qapply__ack">
              <label className="qcheck">
                <input type="checkbox" checked={ack} disabled={!needsAck} onChange={e => setAck(e.target.checked)} />
                {needsAck ? 'I have reviewed the critical delays and accept responsibility for this manual override.' : 'No critical requests are displaced by this draft.'}
              </label>
              <p>
                Required: fresh ranking preview{needsReason ? ' + commander reason' : ''}
                {needsAck ? ' + safety acknowledgement' : ''}. Applying logs the reason, parameters and overrides.
              </p>
              {error && <p className="cerror">{error}</p>}
            </div>
            <div className="qapply__actions">
              <div>
                <button
                  type="button"
                  className="cbtn"
                  disabled={!dirty}
                  onClick={() => {
                    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
                    setSavedAt(Date.now());
                  }}
                >
                  Save draft
                </button>
                <button type="button" className="cbtn cbtn--dark" disabled={!canApply} onClick={apply}>
                  <img src={checkIcon} width={14} height={14} alt="" />
                  {busy === 'apply' ? 'Applying…' : 'Apply to simulation'}
                </button>
              </div>
              <p>{!dirty ? 'No changes to apply · live queue unchanged' : !previewFresh ? 'Generate a preview to continue' : savedAt ? `Draft saved ${clockHMTz(savedAt)}` : 'Ready to apply'}</p>
            </div>
          </section>

          {pins.size > 0 && (
            <section className="cpanel qreview">
              <div className="qreview__heading">
                <div>
                  <p className="clabel mono">AUDIT DRAFT · NOT COMMITTED</p>
                  <h2>Manual change review</h2>
                </div>
                {displaced.length > 0 && <span className="cbadge cbadge--red">Safety review required</span>}
              </div>
              {displaced.length > 0 && (
                <div className="qwarning">
                  <img src={triangleSmall} width={16} height={16} alt="" />
                  <div>
                    <p className="qwarning__title">
                      {[...pins.keys()].map(requestCode).join(', ')} {pins.size === 1 ? 'moves' : 'move'} ahead of {displaced.length} critical request
                      {displaced.length === 1 ? '' : 's'}.
                    </p>
                    <p>
                      {displaced.map(requestCode).join(', ')} {displaced.length === 1 ? 'moves' : 'each move'} down one or more ground positions. Snapshot
                      slack is unchanged here; generate a preview to model the added wait.
                    </p>
                  </div>
                </div>
              )}
              <div className="qreview__audit">
                <div>
                  <p className="mono">
                    {ME} · {clockHMTz(nowMs)} · {savedAt ? 'SAVED' : 'UNSAVED'}
                  </p>
                  {[...pins.entries()].map(([id, p]) => (
                    <p key={String(id)} className="muted">
                      {requestCode(id)}: ground position {algoPos.get(id)} → {p} · manual pin. Algorithm rank {pad2(algoRank(id))} remains visible.
                    </p>
                  ))}
                </div>
                <label className="qreason">
                  <span>Commander reason · required</span>
                  <input value={draft.reason} placeholder="Why this request goes ahead of the algorithm" onChange={e => set({ reason: e.target.value })} />
                </label>
              </div>
              {displaced.length > 0 && (
                <>
                  <p className="qreview__subhead">Displaced critical requests · current ground position → draft position</p>
                  <div className="qdisplaced">
                    {displaced.map(id => {
                      const r = byId.get(id)!;
                      return (
                        <div key={String(id)}>
                          <p>
                            <span className="mono">{requestCode(id)}</span>
                            <span className="mono tone-red">
                              {algoPos.get(id)} → {draftPos.get(id)}
                            </span>
                          </p>
                          <p className="muted">{slackText(r.request.slackS)} snapshot slack · unchanged</p>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          )}
        </div>

        <div className="qright">
          <section className="cpanel qparams">
            <div className="qparams__heading">
              <h2>
                <img src={slidersIcon} width={16} height={16} alt="" />
                Sorting parameters
              </h2>
              <span className="cbadge cbadge--amber">SIMULATED</span>
            </div>
            <p className="qparams__intro">Draft a policy, preview it, then apply. Nothing changes until you apply.</p>
            <p className="qparams__baseline">
              <img src={shieldCheck} width={14} height={14} alt="" />
              Always: least slack first · unreachable requests go to escalation · {Math.round(draft.policy.marginS / 60)}-min safety margin
            </p>

            <div className="qrows">
              <ParamRow
                label="Prefer farther locations"
                hint="Only breaks ties within the same safety band"
                changed={draft.policy.distancePreference.enabled !== s.policy.distancePreference.enabled || draft.policy.distancePreference.weight !== s.policy.distancePreference.weight}
              >
                <Switch
                  label="Prefer farther locations"
                  checked={draft.policy.distancePreference.enabled}
                  onChange={on => setPolicy({ distancePreference: { enabled: on, weight: on ? Math.max(draft.policy.distancePreference.weight, 0.25) : 0 } })}
                />
              </ParamRow>
              {draft.policy.distancePreference.enabled && (
                <div className="qrow__more">
                  <label className="qslider">
                    <span>Weight</span>
                    <input
                      type="range"
                      min={5}
                      max={100}
                      step={5}
                      value={Math.round(draft.policy.distancePreference.weight * 100)}
                      onChange={e => setPolicy({ distancePreference: { enabled: true, weight: Number(e.target.value) / 100 } })}
                    />
                    <span className="mono">{Math.round(draft.policy.distancePreference.weight * 100)}%</span>
                  </label>
                  <select className="qselect" aria-label="Distance measured as" value={draft.basis} onChange={e => set({ basis: e.target.value as Draft['basis'] })}>
                    <option value="road">Road distance from assigned station</option>
                    <option value="straight">Straight-line distance from station</option>
                  </select>
                </div>
              )}

              <p className="qrows__group">Fire forecast inputs</p>
              <ParamRow
                label="Wind"
                hint={`Now ${mph(s.weather.windSpeedMps)} mph from ${Math.round(s.weather.windFromDeg)}°`}
                changed={draft.windMph !== mph(s.weather.windSpeedMps) || draft.windFromDeg !== Math.round(s.weather.windFromDeg)}
              >
                <InlineNumber label="Wind speed" value={draft.windMph} unit="mph" min={0} max={80} onChange={v => set({ windMph: v })} />
                <InlineNumber label="Wind from" value={draft.windFromDeg} unit="° from" min={0} max={359} onChange={v => set({ windFromDeg: v })} />
              </ParamRow>
              <ParamRow label="Gusts" changed={draft.policy.includeGusts !== s.policy.includeGusts || (draft.policy.includeGusts && draft.gustMph !== mph(s.weather.gustMps))}>
                {draft.policy.includeGusts && <InlineNumber label="Peak gust" value={draft.gustMph} unit="mph" min={0} max={100} onChange={v => set({ gustMph: v })} />}
                <Switch label="Include gusts" checked={draft.policy.includeGusts} onChange={on => setPolicy({ includeGusts: on })} />
              </ParamRow>
              <ParamRow label="Humidity" changed={draft.policy.includeHumidity !== s.policy.includeHumidity || (draft.policy.includeHumidity && draft.policy.humidityPct !== s.policy.humidityPct)}>
                {draft.policy.includeHumidity && (
                  <InlineNumber label="Relative humidity" value={draft.policy.humidityPct} unit="%" min={0} max={100} onChange={v => setPolicy({ humidityPct: v })} />
                )}
                <Switch label="Include humidity" checked={draft.policy.includeHumidity} onChange={on => setPolicy({ includeHumidity: on })} />
              </ParamRow>

              <p className="qrows__group">When the queue reranks</p>
              <ParamRow label="Manual overrides" hint={pins.size ? `${pins.size} pinned in this draft` : undefined} changed={draft.policy.keepPinsOnRerank !== s.policy.keepPinsOnRerank}>
                <span className="qseg" role="group" aria-label="Manual overrides on rerank">
                  <button type="button" aria-pressed={draft.policy.keepPinsOnRerank} className={draft.policy.keepPinsOnRerank ? 'is-on' : ''} onClick={() => setPolicy({ keepPinsOnRerank: true })}>
                    Keep
                  </button>
                  <button type="button" aria-pressed={!draft.policy.keepPinsOnRerank} className={!draft.policy.keepPinsOnRerank ? 'is-on' : ''} onClick={() => setPolicy({ keepPinsOnRerank: false })}>
                    Release
                  </button>
                </span>
              </ParamRow>
            </div>

            <p className="qparams__foot">Weather changes the fire-arrival forecast; slack is then recomputed. Inputs are synthetic, not a live forecast.</p>
            <div className="qparams__actions">
              <button
                type="button"
                className="qlink"
                onClick={() =>
                  setDraft(d => ({ ...d, policy: { ...s.policy, distancePreference: { enabled: false, weight: 0 }, includeGusts: false, includeHumidity: false, humidityPct: 25, keepPinsOnRerank: true }, windMph: mph(s.weather.windSpeedMps), windFromDeg: Math.round(s.weather.windFromDeg), gustMph: mph(s.weather.gustMps) }))
                }
              >
                Reset to defaults
              </button>
              <button type="button" className="cbtn cbtn--dark" disabled={!dirty || busy !== null} onClick={generatePreview}>
                <img src={refreshIcon} width={14} height={14} alt="" />
                {busy === 'preview' ? 'Generating…' : 'Generate ranking preview'}
              </button>
            </div>
          </section>

          <PreviewCard
            snapshotRows={rows}
            draft={draft}
            pins={pins}
            algoPos={algoPos}
            preview={previewFresh ? preview!.result : null}
            stale={!!preview && !previewFresh}
            current={{
              distance: s.policy.distancePreference,
              windMph: mph(s.weather.windSpeedMps),
              gustMph: mph(s.weather.gustMps),
              includeGusts: s.policy.includeGusts,
              includeHumidity: s.policy.includeHumidity,
              humidityPct: s.policy.humidityPct,
            }}
          />
        </div>
      </main>

      <SafetyFooter snapshotLabel={`SNAPSHOT ${clockHMSTz(s.updatedAtMs)}`} />
    </div>
  );
}

interface RowProps {
  row: CommandRow;
  draftPos: number;
  algoRank: number;
  algoPos: number;
  pinned: boolean;
  locked: boolean;
  snapshot: CommandSnapshot;
  canDrag: boolean;
  nowS: number;
  dropBefore: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onMove: (delta: number) => void;
  onRelease: () => void;
}

function Row(p: RowProps) {
  const { row: r, draftPos, algoPos, pinned, locked } = p;
  const level = r.request.level;
  const shift = draftPos - algoPos;
  const status = alertStatus(r, p.snapshot);
  return (
    <>
      {p.dropBefore && (
        <tr className="qdrop">
          <td colSpan={8}>
            <img src={plusIcon} width={12} height={12} alt="" />
            Drop here to insert at ground position {pad2(draftPos)} <span>Draft only · remaining tickets shift down</span>
          </td>
        </tr>
      )}
      <tr
        className={`${pinned ? 'is-pinned' : ''}${locked ? ' is-locked' : ''}`}
        draggable={p.canDrag}
        onDragStart={e => {
          e.dataTransfer.effectAllowed = 'move';
          p.onDragStart();
        }}
        onDragEnd={p.onDragEnd}
        onDragOver={e => {
          if (!p.canDrag) return;
          e.preventDefault();
          p.onDragOver();
        }}
        onDrop={e => {
          e.preventDefault();
          p.onDrop();
        }}
      >
        <td>
          {locked ? (
            <span className="qlock" title="Unit committed; position locked">
              ●
            </span>
          ) : (
            <button
              type="button"
              className="qgrip"
              disabled={!p.canDrag}
              aria-label={`Move ${requestCode(r.request.id)} (position ${draftPos}); use arrow keys`}
              onKeyDown={e => {
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  p.onMove(-1);
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  p.onMove(1);
                }
              }}
            >
              <img src={pinned ? gripActive : grip} width={16} height={16} alt="" />
            </button>
          )}
        </td>
        <td className="mono qtable__pos">{pad2(draftPos)}</td>
        <td className="mono muted">{pad2(p.algoRank)}</td>
        <td>
          <p>
            <strong className="mono">{requestCode(r.request.id)}</strong> {peopleNeedsLong(r.request)}
          </p>
          <p className="muted">{r.entry.reason}</p>
        </td>
        <td className="mono">
          {stationShort(r.station.name)} / {r.unit?.callsign ?? '—'}
        </td>
        <td className="mono">{Math.max(0, Math.round((r.entry.etaS - p.nowS) / 60))} min</td>
        <td>
          <p className={`mono cslack-text cslack-text--${level}`}>{slackText(r.request.slackS)}</p>
          <p className={`qlevel qlevel--${level}`}>{level.toUpperCase()}</p>
        </td>
        <td>
          <span className="cstatus">
            <span className={`cstatus__pill cstatus__pill--${pinned ? 'amber' : status.tone}`}>{pinned ? 'Manual pin' : status.label}</span>
            {status.flagged && <span className="cstatus__pill cstatus__pill--red">Flagged</span>}
          </span>
          {pinned ? (
            <p className="qchange">
              <span className="mono tone-amber">
                {algoPos} → {draftPos}
              </span>{' '}
              ·{' '}
              <button type="button" className="qlink" onClick={p.onRelease}>
                Release
              </button>
            </p>
          ) : shift !== 0 && !locked ? (
            <p className={`qchange ${shift > 0 ? 'tone-red' : 'tone-green'}`}>
              {shift > 0 ? '↓' : '↑'} {Math.abs(shift)} position{Math.abs(shift) === 1 ? '' : 's'} in draft
            </p>
          ) : null}
        </td>
      </tr>
    </>
  );
}

function ParamRow({ label, hint, changed, children }: { label: string; hint?: string; changed?: boolean; children: ReactNode }) {
  return (
    <div className={`qrow${changed ? ' is-changed' : ''}`}>
      <div className="qrow__label">
        <p>
          {label}
          {changed && <span className="qrow__dot" title="Changed in this draft" />}
        </p>
        {hint && <p className="qrow__hint">{hint}</p>}
      </div>
      <div className="qrow__control">{children}</div>
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`qswitch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function InlineNumber(props: { label: string; unit: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="qnum">
      <input
        type="number"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={e => props.onChange(Math.min(props.max, Math.max(props.min, Number(e.target.value) || 0)))}
      />
      <span>{props.unit}</span>
    </label>
  );
}

interface PreviewProps {
  snapshotRows: CommandRow[];
  draft: Draft;
  pins: Map<bigint, number>;
  algoPos: Map<bigint, number>;
  preview: PlanPreview | null;
  stale: boolean;
  current: { distance: PlanPolicy['distancePreference']; windMph: number; gustMph: number; includeGusts: boolean; includeHumidity: boolean; humidityPct: number };
}

function PreviewCard({ snapshotRows, draft, pins, algoPos, preview, stale, current }: PreviewProps) {
  const pct = (d: PlanPolicy['distancePreference']) => (d.enabled ? `On · ${Math.round(d.weight * 100)}%` : 'Off · 0%');
  const gh = (g: boolean, h: boolean, gust: number, rh: number) => (!g && !h ? 'Not included' : `${g ? `${gust} mph` : '—'} / ${h ? `${rh}%` : '—'}`);
  const params: [string, string, string][] = [
    ['Distance preference', pct(current.distance), pct(draft.policy.distancePreference)],
    ['Wind speed', `${current.windMph} mph`, `${draft.windMph} mph`],
    ['Gust / humidity', gh(current.includeGusts, current.includeHumidity, current.gustMph, current.humidityPct), gh(draft.policy.includeGusts, draft.policy.includeHumidity, draft.gustMph, draft.policy.humidityPct)],
    ...[...pins.entries()].map(([id, p]): [string, string, string] => [`${requestCode(id)} ground position`, `${algoPos.get(id)} · automatic`, `${p} · manual pin`]),
  ];

  const level = (l: string, rows: { level: string }[]) => rows.filter(r => r.level === l).length;
  const now = snapshotRows.map(r => ({ level: r.escalated ? 'escalated' : r.request.level }));
  let after: { level: string }[] = [];
  let moved: { id: bigint; from: number; to: number; slackBefore: number | null; slackAfter: number | null }[] = [];
  if (preview) {
    after = preview.queue.map(q => ({ level: q.position === 0 ? 'escalated' : (preview.requests.find(r => r.id === q.requestId)?.level ?? 'unknown') }));
    const dispatched = new Set(snapshotRows.filter(r => r.committed).map(r => r.request.id));
    const waitingOrder = preview.queue.filter(q => q.position > 0 && !dispatched.has(q.requestId)).sort((a, b) => a.position - b.position);
    const pos = new Map(waitingOrder.map((q, i) => [q.requestId, i + 1]));
    moved = snapshotRows
      .filter(r => !r.escalated && !r.committed)
      .map(r => ({
        id: r.request.id,
        from: algoPos.get(r.request.id) ?? 0,
        to: pos.get(r.request.id) ?? 0,
        slackBefore: r.request.slackS,
        slackAfter: preview.requests.find(x => x.id === r.request.id)?.slackS ?? null,
      }))
      .filter(m => m.from !== m.to)
      .sort((a, b) => a.to - b.to)
      .slice(0, 6);
  }

  return (
    <section className="cpanel qpreview">
      <div className="qpreview__heading">
        <div>
          <p className="clabel mono">CONFIGURATION PREVIEW</p>
          <h2>Proposed vs current</h2>
        </div>
        <span className={`cbadge ${preview ? 'cbadge--green' : 'cbadge--amber'}`}>{preview ? 'Preview ready' : stale ? 'Preview out of date' : 'Ranking preview needed'}</span>
      </div>
      <table className="qcompare">
        <thead>
          <tr>
            <th>PARAMETER</th>
            <th>CURRENT</th>
            <th>PROPOSED DRAFT</th>
          </tr>
        </thead>
        <tbody>
          {params.map(([name, cur, next]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="mono muted">{cur}</td>
              <td className={`mono${cur !== next ? ' tone-amber' : ' muted'}`}>{next}</td>
            </tr>
          ))}
          {preview && (
            <>
              <tr>
                <td>Escalated (unreachable)</td>
                <td className="mono muted">{level('escalated', now)}</td>
                <td className="mono">{level('escalated', after)}</td>
              </tr>
              <tr>
                <td>Critical in ground queue</td>
                <td className="mono muted">{level('critical', now) + level('unreachable', now)}</td>
                <td className="mono">{level('critical', after) + level('unreachable', after)}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
      {preview ? (
        moved.length ? (
          <div className="qmoves">
            <p className="clabel">LARGEST POSITION CHANGES</p>
            {moved.map(m => (
              <p key={String(m.id)}>
                <span className="mono">{requestCode(m.id)}</span>
                <span className="mono">
                  {m.from} → {m.to || 'escalated'}
                </span>
                <span className="mono muted">
                  {slackText(m.slackBefore)} → {slackText(m.slackAfter)}
                </span>
              </p>
            ))}
          </div>
        ) : (
          <p className="csub">Same ground order as the live queue; only slack values change.</p>
        )
      ) : (
        <p className="csub">Order, fire-arrival p10 and proposed slack are not computed yet. Generate a preview to compare them with the live snapshot before applying.</p>
      )}
    </section>
  );
}
