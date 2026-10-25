import { useState } from 'react';
import { useNow } from '../lib/useNow';
import { requestCode } from '../ops/derive';
import { useCommandData } from '../ops/hooks';
import { CommandNav, SafetyFooter } from './components/CommandNav';
import { RequestDetails } from './components/RequestDetails';
import { alertStatus, bySlack, commandRows, commandSlack, peopleNeedsLong, stationUnit } from './derive';

/** Shared backend assignments, without the in-browser policy-preview controls. */
export function LiveQueuePage() {
  const { snapshot, source } = useCommandData();
  const now = useNow(1000);
  const rows = bySlack(commandRows(snapshot));
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const selected = rows.find(r => r.request.id === selectedId) ?? rows[0];
  return <div className="cpage">
    <CommandNav />
    <section className="cheader"><div><h1>Rescue queue</h1><p className="csub">{rows.length} active requests · LOOKAHEAD dispatch · lower slack first</p></div><a className="cbtn" href="#/command">Incident map</a></section>
    <main className="cworkspace">
      <section className="cpanel cqueue">
        <div className="cqueue__heading"><h2>All received calls</h2><p className="csub">New calls appear before assessment and remain visible through dispatch.</p></div>
        <div className="ctable__scroll"><table className="ctable"><thead><tr><th>REQUEST</th><th>STATUS</th><th>STATION / UNIT</th><th>SLACK</th></tr></thead><tbody>
          {rows.map(row => <tr key={String(row.request.id)} aria-selected={row === selected} className={row === selected ? 'is-selected' : ''} onClick={() => setSelectedId(row.request.id)}>
            <td><button className="ctable__link mono" onClick={() => setSelectedId(row.request.id)}>{requestCode(row.request.id)}</button><p className="ctable__sub">{peopleNeedsLong(row.request)}</p></td>
            <td>{alertStatus(row, snapshot).label}</td><td>{stationUnit(row)}{row.unit && <p><a className="clinkbtn" href={`#/responder/${row.unit.id}`}>Open {row.unit.callsign} responder →</a></p>}</td>
            <td className={`mono cslack-text cslack-text--${row.request.level}`}>{commandSlack(row, snapshot)}</td>
          </tr>)}
        </tbody></table></div>
        {!rows.length && <p className="csub">No active calls. Caller alerts will appear here automatically.</p>}
      </section>
      {selected && <RequestDetails key={String(selected.request.id)} row={selected} rank={rows.indexOf(selected) + 1} total={rows.length} snapshot={snapshot} source={source} nowMs={now} onSelectUnit={id => { window.location.hash = `/responder/${id}`; }} />}
    </main>
    <SafetyFooter snapshotLabel="Shared incident state" />
  </div>;
}
