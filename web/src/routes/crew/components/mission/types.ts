// Shared types for the /crew mission region.

/** Keys for the mission buttons. The page passes the one in flight as `pending`. */
export type MissionAction = 'en_route' | 'on_scene' | 'rescued' | 'not_found' | 'aborted' | 'decline';

/** complete_mission outcomes. rescued and not_found close the request; aborted puts it back in the line. */
export type MissionOutcome = 'rescued' | 'not_found' | 'aborted';

/** Which actions the page allows right now (feature flags, data present). */
export type MissionCan = { enRoute: boolean; onScene: boolean; complete: boolean; decline: boolean };
