import { insideIncidentArea, type IncidentArea } from '../lib/incidentArea';

export function IncidentAreaWarning({ area, point, onReturn }: {
  area?: IncidentArea | null;
  point: { lat: number; lon: number } | null;
  onReturn?: () => void;
}) {
  if (!area || !point || insideIncidentArea(area, point)) return null;
  return <div className="notice" role="alert">
    <p className="notice__title">Pin outside the incident area</p>
    <p className="notice__body">Move your pin back inside the incident area before confirming or sending this location.</p>
    {onReturn && <button type="button" className="incident-area-return" onClick={onReturn}>Return to incident area</button>}
  </div>;
}
