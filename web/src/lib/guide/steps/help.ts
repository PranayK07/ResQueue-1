import type { GuideStep } from '../types';

/** Live state the /help steps may gate on. */
export type HelpGuideState = { status: string };

/** Scroll-mode steps for /help, written in phase 5. Anchors: help.card.position, help.card.reason, help.card.crew, help.card.consent, help.card.safe. */
export const helpSteps: GuideStep<HelpGuideState>[] = [];
