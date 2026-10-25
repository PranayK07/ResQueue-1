// Input limits enforced by the module (createRequest, extend_consent, set_weather, set_sim).

export const HEADCOUNT_MIN = 1;
export const HEADCOUNT_MAX = 50;
export const NOTE_MAX = 500;

export const CONSENT_MIN = 15;
export const CONSENT_MAX = 240;
/** Choices offered in the consent sheet (spec 4.1). */
export const CONSENT_OPTIONS = [30, 60, 120, 240] as const;
export const CONSENT_DEFAULT = 60;

/** The UI slider range; the module accepts 0 to under 80 m/s. */
export const WIND_SPEED_MAX_UI = 40;
/** set_sim accepts a speed above 0 and up to 600. */
export const SIM_SPEED_MAX = 600;
