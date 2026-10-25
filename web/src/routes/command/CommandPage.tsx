import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { forgetOperator, login, useOperator } from '@/lib/auth/operator';
import { isAgentOnline } from '@/lib/domain/status';
import { ENV } from '@/lib/env';
import { FEATURES } from '@/lib/features';
import { hasScenario } from '@/lib/geo/grid';
import { GuideProvider } from '@/lib/guide';
import { commandSteps } from '@/lib/guide/steps/command';
import { mapCallError, useCall, useConnection, useSingleton, useTable, useView, type MappedError } from '@/lib/stdb';
import { useNow, useSimNow } from '@/lib/time/sim';
import { ConnectionBanner } from '@/lib/ui/ConnectionBanner';
import { Skeleton } from '@/lib/ui/skeleton';
import { RequestDrawer } from './components/drawer/RequestDrawer';
import { IncidentMap } from './components/map/IncidentMap';
import { StationQueues } from './components/queues/StationQueues';
import { ClosurePanel } from './components/side/ClosurePanel';
import { EventLog } from './components/side/EventLog';
import { FlagsPanel } from './components/side/FlagsPanel';
import { WindControl } from './components/side/WindControl';
import { AgentsDownBanner } from './components/topbar/AgentsDownBanner';
import { NoScenario } from './components/topbar/NoScenario';
import { OperatorGate } from './components/topbar/OperatorGate';
import { TopBar } from './components/topbar/TopBar';

const BANNER_COPY = {
  offline: 'No connection. Every control is off until it comes back.',
  reconnecting: 'Reconnecting. Controls are off and data may be out of date.',
  error: "Can't reach the server. Still trying.",
};

type Point = [number, number];

function useToastError(e: MappedError | null) {
  useEffect(() => {
    if (!e) return;
    if (e.kind === 'not_operator') forgetOperator('commander');
    toast.error(e.copy);
  }, [e]);
}

export function CommandPage() {
  const conn = useConnection();
  const operator = useOperator('commander');
  const [gatePending, setGatePending] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  async function signIn(name: string, passcode: string) {
    setGatePending(true);
    setGateError(null);
    try {
      await login(passcode, 'commander', 0, name || 'commander');
    } catch (e) {
      setGateError(mapCallError(e).copy);
    } finally {
      setGatePending(false);
    }
  }

  if (conn.ready && !operator) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background p-6">
        <OperatorGate onSubmit={(n, p) => void signIn(n, p)} pending={gatePending} error={gateError} disabled={!conn.canCall} />
      </main>
    );
  }
  return <CommandWorkspace signedInAs={operator?.name} />;
}

function CommandWorkspace({ signedInAs }: { signedInAs: string | undefined }) {
  const conn = useConnection();
  const clock = useSingleton('sim_clock');
  const grid = useSingleton('grid');
  const weather = useSingleton('weather');
  const forecastMeta = useSingleton('forecast_meta');
  const versions = useSingleton('world_version');
  const stations = useTable('station');
  const units = useTable('unit');
  const fireCells = useTable('fire_cell');
  const forecastCells = useTable('forecast_cell');
  const closures = useTable('road_closure');
  const events = useTable('event_log');
  const allAgents = useTable('agent');
  const requests = useView('ops_request');
  const queue = useView('ops_queue');
  const travel = useView('ops_travel');
  const flags = useView('ops_flag');
  const simNow = useSimNow();
  const nowMs = useNow(1000);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<[Point, Point] | null>(null);

  const setSim = useCall('set_sim');
  const setWeather = useCall('set_weather');
  const releaseWind = useCall('release_weather_lock');
  const pin = useCall('override_assignment');
  const flag = useCall('flag_request');
  const resolve = useCall('resolve_flag');
  const addClosure = useCall('add_road_closure');
  const toggleClosure = useCall('set_road_closure_active');
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  // Every failure gets a toast; a lost operator row (scenario reloaded) signs out.
  useToastError(setSim.error);
  useToastError(setWeather.error);
  useToastError(releaseWind.error);
  useToastError(pin.error);
  useToastError(flag.error);
  useToastError(resolve.error);
  useToastError(addClosure.error);
  useToastError(toggleClosure.error);

  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawing(false);
        setDraft(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing]);

  // The seed registers a "scenario" agent that never heartbeats; it isn't part of the mesh.
  const agents = useMemo(() => allAgents.filter(a => a.role !== 'scenario'), [allAgents]);
  const agentsDown = useMemo(
    () =>
      (['delegation', 'danger'] as const).filter(role => !agents.some(a => a.role === role && isAgentOnline(a.lastSeen, nowMs))),
    [agents, nowMs]
  );
  const openFlags = useMemo(() => flags.filter(f => !f.resolved), [flags]);
  const selected = useMemo(() => requests.find(r => String(r.id) === selectedId), [requests, selectedId]);
  const selectedQueue = useMemo(() => queue.find(q => String(q.requestId) === selectedId), [queue, selectedId]);
  const selectedTravel = useMemo(() => travel.filter(t => String(t.requestId) === selectedId), [travel, selectedId]);
  const selectedFlags = useMemo(() => flags.filter(f => String(f.requestId) === selectedId), [flags, selectedId]);
  const forecastUpdating = !!forecastMeta && !!versions && forecastMeta.weatherVersion < versions.weather;
  const guideState = useMemo(() => ({ openFlags: openFlags.length }), [openFlags.length]);
  const disabled = !conn.canCall;
  const stale = conn.stale;
  const noScenario = conn.ready && (!hasScenario(grid) || clock?.scenario === 'none');

  return (
    <GuideProvider screen="command" mode="step" steps={commandSteps} state={guideState} enabled={conn.ready && !noScenario}>
      <div className="flex h-dvh min-w-[1280px] flex-col bg-background">
        <TopBar
          scenario={clock?.scenario ?? ''}
          simNow={simNow}
          running={clock?.running ?? false}
          speed={clock?.speed}
          canControlSim={FEATURES.set_sim}
          onSetSim={(running, speed) => void setSim.run({ running, speed })}
          simPending={setSim.pending}
          agents={agents}
          nowMs={nowMs}
          forecastUpdating={forecastUpdating}
          disabled={disabled}
          operatorName={signedInAs}
          onSignOut={() => forgetOperator('commander')}
        />
        <div className="space-y-2 px-4 empty:hidden [&:not(:empty)]:pt-2">
          <ConnectionBanner copy={BANNER_COPY} />
          {conn.ready && !noScenario && <AgentsDownBanner roles={agentsDown} />}
        </div>
        {noScenario ? (
          <NoScenario />
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)_340px] gap-3 p-3">
            <aside className="min-h-0 overflow-y-auto">
              <StationQueues
                stations={stations}
                units={units}
                queue={queue}
                requests={requests}
                simNow={simNow}
                selectedId={selectedId}
                onSelect={setSelectedId}
                loading={!conn.ready}
                stale={stale}
              />
            </aside>
            <section className="min-h-0">
              {conn.ready ? (
                <IncidentMap
                  styleUrl={ENV.mapStyleUrl}
                  grid={grid}
                  simNow={simNow}
                  fireCells={fireCells}
                  forecastCells={forecastCells}
                  closures={closures}
                  stations={stations}
                  units={units}
                  requests={requests}
                  queue={queue}
                  selectedId={selectedId}
                  onSelectRequest={setSelectedId}
                  closureMode={drawing && !draft}
                  onClosurePoints={(a, b) => setDraft([a, b])}
                />
              ) : (
                <Skeleton className="h-full w-full rounded-frame" />
              )}
            </section>
            <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
              <WindControl
                weather={weather}
                onCommit={(speed, dir) =>
                  void setWeather.run({ windSpeedMps: speed, windFromDeg: dir, gustMps: speed, source: 'manual' })
                }
                onRelease={FEATURES.release_weather_lock ? () => void releaseWind.run({}) : undefined}
                pending={setWeather.pending || releaseWind.pending}
                disabled={disabled}
                stale={stale}
              />
              <FlagsPanel
                flags={openFlags}
                onResolve={async (flagId, resolution) => {
                  setResolvingId(flagId);
                  await resolve.run({ flagId: BigInt(flagId), resolution });
                  setResolvingId(null);
                }}
                onSelectRequest={setSelectedId}
                pendingId={resolvingId}
                disabled={disabled}
              />
              <ClosurePanel
                closures={closures}
                drawing={drawing}
                draftReady={!!draft}
                onStart={() => {
                  setDraft(null);
                  setDrawing(true);
                }}
                onCancel={() => {
                  setDrawing(false);
                  setDraft(null);
                }}
                onSave={async name => {
                  if (!draft) return;
                  const [a, b] = draft;
                  const ok = await addClosure.run({ name, lat1: a[1], lon1: a[0], lat2: b[1], lon2: b[0], source: 'manual' });
                  if (ok) {
                    setDrawing(false);
                    setDraft(null);
                  }
                }}
                saving={addClosure.pending}
                onToggle={
                  FEATURES.set_road_closure_active
                    ? (id, active) => void toggleClosure.run({ id: BigInt(id), active })
                    : undefined
                }
                disabled={disabled}
              />
              <EventLog events={events} onFocusRequest={setSelectedId} />
            </aside>
          </div>
        )}
      </div>
      <RequestDrawer
        open={selectedId !== null}
        onOpenChange={open => {
          if (!open) setSelectedId(null);
        }}
        request={selected}
        queue={selectedQueue}
        travel={selectedTravel}
        flags={selectedFlags}
        stations={stations}
        units={units}
        simNow={simNow}
        onPin={(stationId, note) => {
          if (selected) void pin.run({ requestId: selected.id, stationId, note });
        }}
        onFlag={(kind, detail) => {
          if (selected) void flag.run({ requestId: selected.id, kind, detail });
        }}
        pinPending={pin.pending}
        flagPending={flag.pending}
        disabled={disabled}
      />
    </GuideProvider>
  );
}
