import chevronActive from '../../assets/figma/responder/chevron-right-active.svg';
import chevron from '../../assets/figma/responder/chevron-right.svg';
import { etaMinutes, formatSlack, needLines, peopleLabel, requestCode, type QueueItem } from '../../ops/derive';
import { DangerLevelTag } from './DangerLevelTag';

interface Props {
  item: QueueItem;
  nowS: number;
  /** This phone's committed mission. */
  active?: boolean;
  /** Its route is the one on the map. */
  onMap?: boolean;
  onOpen: () => void;
}

/** Queue card (Figma "Active mission" / "Ranked request"). */
export function RequestCard({ item, nowS, active = false, onMap = false, onOpen }: Props) {
  const { request } = item;
  const needs = needLines(request);
  return (
    <button type="button" className={`rcard${active ? ' rcard--active' : ''} rcard--${request.level}`} onClick={onOpen}>
      {active && <span className="rcard__eyebrow">ACTIVE MISSION · {item.unitCallsign}</span>}
      <span className="rcard__identity">
        <span className="rcard__code">{requestCode(request.id)}</span>
        <img src={active ? chevronActive : chevron} width={16} height={16} alt="" />
      </span>
      <DangerLevelTag level={request.level} />
      <span className="rcard__clock">
        <span className="rcard__clock-label">Safety slack</span>
        <span className="rcard__slack">{formatSlack(request.slackS)}</span>
      </span>
      <span className="rcard__people">
        {peopleLabel(request.headcount)}
        {needs.map(n => (
          <span key={n}>
            <br />
            {n}
          </span>
        ))}
      </span>
      <span className="rcard__eta">
        <strong>ETA {etaMinutes(item.etaS, nowS)} min</strong>
        <span>{item.committed && !active ? `${item.unitCallsign} en route` : item.unitCallsign}</span>
      </span>
      {active && onMap && <span className="rcard__note">Selected · route on map</span>}
    </button>
  );
}
