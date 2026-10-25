export type GuideScreen = 'help' | 'command' | 'crew';

/**
 * step: Next, the arrow keys or the wheel over the tip advance (the desktop map doesn't scroll).
 * scroll: the anchor crossing the middle of the viewport is the active step (phones, scrolling panels).
 */
export type GuideMode = 'step' | 'scroll';

export type GuideStep<S = unknown> = {
  /** data-guide id of the element to spotlight, e.g. "cmd.wind". Shown as the tip's mono tag. */
  anchor: string;
  /** 2 to 5 words. */
  title: string;
  /** At most 2 sentences. Never states data values (counts, times, positions). */
  body: string;
  /** One line on a further use, e.g. "Try: drag wind to 25 m/s from 300°". */
  tryIt?: string;
  /** Gates the step on live data; while false the step is skipped. Never fed sample data. */
  requires?: (state: S) => boolean;
};
