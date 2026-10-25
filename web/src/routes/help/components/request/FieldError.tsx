import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';

type FieldErrorProps = {
  /** Point the field's aria-describedby at this id. */
  id: string;
  children: ReactNode;
};

/** Inline error under a form field. */
export function FieldError({ id, children }: FieldErrorProps) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
