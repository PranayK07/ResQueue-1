import { useId, type FormEvent, type ReactNode } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { NOTE_MAX } from '@/lib/domain/limits';
import type { Need } from '@/lib/domain/needs';
import { Button } from '@/lib/ui/button';
import { Label } from '@/lib/ui/label';
import { Textarea } from '@/lib/ui/textarea';
import { FieldError } from './FieldError';
import { HeadcountStepper } from './HeadcountStepper';
import { NeedsPicker } from './NeedsPicker';

/** The character counter appears past this length. */
const COUNTER_FROM = 400;

export type DescribeStepProps = {
  note: string;
  onNoteChange: (s: string) => void;
  headcount: number;
  onHeadcountChange: (n: number) => void;
  needs: Need[];
  onNeedsChange: (n: Need[]) => void;
  onSend: () => void;
  sending: boolean;
  /** Blocks Send, e.g. when the connection isn't live. Fields stay editable. */
  disabled: boolean;
  /** Mapped module error for one field, shown under it. */
  fieldError?: { field: 'headcount' | 'note'; copy: string } | null;
  /** Demo persona's suggested line. Needs onUseSuggestion too. */
  suggestedLine?: string;
  onUseSuggestion?: () => void;
  /** Claude intake status. null or undefined means no AI ran, so no AI UI at all. */
  intake?: { state: 'parsing' | 'filled' } | null;
  /** Any other error, rendered as given above Send. Bring its own role="alert". */
  problem?: ReactNode;
};

/** The note, headcount and needs, then Send. Send never waits on intake. */
export function DescribeStep({
  note,
  onNoteChange,
  headcount,
  onHeadcountChange,
  needs,
  onNeedsChange,
  onSend,
  sending,
  disabled,
  fieldError,
  suggestedLine,
  onUseSuggestion,
  intake,
  problem,
}: DescribeStepProps) {
  const noteId = useId();
  const noteErrorId = useId();
  const counterId = useId();
  const headcountErrorId = useId();

  const noteError = fieldError?.field === 'note' ? fieldError.copy : null;
  const headcountError = fieldError?.field === 'headcount' ? fieldError.copy : null;
  const showCounter = note.length > COUNTER_FROM;
  const showSuggestion = !!suggestedLine && !!onUseSuggestion && note !== suggestedLine;
  const noteDescribedBy =
    [noteError ? noteErrorId : null, showCounter ? counterId : null].filter(Boolean).join(' ') || undefined;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!disabled && !sending) onSend();
  };

  return (
    <form noValidate onSubmit={submit} aria-busy={sending || undefined} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor={noteId}>Anything crews should know?</Label>
          {showCounter && (
            <span id={counterId} className="mono-tag text-muted-foreground">
              {note.length}/{NOTE_MAX}
            </span>
          )}
        </div>
        <Textarea
          id={noteId}
          rows={2}
          maxLength={NOTE_MAX}
          value={note}
          onChange={e => onNoteChange(e.target.value)}
          readOnly={sending}
          placeholder="me and my husband, he's in a wheelchair, no car"
          aria-invalid={noteError ? true : undefined}
          aria-describedby={noteDescribedBy}
          className="max-h-40"
        />
        {noteError && <FieldError id={noteErrorId}>{noteError}</FieldError>}
        {showSuggestion && (
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-12 self-start px-4"
            disabled={sending}
            onClick={onUseSuggestion}
          >
            Use the persona's line
          </Button>
        )}
      </div>

      {intake && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          {intake.state === 'parsing' ? (
            <LoaderCircle className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-4 shrink-0" aria-hidden />
          )}
          {intake.state === 'parsing' ? 'Reading your note...' : "Filled in from your note. Change anything that's wrong."}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <HeadcountStepper
          value={headcount}
          onChange={onHeadcountChange}
          disabled={sending}
          describedBy={headcountError ? headcountErrorId : undefined}
        />
        {headcountError && <FieldError id={headcountErrorId}>{headcountError}</FieldError>}
      </div>

      <NeedsPicker value={needs} onChange={onNeedsChange} disabled={sending} />

      {problem}

      <Button type="submit" className="h-14 w-full text-base" disabled={disabled || sending}>
        {sending ? (
          <>
            <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden />
            Sending...
          </>
        ) : (
          'Send'
        )}
      </Button>
    </form>
  );
}
