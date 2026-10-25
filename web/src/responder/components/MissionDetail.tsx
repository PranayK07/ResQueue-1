import { useState } from 'react';
import arrowLeft from '../../assets/figma/responder/arrow-left.svg';
import check from '../../assets/figma/responder/check.svg';
import flag from '../../assets/figma/responder/flag.svg';
import users from '../../assets/figma/responder/users.svg';
import { clockHMTz, etaMinutes, formatSlack, needLines, peopleLabel, requestCode, simToMs, type QueueItem } from '../../ops/derive';
import type { SimClock } from '../../ops/types';
import { useAddress } from '../../ops/hooks';
import { DangerLevelTag } from './DangerLevelTag';

interface Props {
  item: QueueItem;
  /** This phone's committed mission: only then can the crew act on it. */
  mine: boolean;
  clock: SimClock;
  nowS: number;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onComplete: () => void;
  onCantReach: () => void;
}

/** Figma "Selected mission detail". */
export function MissionDetail({ item, mine, clock, nowS, busy, error, onBack, onComplete, onCantReach }: Props) {
  const { request } = item;
  const place = useAddress(request.id, request.lat, request.lon);
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="detail" aria-label={`Request ${requestCode(request.id)}`}>
      <button type="button" className="detail__back" onClick={onBack}>
        <img src={arrowLeft} width={16} height={16} alt="" />
        Back to queue
      </button>

      <div className="detail__body">
        <div className="detail__identity">
          <p className="detail__eyebrow">
            {mine ? `ACTIVE MISSION · ${item.unitCallsign}` : `RANK ${item.rank} · ${item.unitCallsign.toUpperCase()}`}
          </p>
          <h1 className="detail__code">{requestCode(request.id)}</h1>
          <DangerLevelTag level={request.level} />
        </div>

        <div className="detail__destination">
          <p className="detail__street">{place ? place.street : 'Finding address…'}</p>
          <p className="detail__area">{place ? place.area : `${request.lat.toFixed(4)}, ${request.lon.toFixed(4)}`}</p>
        </div>

        <div className="detail__people">
          <p className="detail__headcount">
            <img src={users} width={16} height={16} alt="" />
            {peopleLabel(request.headcount)}
          </p>
          {needLines(request).map(n => (
            <p key={n} className="detail__need">
              {n}
            </p>
          ))}
          {request.note && <p className="detail__note">“{request.note}”</p>}
        </div>

        <div className="detail__eta">
          <p className="detail__eta-value">ETA {etaMinutes(item.etaS, nowS)} min</p>
          <p className="detail__eta-time">Arrival {clockHMTz(simToMs(clock, item.etaS))}</p>
        </div>

        <div className={`slack-box slack-box--${request.level}`}>
          <p className="slack-box__label">Safety slack</p>
          <p className="slack-box__value">{formatSlack(request.slackS)}</p>
          <p className="slack-box__hint">Buffer, not an ETA</p>
        </div>

        <p className="detail__reason">{item.reason}</p>

        {mine && (
          <>
            <div className="detail__divider" />
            {confirming ? (
              <div className="detail__confirm" role="alertdialog" aria-label="Confirm can't reach">
                <p>Return {requestCode(request.id)} to the queue and flag it as unreachable by {item.unitCallsign}?</p>
                <div className="detail__actions">
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
              <div className="detail__actions">
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
            {error && <p className="detail__error">{error}</p>}
          </>
        )}
      </div>
    </section>
  );
}
