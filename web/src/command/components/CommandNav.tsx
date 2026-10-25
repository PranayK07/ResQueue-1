import flame from '../../assets/figma/command/flame.svg';

/** Dark product bar shared by every command page. */
export function CommandNav() {
  return (
    <header className="cnav">
      <a className="cnav__identity" href="#/command">
        <img src={flame} width={24} height={24} alt="" />
        ResQueue
      </a>
      <nav className="cnav__destinations" aria-label="Command">
        <a className="cnav__dest cnav__dest--active" href="#/command" aria-current="page">
          Operations
        </a>
      </nav>
      <div className="cnav__session">
        <a className="cnav__switch" href="#/">
          Caller view
        </a>
        <a className="cnav__switch" href="#/responder">
          Responder view
        </a>
        <span className="cnav__status">ARIZONA · JULY 2020 REPLAY</span>
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
      <p>NIROPS recorded perimeters · Trained U-Net exposure · Synthetic residents, stations and units</p>
      <p className="mono">{snapshotLabel}</p>
    </footer>
  );
}
