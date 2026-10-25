import type { GuideStep } from '../types';

/** Live state the /command steps may gate on. */
export type CommandGuideState = { openFlags: number };

/** Step-mode steps for /command, written in phase 5. Anchors: cmd.clock, cmd.map.fire, cmd.queue, cmd.queue.reason, cmd.wind, cmd.flags, cmd.drawer.pin, cmd.log. */
export const commandSteps: GuideStep<CommandGuideState>[] = [];
