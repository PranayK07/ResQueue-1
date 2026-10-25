// Claude intake client (shapes: POST /api/intake). Off unless VITE_INTAKE_URL is set.
// It runs while the person types; Send never waits for it.
import { NOTE_MAX } from '@/lib/domain/limits';
import { joinNeeds, parseNeeds, type Need } from '@/lib/domain/needs';
import { ENV } from '@/lib/env';

export type IntakeResult = {
  headcount: number;
  needs: string;
  note: string;
  language: string;
  summary: string;
  source: 'claude' | 'fallback';
};

const TIMEOUT_MS = 3000;

export const intakeEnabled = (): boolean => !!ENV.intakeUrl;

function fallback(note: string, headcount: number | undefined): IntakeResult {
  return { headcount: headcount ?? 1, needs: '', note, language: 'unknown', summary: '', source: 'fallback' };
}

/** Parse a note. Never rejects: on timeout (3 s) or any error it returns the shapes' fallback. */
export async function parseIntake(note: string, headcount: number | undefined, signal?: AbortSignal): Promise<IntakeResult> {
  if (!ENV.intakeUrl) return fallback(note, headcount);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(ENV.intakeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note, headcount }),
      signal: ctrl.signal,
    });
    if (!res.ok) return fallback(note, headcount);
    const body = (await res.json()) as Partial<IntakeResult>;
    if (typeof body.headcount !== 'number' || typeof body.needs !== 'string') return fallback(note, headcount);
    return {
      headcount: Math.min(50, Math.max(1, Math.round(body.headcount))),
      needs: body.needs,
      note,
      language: typeof body.language === 'string' ? body.language : 'unknown',
      summary: typeof body.summary === 'string' ? body.summary : '',
      source: body.source === 'claude' ? 'claude' : 'fallback',
    };
  } catch {
    return fallback(note, headcount);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Needs from a Claude parse, for prefilling the editable chips. */
export function parsedNeeds(result: IntakeResult): Need[] {
  return result.source === 'claude' ? parseNeeds(result.needs) : [];
}

/**
 * What gets submitted (shapes): add "language" to needs when the parse found a
 * language other than en, and send note = summary + " | " + original, cut to 500.
 * Pass parsed only if it was made from the current note.
 */
export function composeSubmission(original: string, needs: readonly Need[], parsed: IntakeResult | null): { note: string; needs: string } {
  const claude = parsed?.source === 'claude' ? parsed : null;
  const list: string[] = [...needs];
  if (claude && claude.language !== 'en' && claude.language !== 'unknown') list.push('language');
  const note = claude?.summary ? `${claude.summary} | ${original}` : original;
  return { note: note.slice(0, NOTE_MAX), needs: joinNeeds(list) };
}
