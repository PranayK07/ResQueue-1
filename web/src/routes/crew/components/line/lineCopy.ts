/** "1 person" or "N people". */
export function peopleText(headcount: number): string {
  return headcount === 1 ? '1 person' : `${headcount} people`;
}

/** "N min before fire", or "Not assessed" when there is no forecast for the request yet. */
export function fireText(minutesBeforeFire: number | undefined): string {
  if (minutesBeforeFire === undefined || !Number.isFinite(minutesBeforeFire)) return 'Not assessed';
  return `${Math.max(0, Math.round(minutesBeforeFire))} min before fire`;
}
