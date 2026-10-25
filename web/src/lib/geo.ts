// Address lookup via Photon (OpenStreetMap geocoder, no API key).
// https://photon.komoot.io — fair-use public instance; debounce callers.

export interface Place {
  lat: number;
  lon: number;
  /** House number alone, shown on the map marker. Empty if unknown. */
  houseNumber: string;
  /** e.g. "184 Canyon View Lane" */
  street: string;
  /** e.g. "Canyon Meadows · El Dorado County, CA" */
  area: string;
}

const PHOTON = 'https://photon.komoot.io';

/** Demo incident area (agents/scenarios/paradise_demo.json), used to bias
 *  address search when the device location is unknown. */
export const INCIDENT_AREA = { lat: 39.76, lon: -121.62 };

// Addresses and streets only; skips rivers, parks, etc. when reverse geocoding.
const LAYERS = 'layer=house&layer=street';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

const US_STATES: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO',
  Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID',
  Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
  Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC',
};

function toPlace(f: PhotonFeature, at?: { lat: number; lon: number }): Place {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const us = p.countrycode === 'US';

  const street =
    p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.name ?? p.street ?? p.city ?? 'Dropped pin';

  let county = p.county;
  if (us && county && !/County|Parish|Borough/.test(county)) county += ' County';
  const state = us && p.state ? US_STATES[p.state] ?? p.state : p.state;
  const region = [county ?? p.city, state].filter(Boolean).join(', ');
  const neighbourhood = p.locality ?? p.district ?? (county ? p.city : undefined);
  const area = [neighbourhood, region || p.country].filter(Boolean).join(' · ');

  // For reverse lookups keep the exact spot the user chose, not the
  // centroid of the building/street that matched.
  return { lat: at?.lat ?? lat, lon: at?.lon ?? lon, houseNumber: p.housenumber ?? '', street, area };
}

export function coordsPlace(lat: number, lon: number): Place {
  return { lat, lon, houseNumber: '', street: 'Dropped pin', area: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
}

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<Place> {
  const res = await fetch(`${PHOTON}/reverse?lat=${lat}&lon=${lon}&limit=1&${LAYERS}`, { signal });
  if (!res.ok) throw new Error(`reverse geocode failed: ${res.status}`);
  const { features } = (await res.json()) as { features: PhotonFeature[] };
  return features.length ? toPlace(features[0], { lat, lon }) : coordsPlace(lat, lon);
}

export async function searchAddress(
  query: string,
  near: { lat: number; lon: number } | null,
  signal?: AbortSignal
): Promise<Place[]> {
  const bias = near ? `&lat=${near.lat}&lon=${near.lon}` : '';
  const res = await fetch(`${PHOTON}/api/?q=${encodeURIComponent(query)}&limit=5&${LAYERS}${bias}`, { signal });
  if (!res.ok) throw new Error(`address search failed: ${res.status}`);
  const { features } = (await res.json()) as { features: PhotonFeature[] };
  return features.map(f => toPlace(f));
}
