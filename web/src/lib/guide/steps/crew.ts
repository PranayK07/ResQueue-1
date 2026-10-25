import type { GuideStep } from '../types';

/** Live state the /crew steps may gate on. */
export type CrewGuideState = { hasMission: boolean };

/** Scroll-mode steps for /crew, written in phase 5. Anchors: crew.mission.time, crew.mission.needs, crew.mission.actions, crew.line, crew.alerts. */
export const crewSteps: GuideStep<CrewGuideState>[] = [];
