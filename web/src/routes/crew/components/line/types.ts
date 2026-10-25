/** One request waiting in this station's line, already joined and converted by the page. */
export type StationLineRow = {
  /** String(request id), used as the React key. Never Number() the bigint. */
  requestId: string;
  /** ops_queue rank. The line renders in rank order. */
  rank: number;
  headcount: number;
  /** The module's comma list, e.g. "mobility,medical". */
  needs: string;
  /** fireEtaS minus sim now, in minutes. Undefined when not assessed yet. */
  minutesBeforeFire: number | undefined;
  /** Danger level from the danger agent. Never recomputed here. */
  level: string;
};
