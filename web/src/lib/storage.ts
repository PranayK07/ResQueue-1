// localStorage can throw (private mode, blocked or full storage), so every
// access goes through these wrappers and degrades to "nothing stored".

export function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/** Parse a stored JSON value, keeping it only if the guard accepts it. */
export function loadJSON<T>(key: string, guard: (v: unknown) => v is T): T | null {
  const raw = load(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveJSON(key: string, value: unknown): boolean {
  return save(key, JSON.stringify(value));
}
