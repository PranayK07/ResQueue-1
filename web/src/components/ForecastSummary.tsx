import type { LiveExtras, RiskCard } from '../ops/types';
import './ForecastSummary.css';

export function ForecastSummary({ live }: { live: LiveExtras | undefined }) {
  const layer = live?.fireRisk, pipeline = live?.riskPipeline;
  const ready = pipeline?.status === 'ready' && layer?.source === 'learned';
  return <div className="forecast-summary" role="status">
    <strong>{ready ? 'U-Net fire exposure' : 'U-Net forecast pending'}</strong>
    <span>{ready ? `Model ${layer.modelId} · ${layer.horizonsS.map(h => `${h / 3600}h`).join(' / ')} forecasts · LOOKAHEAD dispatch` : pipeline?.reason || 'Waiting for the recorded observation and model output.'}</span>
    {ready && layer.sourceIssueUtcS > 0 && <span>Observed {new Date(layer.sourceIssueUtcS * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC · predictions use only acquired perimeters</span>}
    <span className="forecast-key"><i />Observed fire → higher exposure → lower exposure</span>
  </div>;
}

export function RiskSummary({ card }: { card: RiskCard | undefined }) {
  if (!card) return <div className="forecast-summary"><strong>Assessing this location</strong><span>Exposure and assistance timing will update from the shared pipeline.</span></div>;
  return <div className="forecast-summary">
    <strong>{card.current ? 'Location risk assessment' : 'Reassessing location risk'}</strong>
    {!card.current && <span>{card.staleReason || 'Inputs changed; reassessment pending.'} Previous exposure estimates are shown below.</span>}
    {card.current && !card.reachable && <span role="alert">{card.reason} Road directions show geometry only; they do not establish a safe approach through fire.</span>}
    <div className="forecast-probabilities">{card.probabilities.map((p, i) => <span key={card.horizonsS[i]}><b>{(p * 100).toFixed(p < 0.1 ? 1 : 0)}%</b> exposure by {card.horizonsS[i] / 3600}h</span>)}</div>
    <span>{card.probabilities.length ? `U-Net model ${card.modelId}` : `Learned exposure: ${card.forecastState}`}</span>
    <span>Travel, extraction time and available units determine slack. Lower slack needs earlier attention.</span>
  </div>;
}
