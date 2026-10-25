import type { GuideStep } from '../types';

/** Live state the /command steps may gate on. */
export type CommandGuideState = { openFlags: number };

/**
 * Step-mode steps for /command. The copy states no counts, times, positions or sim speed: the screen shows those live.
 * cmd.drawer.pin lives inside the request drawer, which only renders while a request is open, so its tip may show
 * without a spotlight and says how to open it.
 */
export const commandSteps: GuideStep<CommandGuideState>[] = [
  {
    anchor: 'cmd.clock',
    title: 'Simulated clock',
    body: 'This is simulated time, and it can run faster than real time. Every fire forecast and arrival time on this screen is measured against it.',
  },
  {
    anchor: 'cmd.map.fire',
    title: 'Fire and forecast',
    body: 'Burning cells show where the simulated fire is now, and shaded bands show when it is forecast to reach each area. Request pins sit on top, colored by urgency.',
    tryIt: 'Try: click any pin to open that request.',
  },
  {
    anchor: 'cmd.queue',
    title: 'One line per station',
    body: 'Each station has its own line, ordered by who the fire is expected to reach first, not by who called first. A row shows headcount, needs, urgency and the crew assigned.',
    tryIt: 'Try: click a row to open the full request.',
  },
  {
    anchor: 'cmd.queue.reason',
    title: 'Reasons built in code',
    body: 'Each reason is built in code from the numbers behind the order, such as when the fire arrives and when a crew could. Claude never ranks anyone.',
  },
  {
    anchor: 'cmd.wind',
    title: 'Wind control',
    body: 'Wind decides how fast the simulated fire spreads and in which direction. Move it and the forecast changes, so the lines update from the new numbers.',
    tryIt: 'Try: drag the wind to 25 m/s from 300° and watch the lines re-order.',
  },
  {
    anchor: 'cmd.flags',
    title: 'Needs a decision',
    body: "Open flags wait here for a human decision, such as someone a ground crew can't reach in time. Resolving one only records your decision, since the simulation has no air units.",
    tryIt: "Try: click a flag's request number to open that request.",
    requires: s => s.openFlags > 0,
  },
  {
    anchor: 'cmd.drawer.pin',
    title: 'Pin to a station',
    body: 'A pin sends a request to the station you choose, and it beats the policy. A crew already sent is never pulled off.',
    tryIt: 'Try: open any request to see this, then pin it to a different station.',
  },
  {
    anchor: 'cmd.log',
    title: 'Decision log',
    body: 'Every decision is logged here so it can be reviewed later. Entries show which operator acted but carry no resident names or locations.',
    tryIt: 'Try: click a row that names a request to jump to it.',
  },
];
