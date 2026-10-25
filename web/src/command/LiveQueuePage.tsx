import { useState } from 'react';
import { useCommandData } from '../ops/hooks';
import { requestCode } from '../ops/derive';
import { useNow } from '../lib/useNow';
import { CommandNav, SafetyFooter } from './components/CommandNav';
import { RequestDetails } from './components/RequestDetails';
import { alertStatus, bySlack, commandRows, peopleNeeds, slackText, stationUnit } from './derive';

export function LiveQueuePage() {
  const { snapshot, source } = useCommandData();
  const nowMs = useNow(1000);
  const rows = bySlack(commandRows(snapshot));
  const [id, setId] = useState<bigint | null>(null);
  const selected = rows.find(r => r.request.id === id) ?? rows[0];
  return <div className="cpage"><CommandNav />
    <section className="cheader"><div><h1>Rescue queue</h1><p>LOOKAHEAD dispatch · lower slack first · {rows.length} active requests</p></div><a className="cbtn" href="#/command">Incident map</a></section>
    <main className="cworkspace">
      <section className="cpanel cqueue"><div className="ctable__scroll"><table className="ctable"><thead><tr><th>REQUEST</th><th>STATUS</th><th>STATION / UNIT</th><th>SLACK</th><th>DETAILS</th></tr></thead>
        <tbody>{rows.map(r => <tr key={String(r.request.id)} aria-selected={r === selected} className={r === selected ? 'is-selected' : ''}>
          <td><button className="clinkbtn" onClick={() => setId(r.request.id)}>{requestCode(r.request.id)}</button></td><td>{alertStatus(r, snapshot).label}</td><td>{stationUnit(r)}</td><td>{slackText(r.request.slackS)}</td><td>{peopleNeeds(r.request)}</td>
        </tr>)}</tbody></table></div>{!rows.length && <p className="csub" style={{ padding: 20 }}>No active requests. New caller alerts appear here as soon as they are received.</p>}</section>
      {selected && <RequestDetails key={String(selected.request.id)} row={selected} rank={rows.indexOf(selected) + 1} total={rows.length} snapshot={snapshot} source={source} nowMs={nowMs} onSelectUnit={() => { window.location.hash = '/command'; }} />}
    </main><SafetyFooter snapshotLabel="Shared live rescue queue" /></div>;
}
