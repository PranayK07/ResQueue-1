// Flags for the reducers the spec tags [confirm]. They are in the shapes contract
// (Evan's ruling, Oct 24), so every flag defaults ON. Set one to false to hide
// its control without touching screen code.

export type ConfirmReducer =
  | 'set_sim'
  | 'release_weather_lock'
  | 'set_road_closure_active'
  | 'extend_consent'
  | 'unit_en_route'
  | 'unit_on_scene'
  | 'complete_mission'
  | 'decline_mission'
  | 'unit_available';

export const FEATURES: Readonly<Record<ConfirmReducer, boolean>> = {
  set_sim: true,
  release_weather_lock: true,
  set_road_closure_active: true,
  extend_consent: true,
  unit_en_route: true,
  unit_on_scene: true,
  complete_mission: true,
  decline_mission: true,
  unit_available: true,
};
