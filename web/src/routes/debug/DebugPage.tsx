// Dev only (phase 1 "done when"): live row counts for every table and view,
// the ticking sim clock and the connection, for one surface's identity at a
// time (?as=help|command|crew). Shows counts, never rows.
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { login, useOperator, type OperatorRole } from '@/lib/auth/operator';
import { EVERYTHING, StdbProvider, mapCallError, useConnection, useSingleton, useTable, type SourceName, type Surface } from '@/lib/stdb';
import { useSourceRows } from '@/lib/stdb/hooks';
import { isView } from '@/lib/stdb/queries';
import { formatClock, formatT, useSimNow } from '@/lib/time/sim';
import { Button } from '@/lib/ui/button';
import { Input } from '@/lib/ui/input';
import { Panel } from '@/lib/ui/Panel';
import { cn } from '@/lib/utils';

const SURFACES = ['help', 'command', 'crew'] as const satisfies readonly Surface[];

export function DebugPage() {
  const [params, setParams] = useSearchParams();
  const surface = SURFACES.find(s => s === params.get('as')) ?? 'command';
  return (
    <StdbProvider surface={surface} sources={EVERYTHING}>
      <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">Debug</h1>
          <span className="mono-tag text-muted-foreground">dev only</span>
          <nav className="ml-auto flex gap-1" aria-label="Identity">
            {SURFACES.map(s => (
              <Button
                key={s}
                size="sm"
                variant={s === surface ? 'default' : 'outline'}
                aria-pressed={s === surface}
                onClick={() => setParams({ as: s })}
              >
                as {s}
              </Button>
            ))}
          </nav>
        </header>
        <div className="grid gap-4 md:grid-cols-2">
          <ConnectionPanel />
          <ClockPanel />
        </div>
        <CountsPanel />
        {surface !== 'help' && <SignInPanel role={surface === 'command' ? 'commander' : 'responder'} />}
      </main>
    </StdbProvider>
  );
}

export default DebugPage;

function Field({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mono-tag text-right text-foreground" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function ConnectionPanel() {
  const c = useConnection();
  return (
    <Panel title="Connection" className="pb-3">
      <dl className="px-4">
        <Field label="Surface" value={c.surface ?? 'none'} />
        <Field label="State" value={c.state} testId="conn-state" />
        <Field label="Subscription applied" value={String(c.ready)} testId="conn-ready" />
        <Field label="Stale" value={String(c.stale)} />
        <Field label="Identity" value={c.identity ? `${c.identity.toHexString().slice(0, 12)}...` : 'none'} />
        <Field label="Identity reset" value={String(c.tokenReset)} />
        <Field label="Last live" value={c.lastLiveAt ? formatClock(c.lastLiveAt, true) : 'never'} />
        <Field label="Last error" value={c.error ?? 'none'} />
      </dl>
    </Panel>
  );
}

function ClockPanel() {
  const clock = useSingleton('sim_clock');
  const versions = useSingleton('world_version');
  const simNow = useSimNow();
  return (
    <Panel title="Sim clock" className="pb-3">
      <dl className="px-4">
        <Field label="Scenario" value={clock?.scenario ?? 'none'} testId="sim-scenario" />
        <Field label="Sim time" value={simNow === undefined ? 'none' : formatT(simNow)} testId="sim-t" />
        <Field label="Speed" value={clock ? `${clock.speed}×${clock.running ? '' : ' (paused)'}` : 'none'} />
        <Field
          label="World versions"
          value={
            versions
              ? `w${versions.weather} f${versions.fire} r${versions.roads} q${versions.requests} fc${versions.forecast} d${versions.danger} p${versions.plan}`
              : 'none'
          }
        />
      </dl>
    </Panel>
  );
}

function CountRow({ name }: { name: SourceName }) {
  const rows = useSourceRows(name);
  return (
    <tr className="border-t border-border">
      <td className="mono-tag py-1.5 pl-4 text-foreground">{name}</td>
      <td className="py-1.5 text-sm text-muted-foreground">{isView(name) ? 'view' : 'table'}</td>
      <td className={cn('mono-tag py-1.5 pr-4 text-right', rows.length ? 'text-foreground' : 'text-muted-foreground')} data-testid={`count-${name}`}>
        {rows.length}
      </td>
    </tr>
  );
}

function CountsPanel() {
  return (
    <Panel title="Row counts" meta="live">
      <table className="w-full">
        <tbody>
          {EVERYTHING.map(name => (
            <CountRow key={name} name={name} />
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function SignInPanel({ role }: { role: OperatorRole }) {
  const operator = useOperator(role);
  const stations = useTable('station');
  const c = useConnection();
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [stationId, setStationId] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      await login(passcode, role, stationId, name.trim() || 'debug');
      setPasscode('');
      setStatus('Signed in.');
    } catch (err) {
      setStatus(mapCallError(err).copy);
    }
  }

  return (
    <Panel title={`Sign in as ${role}`} meta={operator ? `remembered: ${operator.name}` : 'not signed in'} className="pb-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 px-4">
        <label className="grid gap-1 text-sm">
          Name
          <Input value={name} onChange={e => setName(e.target.value)} autoComplete="off" className="w-40" />
        </label>
        <label className="grid gap-1 text-sm">
          Passcode
          <Input
            type="password"
            value={passcode}
            onChange={e => setPasscode(e.target.value)}
            autoComplete="off"
            className="w-40"
            data-testid="debug-passcode"
          />
        </label>
        {role === 'responder' && (
          <label className="grid gap-1 text-sm">
            Station
            <select
              value={stationId}
              onChange={e => setStationId(Number(e.target.value))}
              className="h-8 rounded-lg border border-input bg-input/30 px-2 text-sm"
            >
              <option value={0}>Pick a station</option>
              {stations.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" disabled={!c.canCall || !passcode} data-testid="debug-signin">
          Sign in
        </Button>
        {status && (
          <p role="status" className="w-full text-sm text-muted-foreground" data-testid="debug-signin-status">
            {status}
          </p>
        )}
      </form>
    </Panel>
  );
}
