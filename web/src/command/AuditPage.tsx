import { useState } from 'react';
import arrowLeft from '../assets/figma/command/arrow-left.svg';
import searchIcon from '../assets/figma/command/search.svg';
import { clockHMSTz, requestCode } from '../ops/derive';
import { useCommandData } from '../ops/hooks';
import type { EventLogEntry } from '../ops/types';
import { CommandNav, SafetyFooter } from './components/CommandNav';
import { pad2 } from './derive';

type Who = 'all' | 'commander' | 'crews' | 'agents';

const WHO_LABEL: Record<Exclude<Who, 'all'>, string> = {
  commander: 'Commander',
  crews: 'Crews & stations',
  agents: 'Agents & system',
};

const KIND_LABEL: Record<string, string> = {
  override: 'Override',
  policy: 'Policy applied',
  wind: 'Wind',
  sim: 'Simulation',
  flag: 'Flag raised',
  flag_resolved: 'Flag resolved',
  en_route: 'Dispatched',
  on_scene: 'On scene',
  rescued: 'Completed',
  aborted: 'Returned to queue',
  scenario: 'Scenario',
};

function whoOf(e: EventLogEntry): Exclude<Who, 'all'> {
  if (e.actor.startsWith('commander')) return 'commander';
  if (e.actor.startsWith('crew:') || e.actor.startsWith('station:')) return 'crews';
  return 'agents';
}

/** "commander:A. Lee" → "A. Lee"; "station:S02 Canyon" → "S02 Canyon". */
const actorName = (actor: string) => actor.split(':').slice(1).join(':') || actor;

const tPlus = (simS: number) => {
  const m = Math.max(0, Math.floor(simS / 60));
  return `T+${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
};

function toCsv(rows: EventLogEntry[]) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map(e =>
    [new Date(e.atMs).toISOString(), tPlus(e.simS), whoOf(e), actorName(e.actor), e.kind, e.requestId ? requestCode(e.requestId) : '', e.message].map(esc).join(',')
  );
  return ['time,incident_time,who,actor,action,request,detail', ...lines].join('\n');
}

/** Every logged action on the incident, newest first. */
export function AuditPage() {
  const { snapshot: s } = useCommandData();
  const [who, setWho] = useState<Who>('all');
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const rows = s.events.filter(
    e =>
      (who === 'all' || whoOf(e) === who) &&
      (!q || e.message.toLowerCase().includes(q) || e.actor.toLowerCase().includes(q) || (e.requestId !== 0n && requestCode(e.requestId).toLowerCase().includes(q)))
  );
  const count = (w: Exclude<Who, 'all'>) => s.events.filter(e => whoOf(e) === w).length;

  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${s.incident.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
          <a href="#/command/queue">Rescue queue</a>
          <span>/</span>
          <span>Audit log</span>
        </div>
        <div className="qheader__identity">
          <div>
            <h1>Audit log</h1>
            <p className="csub">
              {s.incident.name} · INCIDENT {s.incident.id} · newest first · the most recent {s.events.length} actions. No locations or names are logged.
            </p>
          </div>
          <div className="qheader__actions">
            <button type="button" className="cbtn" disabled={!rows.length} onClick={download}>
              Download CSV
            </button>
          </div>
        </div>
      </section>

      <main className="caudit">
        <section className="cpanel">
          <div className="caudit__filters">
            <span className="qseg" role="group" aria-label="Who acted">
              {(['all', 'commander', 'crews', 'agents'] as Who[]).map(w => (
                <button key={w} type="button" aria-pressed={who === w} className={who === w ? 'is-on' : ''} onClick={() => setWho(w)}>
                  {w === 'all' ? `All · ${s.events.length}` : `${WHO_LABEL[w]} · ${count(w)}`}
                </button>
              ))}
            </span>
            <label className="qsearch">
              <img src={searchIcon} width={14} height={14} alt="" />
              <input placeholder="Search actions, actors or request IDs" value={query} onChange={e => setQuery(e.target.value)} />
            </label>
          </div>

          <table className="ctable caudit__table">
            <thead>
              <tr>
                <th>TIME</th>
                <th>INCIDENT</th>
                <th>WHO</th>
                <th>ACTION</th>
                <th>REQUEST</th>
                <th>DETAIL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(e => {
                const w = whoOf(e);
                return (
                  <tr key={String(e.id)}>
                    <td className="mono">{clockHMSTz(e.atMs).split(' ')[0]}</td>
                    <td className="mono muted">{tPlus(e.simS)}</td>
                    <td>
                      <span className={`caudit__who caudit__who--${w}`}>{WHO_LABEL[w]}</span>
                      <p className="ctable__sub">{actorName(e.actor)}</p>
                    </td>
                    <td>{KIND_LABEL[e.kind] ?? e.kind}</td>
                    <td className="mono">{e.requestId ? requestCode(e.requestId) : '—'}</td>
                    <td className="caudit__detail">{e.message}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="caudit__empty">No actions match these filters.</p>}
        </section>
      </main>

      <SafetyFooter snapshotLabel={`SNAPSHOT ${clockHMSTz(s.updatedAtMs)}`} />
    </div>
  );
}
