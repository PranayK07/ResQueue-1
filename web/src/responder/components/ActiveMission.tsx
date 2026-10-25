import { useState } from 'react';
import check from '../../assets/figma/responder/check.svg';
import flag from '../../assets/figma/responder/flag.svg';
import users from '../../assets/figma/responder/users.svg';
import { clockHMTz, etaMinutes, formatSlack, needLines, peopleLabel, requestCode, simToMs, type QueueItem } from '../../ops/derive';
import { useAddress } from '../../ops/hooks';
import type { SimClock } from '../../ops/types';
import { DangerLevelTag } from './DangerLevelTag';

interface Props {
  item: QueueItem;
  clock: SimClock;
  nowS: number;
  onScene: boolean;
  busy: boolean;
  error: string | null;
  onComplete: () => void;
  onCantReach: () => void;
}

/** The mission this unit is committed to, with the crew's actions. */
export function ActiveMission({ item, clock, nowS, onScene, busy, error, onComplete, onCantReach }: Props) {
  const { request } = item;
  const place = useAddress(request.id, request.lat, request.lon);
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="mission" aria-label={`Active mission ${requestCode(request.id)}`}>
      <p className="mission__eyebrow">
        ACTIVE MISSION · {item.unitCallsign} · {onScene ? 'ON SCENE' : 'EN ROUTE'}
      </p>
      <div className="mission__identity">
        <h2 className="mono">{requestCode(request.id)}</h2>
        <DangerLevelTag level={request.level} />
      </div>
      <div>
        <p className="mission__street">{place ? place.street : 'Finding address…'}</p>
        <p className="mission__area">{place ? place.area : `${request.lat.toFixed(4)}, ${request.lon.toFixed(4)}`}</p>
      </div>

      <div className="mission__facts">
        <div>
          <p className="mission__people">
            <img src={users} width={16} height={16} alt="" />
            {peopleLabel(request.headcount)}
          </p>
          {needLines(request).map(n => (
            <p key={n} className="mission__need">
              {n}
            </p>
          ))}
        </div>
        <div className={`slack-box slack-box--${request.level}`}>
          <p className="slack-box__label">Safety slack</p>
          <p className="slack-box__value">{formatSlack(request.slackS)}</p>
          <p className="slack-box__hint">Buffer, not an ETA</p>
        </div>
      </div>
      {request.note && <p className="mission__note">“{request.note}”</p>}
      <p className="mission__eta">
        {onScene ? 'On scene' : `ETA ${etaMinutes(item.etaS, nowS)} min · arrival ${clockHMTz(simToMs(clock, item.etaS))}`}
      </p>

      {confirming ? (
        <div className="mission__confirm" role="alertdialog" aria-label="Confirm can't reach">
          <p>Return {requestCode(request.id)} to the queue and flag it as unreachable by {item.unitCallsign}?</p>
          <div className="mission__actions">
            <button type="button" className="raction" onClick={() => setConfirming(false)} disabled={busy}>
              Keep mission
            </button>
            <button
              type="button"
              className="raction raction--danger"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onCantReach();
              }}
            >
              Return to queue
            </button>
          </div>
        </div>
      ) : (
        <div className="mission__actions">
          <button type="button" className="raction" onClick={() => setConfirming(true)} disabled={busy}>
            <img src={flag} width={16} height={16} alt="" />
            Can’t reach
          </button>
          <button type="button" className="raction raction--primary" onClick={onComplete} disabled={busy}>
            <img src={check} width={16} height={16} alt="" />
            {busy ? 'Saving…' : 'Mark complete'}
          </button>
        </div>
      )}
      {error && <p className="mission__error">{error}</p>}
    </section>
  );
}
