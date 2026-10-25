import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { forgetOperator, login, setOperatorUnit, useOperator } from '@/lib/auth/operator';
import { isEscalated } from '@/lib/domain/levels';
import { isAgentOnline } from '@/lib/domain/status';
import { ENV } from '@/lib/env';
import { FEATURES } from '@/lib/features';
import { GuideProvider } from '@/lib/guide';
import { crewSteps } from '@/lib/guide/steps/crew';
import { mapCallError, useCall, useConnection, useSingleton, useTable, useView, type MappedError } from '@/lib/stdb';
import { formatClock, minsFromNow, useNow, useSimNow } from '@/lib/time/sim';
import { ResponderGate } from './components/gate/ResponderGate';
import { UnitPicker } from './components/gate/UnitPicker';
import { IdleCard } from './components/line/IdleCard';
import { ReturningCard } from './components/line/ReturningCard';
import { StationLine } from './components/line/StationLine';
import { AlertBanner } from './components/mission/AlertBanner';
import { AlertStack } from './components/mission/AlertStack';
import { CrewHeader } from './components/mission/CrewHeader';
import { CurrentMission } from './components/mission/CurrentMission';

function useToastError(e: MappedError | null) {
  useEffect(() => {
    if (!e) return;
    if (e.kind === 'not_operator') forgetOperator('responder');
    toast.error(e.copy);
  }, [e]);
}

type Notice = { kind: 'assignment' | 'closed' | 'escalated'; requestId: string; level?: string };

export function CrewPage() {
  const conn = useConnection();
  const operator = useOperator('responder');
  const stations = useTable('station');
  const units = useTable('unit');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(name: string, passcode: string, stationId: number) {
    setPending(true);
    setError(null);
    try {
      await login(passcode, 'responder', stationId, name || 'responder');
    } catch (e) {
      setError(mapCallError(e).copy);
    } finally {
      setPending(false);
    }
  }

  const station = operator ? stations.find(s => s.id === operator.stationId) : undefined;
  const stationUnits = useMemo(() => (station ? units.filter(u => u.stationId === station.id) : []), [units, station]);
  const unit = operator && operator.unitId !== 0 ? stationUnits.find(u => u.id === operator.unitId) : undefined;

  if (conn.ready && !operator) {
    return (
      <main className="mx-auto max-w-md bg-background">
        <ResponderGate stations={stations} onSubmit={(n, p, s) => void signIn(n, p, s)} pending={pending} error={error} disabled={!conn.canCall} />
      </main>
    );
  }
  if (conn.ready && operator && station && !unit) {
    return (
      <main className="mx-auto max-w-md bg-background">
        <UnitPicker stationName={station.name} units={stationUnits} onPick={setOperatorUnit} onSignOut={() => forgetOperator('responder')} />
      </main>
    );
  }
  return <CrewWorkspace stationName={station?.name ?? ''} stationId={operator?.stationId ?? 0} unitId={unit?.id ?? 0} />;
}

function CrewWorkspace({ stationName, stationId, unitId }: { stationName: string; stationId: number; unitId: number }) {
  const conn = useConnection();
  const grid = useSingleton('grid');
  const stations = useTable('station');
  const units = useTable('unit');
  const fireCells = useTable('fire_cell');
  const closures = useTable('road_closure');
  const agents = useTable('agent');
  const requests = useView('ops_request');
  const queue = useView('ops_queue');
  const simNow = useSimNow();
  const nowMs = useNow(5000);

  const unit = units.find(u => u.id === unitId);
  const station = stations.find(s => s.id === stationId);
  const mission = unit && unit.currentRequest !== 0n ? requests.find(r => r.id === unit.currentRequest) : undefined;
  const missionQueue = mission ? queue.find(q => q.requestId === mission.id) : undefined;

  const enRoute = useCall('unit_en_route');
  const onScene = useCall('unit_on_scene');
  const complete = useCall('complete_mission');
  const decline = useCall('decline_mission');
  const available = useCall('unit_available');
  const [busy, setBusy] = useState<string | null>(null);

  useToastError(enRoute.error);
  useToastError(onScene.error);
  useToastError(complete.error);
  useToastError(decline.error);
  useToastError(available.error);

  async function act(key: string, run: () => Promise<boolean>) {
    setBusy(key);
    await run();
    setBusy(null);
  }

  // Alerts from transitions: a new assignment, the resident closing it, escalation.
  const [notice, setNotice] = useState<Notice | null>(null);
  const prev = useRef<{ status?: string; request: bigint; level?: string }>({ request: 0n });
  useEffect(() => {
    if (!unit) return;
    const before = prev.current;
    const level = mission?.level;
    if (unit.status === 'assigned' && before.status !== undefined && before.status !== 'assigned' && unit.currentRequest !== 0n) {
      setNotice({ kind: 'assignment', requestId: String(unit.currentRequest) });
      try {
        navigator.vibrate?.(200);
      } catch {
        // Vibration not allowed here.
      }
    } else if (before.request !== 0n && unit.currentRequest === 0n && unit.status === 'available' && !requests.some(r => r.id === before.request)) {
      setNotice({ kind: 'closed', requestId: String(before.request) });
    } else if (mission && level && level !== before.level && isEscalated(level) && before.request === mission.id) {
      setNotice({ kind: 'escalated', requestId: String(mission.id), level });
    }
    prev.current = { status: unit.status, request: unit.currentRequest, level };
  }, [unit, mission, requests]);

  const stationAgentOnline = agents.some(a => a.role === 'station' && a.stationId === stationId && isAgentOnline(a.lastSeen, nowMs));
  const offline = conn.state === 'offline' || conn.state === 'reconnecting' || conn.state === 'error';
  const disabled = !conn.canCall;
  const stale = conn.stale || conn.state === 'offline';

  const lineRows = useMemo(
    () =>
      queue
        .filter(q => q.stationId === stationId && (!mission || q.requestId !== mission.id))
        .sort((a, b) => a.rank - b.rank)
        .map(q => {
          const r = requests.find(x => x.id === q.requestId);
          return {
            requestId: String(q.requestId),
            rank: q.rank,
            headcount: r?.headcount ?? 0,
            needs: r?.needs ?? '',
            minutesBeforeFire: r?.fireEtaS !== undefined && simNow !== undefined ? minsFromNow(r.fireEtaS, simNow) : undefined,
            level: r?.level ?? 'unknown',
          };
        }),
    [queue, requests, stationId, mission, simNow]
  );
  const guideState = useMemo(() => ({ hasMission: !!mission }), [mission]);

  return (
    <GuideProvider screen="crew" mode="scroll" steps={crewSteps} state={guideState} enabled={conn.ready}>
      <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-background">
        <CrewHeader stationName={stationName} unit={unit} onSwitchUnit={() => setOperatorUnit(0)} />
        <main className="flex flex-1 flex-col gap-3 px-4 pt-3 pb-10">
          <AlertStack>
            {offline && <AlertBanner kind="offline" />}
            {notice && <AlertBanner kind={notice.kind} requestId={notice.requestId} level={notice.level} onDismiss={() => setNotice(null)} />}
            {stationAgentOnline && <AlertBanner kind="agent" />}
          </AlertStack>
          {unit && mission ? (
            <CurrentMission
              request={mission}
              unit={unit}
              simNow={simNow}
              styleUrl={ENV.mapStyleUrl}
              grid={grid}
              fireCells={fireCells}
              closures={closures}
              pending={busy}
              disabled={disabled}
              can={{
                // En route needs the queue ETA to send arriveAtS.
                enRoute: FEATURES.unit_en_route && !!missionQueue && simNow !== undefined,
                onScene: FEATURES.unit_on_scene,
                complete: FEATURES.complete_mission,
                decline: FEATURES.decline_mission,
              }}
              onEnRoute={() => {
                if (!missionQueue || simNow === undefined) return;
                const arriveAtS = missionQueue.etaS;
                // Ruling R4: load time plus a return trip as long as the trip out.
                const freeAtS = arriveAtS + mission.extractS + (arriveAtS - simNow);
                void act('en_route', () => enRoute.run({ unitId: unit.id, arriveAtS, freeAtS }));
              }}
              onOnScene={() => void act('on_scene', () => onScene.run({ unitId: unit.id }))}
              onComplete={outcome => void act(outcome, () => complete.run({ unitId: unit.id, outcome }))}
              onDecline={reason => void act('decline', () => decline.run({ unitId: unit.id, reason }))}
            />
          ) : unit?.status === 'returning' ? (
            <ReturningCard
              canAvailable={FEATURES.unit_available && !!station}
              onAvailable={() => {
                if (station) void act('available', () => available.run({ unitId: unit.id, lat: station.lat, lon: station.lon }));
              }}
              pending={busy === 'available'}
              disabled={disabled}
            />
          ) : (
            <IdleCard className={stale ? 'opacity-60 grayscale' : undefined} />
          )}
          <StationLine
            stationName={stationName}
            rows={lineRows}
            loading={!conn.ready}
            stale={stale}
            lastUpdated={conn.lastLiveAt !== null ? formatClock(conn.lastLiveAt) : undefined}
          />
        </main>
      </div>
    </GuideProvider>
  );
}
