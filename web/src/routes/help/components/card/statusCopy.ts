import type { ResidentCard } from '@/lib/stdb';

/** What the resident card says for one my_requests row. Never uses `level`. */
export type StatusCopy = {
  label: string;
  headline: string;
  detail?: string;
  etaText?: string;
  showEta: boolean;
  showReason: boolean;
  closed: boolean;
  askAgain: 'button' | 'link' | null;
};

const DEFAULT_LABEL = 'Your request';

/** "any minute now" at half a minute or less, otherwise "about N min" (never below 1). */
export function etaCopy(etaMin: number): string {
  return etaMin <= 0.5 ? 'any minute now' : `about ${Math.max(1, Math.round(etaMin))} min`;
}

/** The pending reason from the view, without a leading "Received." (the headline says it). */
function pendingDetail(reason: string): string | undefined {
  const rest = reason.replace(/^Received\.\s*/, '').trim();
  return rest === '' ? undefined : rest;
}

/** Copy by status (frontend-spec 4.1, StatusCard table). Pure: no clock, no I/O. */
export function statusCopy(card: ResidentCard, etaMin: number | undefined): StatusCopy {
  const base: StatusCopy = {
    label: DEFAULT_LABEL,
    headline: card.status,
    showEta: false,
    showReason: false,
    closed: false,
    askAgain: null,
  };
  // Defensive only: an active crew status should always carry a callsign and a station.
  const crew = card.unitCallsign !== '' ? card.unitCallsign : 'A crew';
  const station = card.stationName;

  let copy: StatusCopy;
  switch (card.status) {
    case 'pending':
      copy = { ...base, headline: 'Received', detail: pendingDetail(card.reason) };
      break;
    case 'queued':
      copy = {
        ...base,
        label: 'Your place in line',
        headline: card.queuePosition > 0 ? `#${card.queuePosition} in line` : 'In line',
        detail: station !== '' ? `at ${station}` : undefined,
        showEta: true,
        showReason: true,
      };
      break;
    case 'assigned':
      copy = {
        ...base,
        headline: station !== '' ? `${crew} from ${station} is assigned to you` : `${crew} is assigned to you`,
        showEta: true,
        showReason: true,
      };
      break;
    case 'en_route':
      copy = { ...base, headline: `${crew} is on the way`, showEta: true };
      break;
    case 'on_scene':
      copy = { ...base, headline: `${crew} is at your location` };
      break;
    case 'rescued':
      copy = { ...base, headline: 'Marked rescued. Your location was deleted.', closed: true, askAgain: 'link' };
      break;
    case 'not_found':
      copy = {
        ...base,
        headline: "The crew couldn't find you. Ask again or call 911.",
        closed: true,
        askAgain: 'button',
      };
      break;
    case 'safe':
      copy = {
        ...base,
        headline: 'You closed this request. Your location was deleted.',
        closed: true,
        askAgain: 'link',
      };
      break;
    case 'revoked':
      copy = {
        ...base,
        headline: 'You stopped sharing. Location deleted, request closed.',
        closed: true,
        askAgain: 'link',
      };
      break;
    case 'expired':
      copy = {
        ...base,
        headline: 'Your sharing window ended. Location deleted. Ask again if you still need help.',
        closed: true,
        askAgain: 'button',
      };
      break;
    default:
      copy = base;
  }

  if (copy.showEta && etaMin !== undefined && Number.isFinite(etaMin)) {
    copy.etaText = etaCopy(etaMin);
  }
  return copy;
}
