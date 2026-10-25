import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { CONSENT_DEFAULT, CONSENT_MAX, CONSENT_MIN } from '@/lib/domain/limits';
import type { Need } from '@/lib/domain/needs';
import { isActiveStatus } from '@/lib/domain/status';
import { FEATURES } from '@/lib/features';
import { hasScenario, insideGrid, type LatLon } from '@/lib/geo/grid';
import { GuidancePill, GuideProvider } from '@/lib/guide';
import { helpSteps } from '@/lib/guide/steps/help';
import { useCall, useConnection, useSingleton, useView, type ResidentCard } from '@/lib/stdb';
import { formatClock, minsFromNow, tsToMs, useNow, useSimNow } from '@/lib/time/sim';
import { ConnectionBanner } from '@/lib/ui/ConnectionBanner';
import { CardSkeleton } from './components/card/CardSkeleton';
import { ConsentTimer } from './components/card/ConsentTimer';
import { SafeActions } from './components/card/SafeActions';
import { StatusCard } from './components/card/StatusCard';
import { DemoPersonaBanner } from './components/entry/DemoPersonaBanner';
import { HelpButton } from './components/entry/HelpButton';
import { HelpHeader } from './components/entry/HelpHeader';
import { LocationProblem } from './components/entry/LocationProblem';
import { RequestsClosed } from './components/entry/RequestsClosed';
import { ConsentSheet } from './components/request/ConsentSheet';
import { DescribeStep } from './components/request/DescribeStep';
import { composeSubmission, intakeEnabled, parsedNeeds, parseIntake, type IntakeResult } from './intake';
import { devicePersona, personaHome } from './personas';

const BANNER_COPY = {
  offline: "No connection. Your request can't be sent. Call 911.",
  reconnecting: "Reconnecting. Your request can't be sent right now. Call 911 if you need help now.",
  error: "Can't reach the server. Call 911 if you need help now.",
};

const INTAKE_DEBOUNCE_MS = 600;

type Step = 'idle' | 'consent' | 'describe';
type Problem = 'denied' | 'unavailable' | 'outside';

/** Newest active request by createdAt; if none is active, the newest closed one. */
function pickCard(rows: readonly ResidentCard[]): ResidentCard | undefined {
  const newest = [...rows].sort((a, b) => {
    const d = b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch;
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  return newest.find(r => isActiveStatus(r.status)) ?? newest[0];
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 });
  });
}

export function HelpPage() {
  const [params] = useSearchParams();
  const demo = params.get('demo') === '1';
  const conn = useConnection();
  const grid = useSingleton('grid');
  const cards = useView('my_requests');
  const simNow = useSimNow();
  const nowMs = useNow(1000);
  const card = useMemo(() => pickCard(cards), [cards]);
  const active = !!card && isActiveStatus(card.status);
  const scenario = hasScenario(grid);
  const { persona, fx, fy } = useMemo(() => devicePersona(), []);

  const [step, setStep] = useState<Step>('idle');
  const [minutes, setMinutes] = useState<number>(CONSENT_DEFAULT);
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [personaChosen, setPersonaChosen] = useState(false);
  // The location lives only here: never logged, never stored.
  const location = useRef<LatLon | null>(null);
  const [note, setNote] = useState('');
  const [headcount, setHeadcount] = useState(1);
  const [needs, setNeeds] = useState<Need[]>([]);
  const fieldsEdited = useRef(false);
  const [parsed, setParsed] = useState<IntakeResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [closing, setClosing] = useState<'safe' | 'revoked' | null>(null);

  const submit = useCall('submit_help_request');
  const close = useCall('close_my_request');
  const extend = useCall('extend_consent');
  const usingPersona = demo || personaChosen;

  function resetFlow() {
    setStep('idle');
    setNote('');
    setHeadcount(1);
    setNeeds([]);
    setParsed(null);
    setProblem(null);
    fieldsEdited.current = false;
    location.current = null;
  }

  async function shareAndContinue() {
    setProblem(null);
    if (usingPersona && grid) {
      location.current = personaHome(grid, fx, fy);
      setStep('describe');
      return;
    }
    setLocating(true);
    try {
      const pos = await getPosition();
      const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      if (!insideGrid(here.lat, here.lon, grid)) {
        setProblem('outside');
        return;
      }
      location.current = here;
      setStep('describe');
    } catch (e) {
      setProblem((e as GeolocationPositionError | undefined)?.code === 1 ? 'denied' : 'unavailable');
    } finally {
      setLocating(false);
    }
  }

  function usePersonaInstead() {
    setPersonaChosen(true);
    setProblem(null);
    if (grid) {
      location.current = personaHome(grid, fx, fy);
      setStep('describe');
    }
  }

  async function send() {
    const here = location.current;
    if (!here) {
      setStep('consent');
      return;
    }
    const text = note.trim();
    const usable = parsed && parsed.note === text ? parsed : null;
    const body = composeSubmission(text, needs, usable);
    const ok = await submit.run({ lat: here.lat, lon: here.lon, headcount, needs: body.needs, note: body.note, consentMinutes: minutes });
    if (ok) resetFlow();
  }

  async function closeRequest(outcome: 'safe' | 'revoked') {
    if (!card) return;
    setClosing(outcome);
    await close.run({ requestId: card.requestId, externalRef: '', outcome });
    setClosing(null);
  }

  // Intake runs while the person types (debounced). Send never waits for it.
  useEffect(() => {
    if (!intakeEnabled() || step !== 'describe') return;
    const text = note.trim();
    if (text.length < 3) {
      setParsed(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setParsing(true);
      void parseIntake(text, undefined, ctrl.signal).then(result => {
        if (ctrl.signal.aborted) return;
        setParsing(false);
        setParsed(result);
        if (result.source === 'claude' && !fieldsEdited.current) {
          setHeadcount(result.headcount);
          setNeeds(parsedNeeds(result));
        }
      });
    }, INTAKE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
      setParsing(false);
    };
  }, [note, step]);

  useEffect(() => {
    const e = submit.error;
    if (!e) return;
    if (e.kind === 'already_active') {
      // A request already exists for this phone: just show its card.
      resetFlow();
      submit.clearError();
    } else if (e.kind === 'outside_area') {
      setProblem('outside');
      setStep('consent');
      submit.clearError();
    } else if (e.kind !== 'field') {
      toast.error(e.copy);
    }
  }, [submit.error]);

  useEffect(() => {
    if (close.error) toast.error(close.error.copy);
  }, [close.error]);

  useEffect(() => {
    if (extend.error) toast.error(extend.error.copy);
  }, [extend.error]);

  // "Moved to <station>: <reason>" when the request changes stations.
  const lastStation = useRef<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!card) {
      lastStation.current = null;
      return;
    }
    const id = String(card.requestId);
    const prev = lastStation.current;
    if (prev && prev.id === id && prev.name && card.stationName && prev.name !== card.stationName) {
      toast(`Moved to ${card.stationName}: ${card.reason}`);
    }
    lastStation.current = { id, name: card.stationName };
  }, [card]);

  const etaMin = card?.etaS !== undefined && simNow !== undefined ? minsFromNow(card.etaS, simNow) : undefined;
  const grayed = conn.stale || conn.state === 'offline';
  const lastUpdated = conn.lastLiveAt !== null ? formatClock(conn.lastLiveAt) : undefined;
  const fieldError = submit.error?.kind === 'field' ? { field: submit.error.field, copy: submit.error.copy } : null;
  const intakeState = !intakeEnabled()
    ? null
    : parsing
      ? ({ state: 'parsing' } as const)
      : parsed?.source === 'claude' && parsed.note === note.trim()
        ? ({ state: 'filled' } as const)
        : null;
  const guideState = useMemo(() => ({ status: card?.status ?? '' }), [card?.status]);

  let content;
  if (!conn.ready) {
    content = (
      <>
        <CardSkeleton />
        <HelpButton onPress={() => {}} disabled label="Connecting..." />
      </>
    );
  } else if (active) {
    content = (
      <>
        <StatusCard card={card} etaMin={etaMin} stale={grayed} lastUpdated={lastUpdated} />
        <ConsentTimer
          expiresAtMs={tsToMs(card.consentExpiresAt)}
          nowMs={nowMs}
          canExtend={FEATURES.extend_consent && conn.canCall}
          onExtend={() => {
            // extend_consent resets expiry to now + minutes, so never send less than what's left.
            const left = Math.ceil((tsToMs(card.consentExpiresAt) - Date.now()) / 60_000);
            const minutes = Math.min(CONSENT_MAX, Math.max(CONSENT_MIN, left + CONSENT_DEFAULT));
            void extend.run({ requestId: card.requestId, externalRef: '', minutes });
          }}
          extending={extend.pending}
        />
        <SafeActions
          onSafe={() => void closeRequest('safe')}
          onStopSharing={() => void closeRequest('revoked')}
          pending={closing}
          disabled={!conn.canCall}
        />
      </>
    );
  } else if (!scenario) {
    content = <RequestsClosed />;
  } else if (step === 'describe') {
    content = (
      <DescribeStep
        note={note}
        onNoteChange={setNote}
        headcount={headcount}
        onHeadcountChange={n => {
          fieldsEdited.current = true;
          setHeadcount(n);
        }}
        needs={needs}
        onNeedsChange={n => {
          fieldsEdited.current = true;
          setNeeds(n);
        }}
        onSend={() => void send()}
        sending={submit.pending}
        disabled={!conn.canCall}
        fieldError={fieldError}
        suggestedLine={usingPersona ? persona.line : undefined}
        onUseSuggestion={usingPersona ? () => setNote(persona.line) : undefined}
        intake={intakeState}
      />
    );
  } else if (card) {
    content = <StatusCard card={card} etaMin={etaMin} stale={grayed} lastUpdated={lastUpdated} onAskAgain={() => setStep('consent')} />;
  } else {
    content = (
      <>
        {conn.tokenReset && (
          <p role="status" className="rounded-card border border-border bg-surface-2 px-3 py-2 text-sm text-muted-foreground">
            We can't find your earlier request on this phone.
          </p>
        )}
        <HelpButton onPress={() => setStep('consent')} disabled={!conn.canCall} />
      </>
    );
  }

  return (
    <GuideProvider screen="help" mode="scroll" steps={helpSteps} state={guideState} enabled={demo && !!card} autoStart={demo}>
      <div className="mx-auto flex min-h-dvh max-w-md flex-col">
        <HelpHeader />
        <main className="flex flex-1 flex-col gap-3 px-4 pt-3 pb-10">
          <ConnectionBanner copy={BANNER_COPY} />
          {(demo || personaChosen || problem === 'outside') && (
            <DemoPersonaBanner label={persona.label} reason={demo ? 'demo' : 'outside'} />
          )}
          <div className="flex justify-end empty:hidden">
            <GuidancePill />
          </div>
          {content}
        </main>
      </div>
      <ConsentSheet
        open={step === 'consent'}
        onOpenChange={open => {
          if (!open && step === 'consent') setStep('idle');
        }}
        minutes={minutes}
        onMinutesChange={setMinutes}
        onContinue={() => void shareAndContinue()}
        locating={locating}
        disabled={!conn.canCall}
        personaLabel={usingPersona ? persona.label : undefined}
        problem={
          problem ? (
            <LocationProblem
              kind={problem}
              onRetry={problem === 'outside' ? undefined : () => void shareAndContinue()}
              onUsePersona={problem === 'outside' || demo ? usePersonaInstead : undefined}
            />
          ) : undefined
        }
      />
    </GuideProvider>
  );
}
