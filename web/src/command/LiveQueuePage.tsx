import { useState } from 'react';
import { useNow } from '../lib/useNow';
import { requestCode } from '../ops/derive';
import { useCommandData } from '../ops/hooks';
import { CommandNav } from './components/CommandNav';
import { RequestDetails } from './components/RequestDetails';
import { alertStatus, bySlack, commandRows, peopleNeeds, stationUnit } from './derive';

/** Queue management uses the same real requests and dispatch action as the incident map. */
export function LiveQueuePage() {
  const { snapshot, source } = useCommandData();
  const now = useNow(1000);
  const rows = bySlack(commandRows(snapshot));
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const selected = rows.find(row => row.request.id === selectedId) ?? rows[0];
  const visible = rows.filter(row => `${requestCode(row.request.id)} ${row.station.name} ${row.unit?.callsign ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="cpage">
    <CommandNav />
    <section className="cheader"><div><h1>Live rescue queue</h1><p className="csub">{rows.length} active requests · received calls appear before a plan is available.</p></div>
      <a className="cbtn" href="#/command">Incident map →</a></section>
    <main className="cworkspace">
      <section className="cpanel cqueue">
        <div className="cqueue__heading"><h2>Help requests</h2><input className="cbtn" aria-label="Find requests" placeholder="Request, station or unit" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="ctable__scroll"><table className="ctable"><thead><tr><th>REQUEST</th><th>STATUS</th><th>STATION / UNIT</th><th>DETAILS</th></tr></thead>
          <tbody>{visible.map(row => <tr key={String(row.request.id)} aria-selected={selected === row} className={selected === row ? 'is-selected' : ''} onClick={() => setSelectedId(row.request.id)}>
            <td><button className="ctable__link mono" onClick={() => setSelectedId(row.request.id)}>{requestCode(row.request.id)}</button></td>
            <td>{alertStatus(row, snapshot).label}</td><td>{row.pending ? 'Awaiting dispatch' : stationUnit(row)}</td><td>{peopleNeeds(row.request)}</td>
          </tr>)}</tbody></table></div>
        {!visible.length && <p className="csub">No matching active requests.</p>}
      </section>
      <section className="cpicture">{selected && <RequestDetails key={String(selected.request.id)} row={selected} rank={rows.indexOf(selected) + 1} total={rows.length}
        snapshot={snapshot} source={source} nowMs={now} onSelectUnit={id => { window.location.hash = `/responder/${id}`; }} />}</section>
    </main>
  </div>;
}
