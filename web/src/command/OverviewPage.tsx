import { useEffect, useMemo, useState } from 'react';
import layersIcon from '../assets/figma/command/layers.svg';
import pauseIcon from '../assets/figma/command/pause.svg';
import scanIcon from '../assets/figma/command/scan.svg';
import slidersIcon from '../assets/figma/command/sliders-horizontal.svg';
import triangleAlert from '../assets/figma/command/triangle-alert.svg';
import { clockHMSTz, clockHMTz, requestCode, simNow } from '../ops/derive';
import { useCommandData } from '../ops/hooks';
import { fetchRoute, type Route } from '../ops/routing';
import { useNow } from '../lib/useNow';
import { CommandMap, type Journey } from './components/CommandMap';
import { LAYERS, type LayerName } from './mapLayers';
import { CommandNav, SafetyFooter } from './components/CommandNav';
import { RequestDetails } from './components/RequestDetails';
import { UnitPanel } from './components/UnitPanel';
import { bySlack, compass, commandRows, counts, mph, mps, pad2, peopleNeeds, slackText, tPlus, unitJourney } from './derive';

const PAGE = 8;
const clockHMS = (ms: number) => clockHMSTz(ms).split(' ')[0];

/** Figma 3:3691 "Wildfire rescue command". */
export function OverviewPage() {
  const { snapshot: s, source } = useCommandData();
  const nowMs = useNow(1000);
  const rows = useMemo(() => bySlack(commandRows(s)), [s]);
  const c = counts(s, rows);

  // ─── Queue table state ───
  const [stationFilter, setStationFilter] = useState(0);
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [page, setPage] = useState(0);
  const filtered = rows.filter(
    r =>
      (!stationFilter || r.station.id === stationFilter) &&
      (!search.trim() || requestCode(r.request.id).toLowerCase().includes(search.trim().toLowerCase()) || r.station.name.toLowerCase().includes(search.trim().toLowerCase()))
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const pageIdx = Math.min(page, pages - 1);
  const pageRows = filtered.slice(pageIdx * PAGE, pageIdx * PAGE + PAGE);

  // ─── Selection: a request, or (Units tab) a unit and its journey ───
  const [tab, setTab] = useState<'request' | 'units'>('request');
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const [unitId, setUnitId] = useState<number | null>(null);
  const selected = rows.find(r => r.request.id === selectedId) ?? rows.find(r => !r.escalated) ?? rows[0] ?? null;
  const select = (id: bigint) => {
    setSelectedId(id);
    setTab('request');
  };
  const selectUnit = (id: number | null) => {
    setUnitId(id);
    setTab('units');
  };

  // Road legs for the selected unit's journey: unit → current mission → planned stops.
  const unit = tab === 'units' && unitId !== null ? (s.units.find(u => u.id === unitId) ?? null) : null;
  const stops = useMemo(() => {
    if (!unit) return [];
    const plan = unitJourney(rows, unit.id);
    return [...(plan.current ? [{ row: plan.current, current: true }] : []), ...plan.stops.map(row => ({ row, current: false }))].slice(0, 8);
  }, [unit, rows]);
  const legKey = unit ? [[unit.lon, unit.lat], ...stops.map(({ row }) => [row.request.lon, row.request.lat])].map(p => p.join(',')).join(';') : '';
  const [legs, setLegs] = useState<{ key: string; legs: [number, number][][] } | null>(null);
  useEffect(() => {
    if (!legKey) return;
    let live = true;
    const pts = legKey.split(';').map(p => p.split(',').map(Number) as [number, number]);
    Promise.all(pts.slice(1).map((p, i) => fetchRoute(pts[i], p))).then(rs => live && setLegs({ key: legKey, legs: rs.map(r => r.coords) }));
    return () => {
      live = false;
    };
  }, [legKey]);
  const journeyLegs = legs?.key === legKey ? legs.legs : null;
  const journey = useMemo<Journey | null>(() => (unit ? { unit, stops, legs: journeyLegs } : null), [unit, stops, journeyLegs]);
  const escalations = s.flags.filter(f => !f.resolved && f.kind === 'unreachable' && rows.some(r => r.request.id === f.requestId));

  // ─── Route for the selected request ───
  const [route, setRoute] = useState<{ key: string; route: Route } | null>(null);
  const routeKey = selected?.unit && !selected.escalated ? [selected.unit.lon, selected.unit.lat, selected.request.lon, selected.request.lat].join(',') : '';
  useEffect(() => {
    if (!routeKey) return;
    let live = true;
    const [a, b, cc, d] = routeKey.split(',').map(Number);
    fetchRoute([a, b], [cc, d]).then(r => live && setRoute({ key: routeKey, route: r }));
    return () => {
      live = false;
    };
  }, [routeKey]);

  // ─── Map + wind controls ───
  const [visible, setVisible] = useState<Set<LayerName>>(() => new Set(LAYERS));
  const [layersOpen, setLayersOpen] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [windDir, setWindDir] = useState<number | null>(null);
  const [windMph, setWindMph] = useState<number | null>(null);
  const dir = windDir ?? s.weather.windFromDeg;
  const speedMph = windMph ?? mph(s.weather.windSpeedMps);
  const windDirty = windDir !== null || windMph !== null;
  const [busy, setBusy] = useState(false);

  async function applyWind() {
    setBusy(true);
    try {
      await source.setWeather(mps(speedMph), dir, s.weather.gustMps);
      setWindDir(null);
      setWindMph(null);
    } finally {
      setBusy(false);
    }
  }

  const ago = (ms: number) => `${Math.max(0, Math.round((nowMs - ms) / 1000))}s`;
  const simClockMs = s.clock.lastTickMs + (simNow(s.clock, nowMs) - s.clock.simS) * 1000;
  const rankOf = (id: bigint) => rows.findIndex(r => r.request.id === id) + 1;

  return (
    <div className="cpage">
      <CommandNav />

      <section className="cheader">
        <div>
          <p className="cheader__meta">
            <span className="mono">INCIDENT {s.incident.id}</span>
            <i className="cdot" />
            <span className="cheader__active">{s.clock.running ? 'ACTIVE SCENARIO' : 'SCENARIO PAUSED'}</span>
          </p>
          <h1 className="cheader__title">
            {s.incident.name} <span>{s.incident.area}</span>
          </h1>
        </div>
        <div className="cheader__timing">
          <div>
            <p className="clabel">INCIDENT CLOCK · {clockHMTz(nowMs).split(' ')[1]}</p>
            <p className="mono cheader__clock">
              {clockHMS(simClockMs)} <span>{tPlus(s, nowMs)}</span>
            </p>
          </div>
          <button type="button" className="cbtn" onClick={() => source.setRunning(!s.clock.running)}>
            {s.clock.running ? <img src={pauseIcon} width={14} height={14} alt="" /> : <span aria-hidden>▶</span>}
            {s.clock.running ? 'Pause simulation' : 'Resume simulation'}
          </button>
          <a className="cbtn" href="#/command/queue">
            <img src={slidersIcon} width={14} height={14} alt="" />
            Scenario settings
          </a>
        </div>
      </section>

      <section className="cmetrics" aria-label="Operational counts">
        <Metric value={String(c.requests)} title="Opt-in requests" sub={`${c.people} people · consented only`} />
        <Metric value={pad2(c.escalated)} tone={c.escalated ? 'red' : undefined} title="Unreachable by ground" sub="Commander review required" />
        <Metric value={pad2(c.critical)} tone={c.critical ? 'amber' : undefined} title="Critical · 0–10 min" sub={`${c.high} high · ${c.moderate} moderate`} />
        <Metric value={`${c.unitsAvailable} / ${c.unitsTotal}`} title="Units available" sub={`${c.unitsTotal - c.unitsAvailable} busy across ${c.stations} stations`} />
        <Metric value={clockHMS(s.lastPlan.atMs)} small title="Queue recomputed" sub={`${s.lastPlan.reason} · ${ago(s.lastPlan.atMs)} ago`} />
      </section>

      <main className="cworkspace">
        <section className="cpanel cqueue">
          <div className="cqueue__heading">
            <div>
              <h2>Full rescue queue</h2>
              <p className="csub">
                {c.requests} requests · {c.people} people · {c.stations} stations · manual reordering enabled
              </p>
            </div>
            <div className="cqueue__tools">
              <select
                className="cbtn"
                aria-label="Filter by station"
                value={stationFilter}
                onChange={e => {
                  setStationFilter(Number(e.target.value));
                  setPage(0);
                }}
              >
                <option value={0}>All stations · {rows.length}</option>
                {s.stations.map(st => (
                  <option key={st.id} value={st.id}>
                    {st.name} · {rows.filter(r => r.station.id === st.id).length}
                  </option>
                ))}
              </select>
              {searching ? (
                <input
                  className="cbtn cqueue__search"
                  autoFocus
                  placeholder="Q-018 or station"
                  value={search}
                  onChange={e => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                  onBlur={() => !search && setSearching(false)}
                />
              ) : (
                <button type="button" className="cbtn" onClick={() => setSearching(true)}>
                  Search queue
                </button>
              )}
              <a className="cbtn cbtn--dark" href="#/command/queue">
                Manage queue →
              </a>
            </div>
          </div>

          {escalations.map(f => (
            <div key={String(f.id)} className="cescalation" role="alert">
              <img src={triangleAlert} width={15} height={15} alt="" />
              <strong>{requestCode(f.requestId)} · Unreachable by ground</strong>
              <span>No ground unit committed. Commander must review alternate support.</span>
              <button type="button" className="cbtn" onClick={() => select(f.requestId)}>
                Review escalation →
              </button>
            </div>
          ))}

          <div className="ctiles">
            <Tile label="TOTAL" value={String(c.requests)} sub="All requests" />
            <Tile label="CRITICAL" value={pad2(c.critical)} sub="Slack ≤ 10 min" tone="amber" />
            <Tile label="UNREACHABLE" value={pad2(c.escalated)} sub="Ground access blocked" tone="red" />
            <Tile label="PEOPLE" value={String(c.people)} sub="Across all requests" />
            <Tile label="UNITS" value={`${c.unitsAvailable} / ${c.unitsTotal}`} sub="Available / total" />
          </div>

          <div className="cpager">
            <p>
              Showing {filtered.length ? pageIdx * PAGE + 1 : 0}–{Math.min(filtered.length, (pageIdx + 1) * PAGE)} of {filtered.length} · all requests explicitly opted in
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

          <table className="ctable">
            <thead>
              <tr>
                <th>#</th>
                <th>REQUEST</th>
                <th>PEOPLE / NEEDS</th>
                <th>STATION / UNIT</th>
                <th>ETA¹</th>
                <th>SLACK ↑</th>
                <th>WHY THIS RANK</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(r => {
                const level = r.escalated ? 'unreachable' : r.request.level;
                const isSel = r === selected;
                return (
                  <tr key={String(r.request.id)} className={isSel ? 'is-selected' : ''} onClick={() => select(r.request.id)} aria-selected={isSel}>
                    <td className="mono muted">{pad2(rankOf(r.request.id))}</td>
                    <td className="mono">
                      <button type="button" className="ctable__link" onClick={() => select(r.request.id)}>
                        {requestCode(r.request.id)}
                      </button>
                    </td>
                    <td>{peopleNeeds(r.request)}</td>
                    <td className="mono">
                      {r.station.name.split(' ')[0]} /{' '}
                      {r.escalated || !r.unit ? (
                        'Review'
                      ) : (
                        <button
                          type="button"
                          className="clinkbtn"
                          title={`Show ${r.unit.callsign}'s journey`}
                          onClick={e => {
                            e.stopPropagation();
                            selectUnit(r.unit!.id);
                          }}
                        >
                          {r.unit.callsign}
                        </button>
                      )}
                    </td>
                    <td className="mono">{r.escalated ? '—' : `${Math.max(0, Math.round((r.entry.etaS - s.clock.simS) / 60))} min`}</td>
                    <td className={`mono cslack-text cslack-text--${level}`}>{slackText(r.request.slackS)}</td>
                    <td className="muted">{r.entry.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="cfootnote">Slack: &lt;0 unreachable · 0–10 critical · &gt;10–30 high · &gt;30 moderate. ¹ETA = unit wait + travel, not extraction.</p>
        </section>

        <section className="cpicture">
          <div className="cpanel cpicture__map">
            <div className="cmaptools">
              <div className="cmaptools__identity">
                <h2>Incident picture</h2>
                <span className="cbadge cbadge--muted">{c.requests} consented locations</span>
              </div>
              <div className="cmaptools__actions">
                <div className="cmenu">
                  <button type="button" className="cbtn" aria-expanded={layersOpen} onClick={() => setLayersOpen(o => !o)}>
                    <img src={layersIcon} width={14} height={14} alt="" />
                    Layers · {visible.size}
                  </button>
                  {layersOpen && (
                    <div className="cmenu__list">
                      {LAYERS.map(name => (
                        <label key={name}>
                          <input
                            type="checkbox"
                            checked={visible.has(name)}
                            onChange={e => {
                              const next = new Set(visible);
                              if (e.target.checked) next.add(name);
                              else next.delete(name);
                              setVisible(next);
                            }}
                          />
                          {name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <button type="button" className="cbtn" onClick={() => setFitSignal(n => n + 1)}>
                  <img src={scanIcon} width={14} height={14} alt="" />
                  Fit incident
                </button>
              </div>
            </div>

            <CommandMap
              snapshot={s}
              rows={rows}
              selected={selected}
              labeled={new Set(pageRows.map(r => r.request.id))}
              route={route?.key === routeKey ? route.route : null}
              visible={visible}
              fitSignal={fitSignal}
              journey={journey}
              onSelect={select}
            />

            <div className="clegend">
              <span><i className="ckey ckey--dot ckey--unreachable" />Unreachable</span>
              <span><i className="ckey ckey--dot ckey--critical" />Critical</span>
              <span><i className="ckey ckey--dot ckey--high" />High</span>
              <span><i className="ckey ckey--dot ckey--moderate" />Moderate</span>
              <span><i className="ckey ckey--fire" />Fire perimeter</span>
              <span><i className="ckey ckey--forecast" />Forecast +30m</span>
              <span><i className="ckey ckey--closed" />Closed road</span>
              <span><i className="ckey ckey--route" />Selected route</span>
            </div>

            <div className="cwind">
              <div>
                <p className="cwind__title">Simulation wind</p>
                <p className="cwind__sub">Changes rerank the queue</p>
              </div>
              <select className="cbtn" aria-label="Wind from" value={Math.round(dir / 45) * 45 % 360} onChange={e => setWindDir(Number(e.target.value))}>
                {[0, 45, 90, 135, 180, 225, 270, 315].map(d => (
                  <option key={d} value={d}>
                    {compass(d)} · {d}°
                  </option>
                ))}
              </select>
              <label className="cwind__speed">
                <input type="range" min={0} max={45} value={speedMph} aria-label="Wind speed" onChange={e => setWindMph(Number(e.target.value))} />
                <span className="mono">{speedMph} mph</span>
              </label>
              <button type="button" className="cbtn" disabled={!windDirty || busy} onClick={applyWind}>
                {busy ? 'Reranking…' : 'Apply & rerank'}
              </button>
              <div className="cwind__fresh">
                <p className="mono">
                  FIRE {clockHMS(s.sources.fireMs)} · WEATHER {clockHMS(s.sources.weatherMs)} · CLOSURES {clockHMS(s.sources.closuresMs)}
                </p>
                <p>
                  All sources simulated · updated {ago(s.sources.fireMs)} / {ago(s.sources.weatherMs)} / {ago(s.sources.closuresMs)} ago
                </p>
              </div>
            </div>
          </div>

          <div className="cside">
            <div className="ctabs" role="tablist" aria-label="Details">
              <button type="button" role="tab" aria-selected={tab === 'request'} className={tab === 'request' ? 'is-on' : ''} onClick={() => setTab('request')}>
                Request{selected ? ` · ${requestCode(selected.request.id)}` : ''}
              </button>
              <button type="button" role="tab" aria-selected={tab === 'units'} className={tab === 'units' ? 'is-on' : ''} onClick={() => setTab('units')}>
                Units · {c.unitsTotal}
                {unit ? ` · ${unit.callsign}` : ''}
              </button>
            </div>
            {tab === 'units' ? (
              <UnitPanel snapshot={s} source={source} rows={rows} unitId={unitId} nowMs={nowMs} onSelectUnit={selectUnit} onSelectRequest={select} />
            ) : (
              selected && (
                <RequestDetails
                  key={String(selected.request.id)}
                  row={selected}
                  rank={rankOf(selected.request.id)}
                  total={rows.length}
                  snapshot={s}
                  source={source}
                  nowMs={nowMs}
                  onSelectUnit={selectUnit}
                />
              )
            )}
          </div>
        </section>
      </main>

      <SafetyFooter snapshotLabel={`SNAPSHOT ${clockHMSTz(s.updatedAtMs)}`} />
    </div>
  );
}

function Metric({ value, title, sub, tone, small }: { value: string; title: string; sub: string; tone?: 'red' | 'amber'; small?: boolean }) {
  return (
    <div className="cmetric">
      <p className={`mono cmetric__value${tone ? ` tone-${tone}` : ''}${small ? ' cmetric__value--small' : ''}`}>{value}</p>
      <div>
        <p className="cmetric__title">{title}</p>
        <p className="cmetric__sub">{sub}</p>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'red' | 'amber' }) {
  return (
    <div className="ctile">
      <p className="clabel">{label}</p>
      <p className={`mono ctile__value${tone ? ` tone-${tone}` : ''}`}>{value}</p>
      <p className="ctile__sub">{sub}</p>
    </div>
  );
}
