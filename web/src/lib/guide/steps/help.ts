import { isActiveStatus } from '@/lib/domain/status';
import type { GuideStep } from '../types';

/** Live state the /help steps may gate on. */
export type HelpGuideState = { status: string };

/** Passes while the card's request status is one of `statuses`. */
const whenStatus =
  (...statuses: string[]) =>
  (s: HelpGuideState) =>
    statuses.includes(s.status);

/**
 * Scroll-mode steps for /help. They run in demo mode only, after a request exists (HelpPage gates that).
 * Each step also waits for the card states where its anchor is on screen (statusCopy.ts, HelpPage.tsx), so the
 * tour never points at a part that isn't there. The copy names no station, crew, place or time: the card shows those live.
 */
export const helpSteps: GuideStep<HelpGuideState>[] = [
  {
    anchor: 'help.card.position',
    title: 'Your place in line',
    body: "This shows where you stand in your station's line. The line is ordered by who the simulated fire is expected to reach first, not by who asked first.",
    tryIt: 'Try: change the wind on the command screen and watch whether your place moves.',
    requires: whenStatus('queued'),
  },
  {
    anchor: 'help.card.crew',
    title: 'Crew and arrival',
    body: "Your crew's estimated arrival and status. The station and crew named above update live, and the time is a simulated estimate, not live tracking.",
    requires: whenStatus('queued', 'assigned', 'en_route'),
  },
  {
    anchor: 'help.card.reason',
    title: "Why you're here",
    body: 'This explains why you are at this station and place in line. It is written in code from the queue numbers, not invented.',
    requires: whenStatus('queued', 'assigned'),
  },
  {
    anchor: 'help.card.consent',
    title: 'Your sharing window',
    body: 'This is how long your location stays shared with incident command and responders. It is deleted when the request closes or the time runs out.',
    tryIt: 'Try: tap Extend to keep sharing for longer.',
    requires: s => isActiveStatus(s.status),
  },
  {
    anchor: 'help.card.safe',
    title: 'Closing your request',
    body: "Tap I'm safe now when you no longer need help, or Stop sharing to cancel. Either one closes your request, deletes your location and releases any crew on the way.",
    requires: s => isActiveStatus(s.status),
  },
];
