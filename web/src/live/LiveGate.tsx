// The gate in front of the operator screens, live data only: connect this tab as the surface, wait for the incident
// data, and make sure this identity is signed in with the right role before the screen mounts. With the simulation
// it renders the screen straight away.

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import brandMark from '../assets/figma/brand-mark.svg';
import { Button, Eyebrow, Heading, Note, Panel, StatusNotice, TextField } from '../components/ui';
import type { OperatorInfo } from '../ops/types';
import { CONFIG_ERROR, isLive, STDB_DB, STDB_URI } from './config';
import { connection } from './connection';
import { errorCopy } from './errors';
import { SurfaceContext, useConnection, useLiveRows, useSourceStatus, type ConnectionInfo } from './hooks';
import { claimedThisSession, operatorOf, rememberedSignIn, signIn } from './operator';
import type { RowOf, Surface } from './tables';
import './LiveGate.css';

interface LiveGateProps {
  surface: Surface;
  role: 'commander' | 'responder';
  /** The responder's station (from its unit row). Without it the form asks which station. */
  stationId?: number;
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function LiveGate(props: LiveGateProps): ReactNode {
  return isLive ? <Gate {...props} /> : props.children;
}

const signedInAs = (op: OperatorInfo | null, role: LiveGateProps['role'], stationId: number | undefined) =>
  !!op && op.role === role && (role === 'commander' || stationId === undefined || op.stationId === stationId);

function Gate({ surface, role, stationId, title, subtitle, children }: LiveGateProps) {
  useEffect(() => {
    connection.use(surface);
  }, [surface]);
  const conn = useConnection();
  const grids = useLiveRows('grid', surface);
  const clocks = useLiveRows('sim_clock', surface);
  const operators = useLiveRows('my_operator', surface);
  const operatorStatus = useSourceStatus('my_operator', surface);
  const stations = useLiveRows('station', surface);

  const card = (body: ReactNode) => (
    <GateCard title={title} subtitle={subtitle}>
      {body}
    </GateCard>
  );

  if (CONFIG_ERROR) return card(<ConfigProblem message={CONFIG_ERROR} />);
  if (conn.surface !== surface || !conn.ready) return card(<Connecting conn={conn} />);

  const grid = grids.find(g => g.id === 0) ?? grids[0];
  const clock = clocks.find(c => c.id === 0) ?? clocks[0];
  if (!grid || grid.rows === 0 || grid.cols === 0 || !clock || clock.scenario === 'none') return card(<NoIncident />);

  const op = operatorOf(operators);
  // No my_operator view (older module): trust a claim made in this tab.
  const ok = operatorStatus === 'applied' ? signedInAs(op, role, stationId) : operatorStatus === 'failed' ? claimedThisSession(surface) : null;
  if (ok === null) return card(<Heading>Checking sign-in…</Heading>);
  if (!ok) {
    return card(
      <SignIn key={surface} surface={surface} role={role} stationId={stationId} stations={stations} current={operatorStatus === 'applied' ? op : null} canCall={conn.canCall} />
    );
  }
  return <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>;
}

function GateCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="livegate">
      <Panel className="livegate__card">
        <div className="livegate__brand">
          <img src={brandMark} width={15} height={20} alt="" />
          <span>ResQueue</span>
        </div>
        <div className="livegate__title">
          <Eyebrow>{title}</Eyebrow>
          {subtitle && <Note>{subtitle}</Note>}
        </div>
        <div className="livegate__body" aria-live="polite">
          {children}
        </div>
      </Panel>
    </div>
  );
}

const host = (() => {
  try {
    return new URL(STDB_URI).host;
  } catch {
    return STDB_URI;
  }
})();

function ConfigProblem({ message }: { message: string }) {
  return (
    <>
      <Heading>Live data isn't set up</Heading>
      <Note tone="ink" size={13}>
        {message}
      </Note>
      <Note>Fix VITE_STDB_URI in web/.env.local (or STDB_HTTP in the repo .env), or run the simulation with VITE_DATA_SOURCE=sim.</Note>
    </>
  );
}

function Connecting({ conn }: { conn: ConnectionInfo }) {
  const where = `${STDB_DB} on ${host}`;
  if (conn.state === 'error') {
    return (
      <>
        <Heading>Can't reach the server</Heading>
        <Note tone="ink" size={13}>
          {where} isn't answering. Is SpacetimeDB running? From the repo root, scripts/dev.sh starts it and seeds an incident.
        </Note>
        {conn.error && <Note size={11}>{conn.error}</Note>}
        <Note>Retrying every 10 s.</Note>
        <Button onClick={() => connection.retryNow()}>Try again now</Button>
      </>
    );
  }
  if (conn.state === 'offline') {
    return (
      <>
        <Heading>You're offline</Heading>
        <Note tone="ink" size={13}>
          This screen reconnects on its own when the network is back.
        </Note>
      </>
    );
  }
  if (conn.state === 'live' && conn.error) {
    return (
      <>
        <Heading>Couldn't load the incident</Heading>
        <Note tone="ink" size={13}>
          {conn.error}
        </Note>
        <Note>The module on the server may be older than this app: republish it with scripts/dev.sh db.</Note>
        <Button onClick={() => connection.retryNow()}>Try again</Button>
      </>
    );
  }
  return (
    <>
      <Heading>{conn.state === 'live' ? 'Loading the incident…' : conn.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</Heading>
      <Note>{conn.state === 'reconnecting' ? 'The connection dropped. Retrying on its own.' : `Reaching ${where}.`}</Note>
    </>
  );
}

function NoIncident() {
  return (
    <>
      <Heading>No incident loaded</Heading>
      <Note tone="ink" size={13}>
        SpacetimeDB is up, but no scenario has been seeded yet. From the repo root, run scripts/dev.sh: it publishes the module,
        seeds an incident and starts the agents.
      </Note>
      <Note>This screen continues on its own once the incident is loaded.</Note>
    </>
  );
}

interface SignInProps {
  surface: Surface;
  role: LiveGateProps['role'];
  stationId?: number;
  stations: readonly RowOf<'station'>[];
  /** Signed in, but as someone else (another role or station). */
  current: OperatorInfo | null;
  canCall: boolean;
}

function SignIn({ surface, role, stationId, stations, current, canCall }: SignInProps) {
  const [remembered] = useState(() => rememberedSignIn(surface));
  const [name, setName] = useState(() => remembered?.name ?? '');
  const [passcode, setPasscode] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const known = (id: number | null | undefined) => (id != null && stations.some(s => s.id === id) ? id : undefined);
  const sid = role === 'commander' ? 0 : (stationId ?? known(picked) ?? known(remembered?.stationId) ?? stations[0]?.id ?? 0);
  const station = stations.find(s => s.id === sid);
  const stationName = (id: number) => stations.find(s => s.id === id)?.name ?? `station ${id}`;
  const missingStation = role === 'responder' && !station;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !passcode || missingStation) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(role, sid, name, passcode);
      setPasscode('');
    } catch (err) {
      setError(errorCopy(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="livegate__form" onSubmit={submit}>
      <Heading>Sign in</Heading>
      <Note tone="ink" size={14}>
        {role === 'commander' ? 'Incident commander' : `Responder · ${station?.name ?? stationName(sid)}`}
      </Note>
      {current && (
        <Note>
          Signed in as {current.name || 'an operator'}, {current.role === 'commander' ? 'incident command' : `a responder for ${stationName(current.stationId)}`}. Sign in
          again for this screen.
        </Note>
      )}
      {role === 'responder' && stationId === undefined && stations.length > 0 && (
        <div className="field">
          <label className="field__label" htmlFor="livegate-station">
            Station
          </label>
          <select id="livegate-station" className="livegate__select" value={sid} onChange={e => setPicked(Number(e.target.value))}>
            {stations.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {missingStation && <StatusNotice title="Station not found">This unit's station isn't part of the loaded incident.</StatusNotice>}
      <TextField id="livegate-name" label="Your name" value={name} placeholder="Shown in the audit log" onChange={setName} inputProps={{ autoComplete: 'name', maxLength: 60 }} />
      <TextField
        id="livegate-passcode"
        label="Operator passcode"
        value={passcode}
        onChange={setPasscode}
        inputProps={{ type: 'password', autoComplete: 'current-password' }}
      />
      <Note>The passcode is OPERATOR_PASSCODE in the stack's .env.</Note>
      {error && <StatusNotice title="Couldn't sign in">{error}</StatusNotice>}
      <Button type="submit" variant="primary" disabled={busy || !passcode || !canCall || missingStation}>
        {busy ? 'Signing in…' : canCall ? 'Sign in' : 'Waiting for the connection…'}
      </Button>
    </form>
  );
}
