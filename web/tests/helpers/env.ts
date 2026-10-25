import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** OPERATOR_PASSCODE from the repo-root .env, read at runtime. Never hardcode or print it. */
export function operatorPasscode(): string {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url));
  const match = /^OPERATOR_PASSCODE=(.*)$/m.exec(readFileSync(path, 'utf8'));
  const value = match?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!value) throw new Error('OPERATOR_PASSCODE is missing from the repo-root .env');
  return value;
}
