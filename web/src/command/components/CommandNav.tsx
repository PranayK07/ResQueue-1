import flame from '../../assets/figma/command/flame.svg';

/** Dark product bar shared by every command page. */
export function CommandNav() {
  return (
    <header className="cnav">
      <a className="cnav__identity" href="#/command">
        <img src={flame} width={24} height={24} alt="" />
        Wildfire Rescue Queue
      </a>
      <nav className="cnav__destinations" aria-label="Command">
        <a className="cnav__dest cnav__dest--active" href="#/command" aria-current="page">
          Operations
        </a>
        <span className="cnav__dest" aria-disabled="true" title="Not part of this proof of concept">
          Stations
        </span>
        <span className="cnav__dest" aria-disabled="true" title="Not part of this proof of concept">
          Scenario lab
        </span>
      </nav>
      <div className="cnav__session">
        <a className="cnav__switch" href="#/">
          Caller view
        </a>
        <a className="cnav__switch" href="#/responder">
          Responder view
        </a>
        <span className="cnav__status">SIMULATION / SYNTHETIC DATA</span>
        <span className="cnav__role">Incident commander</span>
        <span className="cnav__avatar" aria-label="A. Lee">
          AL
        </span>
      </div>
    </header>
  );
}

export function SafetyFooter({ snapshotLabel }: { snapshotLabel: string }) {
  return (
    <footer className="cfooter">
      <p>Human decision support only · Synthetic residents and simplified fire spread · No real dispatch · Not a replacement for 911</p>
      <p className="mono">{snapshotLabel}</p>
    </footer>
  );
}
