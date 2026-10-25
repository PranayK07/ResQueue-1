import type { Place } from './geo';

// ─── Caller-side request model ──────────────────────────────────────────────
// Everything here lives on the device until the caller sends. Field names line
// up with submit_help_request (headcount, needs, note) so wiring the backend
// later is a mapping, not a redesign.

export type Need = 'mobility' | 'medical' | 'oxygen' | 'infant' | 'pets';

export const NEED_LABELS: Record<Need, { form: string; summary: string }> = {
  mobility: { form: 'Wheelchair or mobility help', summary: 'wheelchair' },
  medical: { form: 'Medical needs', summary: 'medical' },
  oxygen: { form: 'Oxygen', summary: 'oxygen' },
  infant: { form: 'Infant', summary: 'infant' },
  pets: { form: 'Pets', summary: 'pets' },
};

export type MediaStatus = 'local' | 'uploading' | 'shared' | 'failed';

export interface MediaItem {
  id: string;
  name: string;
  kind: 'photo' | 'video';
  durationS: number | null;
  status: MediaStatus;
}

export interface Details {
  headcount: number;
  needs: Need[];
  note: string;
  media: MediaItem[];
}

export interface CallerLocation extends Place {
  /** Free-text entrance correction, e.g. "Front entrance". */
  entrance: string;
}

export interface Dispatch {
  station: string;
  unit: string;
  queueRank: number;
  busyMin: number;
  travelMin: number;
  fire: string;
}

export type Phase = 'sending' | 'offline' | 'assigned' | 'en_route';

export interface HelpRequest {
  /** Idempotency token: every retry of this request reuses it. */
  token: string;
  /** Three-digit number shared by the local ref (L-018) and ticket (Q018). */
  number: string;
  location: CallerLocation;
  details: Details;
  phase: Phase;
  createdAt: number;
  /** Set once the system confirms receipt. */
  receivedAt: number | null;
  updatedAt: number;
  /** Absolute time (ms) a unit is expected on scene. */
  arrivalAt: number | null;
  sharedUntil: number | null;
  dispatch: Dispatch | null;
  /** Last time the system confirmed a location update for this request. */
  locationUpdatedAt: number | null;
}

export const CONSENT_MINUTES = 60;

export const EMPTY_DETAILS: Details = { headcount: 1, needs: [], note: '', media: [] };

export function newRequest(location: CallerLocation, details: Details): HelpRequest {
  const now = Date.now();
  return {
    token: crypto.randomUUID(),
    number: String(Math.floor(Math.random() * 900) + 100).padStart(3, '0'),
    location,
    details,
    phase: 'sending',
    createdAt: now,
    receivedAt: null,
    updatedAt: now,
    arrivalAt: null,
    sharedUntil: null,
    dispatch: null,
    locationUpdatedAt: null,
  };
}

export const localRef = (r: HelpRequest) => `L-${r.number}`;
export const ticket = (r: HelpRequest) => `Q${r.number}`;

// ─── Formatting ─────────────────────────────────────────────────────────────

const clockFmt = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

/** "14:32 PDT" */
export const clock = (ms: number) => clockFmt.format(ms);

export function ordinal(n: number) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

export function formatDuration(s: number) {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const MEDIA_STATUS: Record<MediaStatus, string> = {
  local: 'Waiting',
  uploading: 'Sending…',
  shared: 'Shared',
  failed: 'Not sent',
};

/** "entrance.mp4 · 0:08 · Shared" */
export function mediaLabel(m: MediaItem) {
  const duration = m.durationS !== null ? ` · ${formatDuration(m.durationS)}` : '';
  return `${m.name}${duration} · ${MEDIA_STATUS[m.status]}`;
}

export const failedMedia = (d: Details) => d.media.filter(m => m.status === 'failed');

/** "3 people · 1 wheelchair · pets" */
export function peopleSummary(d: Details) {
  const people = `${d.headcount} ${d.headcount === 1 ? 'person' : 'people'}`;
  return [people, ...d.needs.map(n => NEED_LABELS[n].summary)].join(' · ');
}

// ─── Persistence ────────────────────────────────────────────────────────────
// "Saved on this device": the active request survives a reload so a retry
// can reuse its token. Media file contents are not persisted, only names.

const STORAGE_KEY = 'wrq.request';

export function loadRequest(): HelpRequest | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as HelpRequest;
    // An upload interrupted by the reload never finished; queue it again.
    const media = r.details.media.map(m => (m.status === 'uploading' ? { ...m, status: 'local' as const } : m));
    return { ...r, details: { ...r.details, media } };
  } catch {
    return null;
  }
}

export function saveRequest(r: HelpRequest | null) {
  if (r) localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
  else localStorage.removeItem(STORAGE_KEY);
}
