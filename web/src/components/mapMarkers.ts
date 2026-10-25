import truck from '../assets/firetruck-pixel.png';
import type { HelpRequest } from '../ops/types';
import './mapMarkers.css';
export const escapeLabel = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function urgencyColor(r: Pick<HelpRequest, 'level' | 'slackS'>) {
  if (r.level === 'unknown' || r.slackS === null) return '#98a5ad';
  if (r.slackS < 0) return '#750b15';
  if (r.slackS < 600) return '#ad1522';
  if (r.slackS < 1800) return '#e64b23';
  if (r.slackS < 3600) return '#f49927';
  return '#f0d536';
}
export function alertMarker(r: HelpRequest, label: string) {
  return `<span class="pixel-alert" style="color:${urgencyColor(r)}" aria-hidden="true"><svg viewBox="0 0 16 24" width="20" height="30" shape-rendering="crispEdges"><path fill="#fff5db" d="M3 0h10v2h2v14h-2v2h2v6H1v-6h2v-2H1V2h2z"/><path fill="currentColor" d="M4 2h8v12h-2v2H6v-2H4zm1 17h6v4H5z"/></svg></span><span class="pixel-marker-label">${escapeLabel(label)}</span>`;
}
export function truckMarker(label: string) {
  return `<img class="pixel-truck" src="${truck}" width="52" height="34" alt="Firetruck"/><span class="pixel-marker-label">${escapeLabel(label)}</span>`;
}

/** Keep nearby caller icons readable; leaders preserve the exact geographic pickup point. */
export function spreadAlerts(map: import('maplibre-gl').Map, markers: Record<string, import('maplibre-gl').Marker>) {
  const occupied: { x: number; y: number }[] = Object.entries(markers).filter(([key]) => key.startsWith('truck-')).map(([, m]) => map.project(m.getLngLat()));
  for (const [key, marker] of Object.entries(markers)) {
    if (!key.startsWith('req-')) continue;
    const p = map.project(marker.getLngLat());
    let dx = 0, dy = 0;
    for (let i = 0; i < 50; i++) {
      const ring = Math.ceil(i / 8), angle = (i % 8) * Math.PI / 4;
      dx = i ? Math.round(Math.cos(angle) * ring * 40) : 0;
      dy = i ? Math.round(Math.sin(angle) * ring * 48) : 0;
      if (!occupied.some(q => Math.abs(q.x - p.x - dx) < 34 && Math.abs(q.y - p.y - dy) < 44)) break;
    }
    occupied.push({ x: p.x + dx, y: p.y + dy });
    marker.setOffset([dx, dy]);
    const node = marker.getElement();
    node.querySelector('.pixel-marker-leader')?.remove();
    if (dx || dy) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('pixel-marker-leader');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = `<path d="M0 0L${-dx} ${-dy}" stroke="#fff" stroke-width="3"/><path d="M0 0L${-dx} ${-dy}" stroke="#35454e" stroke-width="1"/><circle cx="${-dx}" cy="${-dy}" r="2" fill="#fff"/>`;
      node.prepend(svg);
    }
  }
}
