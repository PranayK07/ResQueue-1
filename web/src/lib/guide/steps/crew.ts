import type { GuideStep } from '../types';

/** Live state the /crew steps may gate on. */
export type CrewGuideState = { hasMission: boolean };

const onMission = (s: CrewGuideState) => s.hasMission;

/**
 * Scroll-mode steps for /crew. The mission steps wait for a current mission; the line and alerts always apply.
 * The copy states no counts, times or request numbers: the screen shows those live.
 */
export const crewSteps: GuideStep<CrewGuideState>[] = [
  {
    anchor: 'crew.alerts',
    title: 'Alerts appear here',
    body: "Banners flag a new assignment, a request the resident closed, a request that became more urgent, or a lost connection. When offline, taps won't send, so use the radio.",
  },
  {
    anchor: 'crew.mission.time',
    title: 'Minutes before fire',
    body: 'How long until the simulated fire is forecast to reach this person, with an urgency badge beside it. It updates as the forecast changes.',
    requires: onMission,
  },
  {
    anchor: 'crew.mission.needs',
    title: 'Headcount and needs',
    body: 'How many people are there, what they need, and their own note if they left one. Use it to prepare before you arrive.',
    requires: onMission,
  },
  {
    anchor: 'crew.mission.actions',
    title: 'Mission buttons',
    body: "These move the mission forward, from en route to on scene to rescued. Each tap updates the resident's phone right away, and a button spins until the system confirms.",
    requires: onMission,
  },
  {
    anchor: 'crew.line',
    title: "Who's next",
    body: "Everyone waiting at this station, ordered by who the fire is expected to reach first. Crews can't reorder it, and it updates live as conditions change.",
  },
];
