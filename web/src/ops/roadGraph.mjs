// Shared by the browser and the route agent. All geometry comes from OSM road edges.
const RAD = Math.PI / 180;
export function distance(a, b) {
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] + b[1]) * RAD / 2), (a[1] - b[1]) * 111320);
}
function project(p, a, b) {
  const k = Math.cos(p[1] * RAD), dx = (b[0] - a[0]) * k, dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, (((p[0] - a[0]) * k) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  const point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return { point, t, gap: distance(p, point) };
}
function intersects(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
  return x * y <= 0 && z * w <= 0 && Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0]))
    && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
}
export function blockedEdges(graph, context = {}) {
  const nodes = new Map(graph.nodes.map(n => [n.id, [n.lon, n.lat]]));
  const burning = new Set((context.fireCells || []).map(c => c.cellId));
  const g = context.grid;
  const closed = (context.closures || []).filter(c => c.active);
  const blocked = new Set();
  for (const edge of graph.edges) {
    const a = nodes.get(edge.from), b = nodes.get(edge.to);
    let hit = closed.some(c => {
      const c1 = [c.lon1, c.lat1], c2 = [c.lon2, c.lat2];
      return intersects(a, b, c1, c2) || Math.min(project(a, c1, c2).gap, project(b, c1, c2).gap, project(c1, a, b).gap, project(c2, a, b).gap) < 8;
    });
    if (!hit && g?.rows && burning.size) {
      const steps = Math.max(1, Math.ceil(distance(a, b) / (g.cellSizeM / 3)));
      for (let i = 0; i <= steps && !hit; i++) {
        const lat = a[1] + (b[1] - a[1]) * i / steps, lon = a[0] + (b[0] - a[0]) * i / steps;
        const r = Math.floor((lat - g.originLat) * 111320 / g.cellSizeM);
        const c = Math.floor((lon - g.originLon) * 111320 * Math.cos(g.originLat * RAD) / g.cellSizeM);
        hit = r >= 0 && r < g.rows && c >= 0 && c < g.cols && burning.has(r * g.cols + c);
      }
    }
    if (hit) blocked.add(edge.id);
  }
  return blocked;
}
export function unavailable(reason) {
  return { coords: [], points: [], distanceM: 0, durationS: 0, steps: [], via: '', onRoads: false, reason };
}
export function routeFromPoints(points, durationS) {
  if (points.length < 2) return unavailable('No safe road route is available.');
  const coords = points.map(p => [p.lon, p.lat]);
  let along = 0;
  const steps = [];
  const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * RAD), b[1] - a[1]) / RAD + 360) % 360;
  for (let i = 0; i < points.length - 1; i++) {
    const heading = bearing(coords[i], coords[i + 1]);
    const previous = i ? bearing(coords[i - 1], coords[i]) : heading;
    const turn = (heading - previous + 540) % 360 - 180;
    if (i === 0 || points[i].name !== points[i - 1].name || Math.abs(turn) > 35) {
      steps.push({ type: i === 0 ? 'depart' : Math.abs(turn) > 35 ? 'turn' : 'new name', modifier: turn > 0 ? 'right' : 'left',
        name: points[i].name || 'Access road', distanceM: 0, durationS: 0, location: coords[i], bearingAfter: heading, exit: null, startM: along });
    }
    along += distance(coords[i], coords[i + 1]);
  }
  steps.push({ type: 'arrive', modifier: '', name: '', distanceM: 0, durationS: 0, location: coords.at(-1), bearingAfter: 0, exit: null, startM: along });
  for (let i = 0; i < steps.length - 1; i++) { steps[i].distanceM = steps[i + 1].startM - steps[i].startM; steps[i].durationS = along ? durationS * steps[i].distanceM / along : 0; }
  return { coords, points, distanceM: along, durationS, steps, via: points.find(p => p.name)?.name || 'Access road', onRoads: true };
}
export function positionAlong(points, fraction) {
  if (!points.length) return null;
  let total = 0;
  const lengths = points.slice(1).map((p, i) => { const n = distance([points[i].lon, points[i].lat], [p.lon, p.lat]); total += n; return n; });
  let remaining = Math.max(0, Math.min(1, fraction)) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) { const f = lengths[i] ? remaining / lengths[i] : 0; return [points[i].lon + (points[i + 1].lon - points[i].lon) * f, points[i].lat + (points[i + 1].lat - points[i].lat) * f]; }
    remaining -= lengths[i];
  }
  return [points.at(-1).lon, points.at(-1).lat];
}
export function roadRoute(graph, from, to, context = {}) {
  if (!graph?.nodes?.length || !graph.edges?.length) return unavailable('The road network has not loaded.');
  const nodes = new Map(graph.nodes.map(n => [n.id, [n.lon, n.lat]]));
  const blocked = blockedEdges(graph, context), adjacency = new Map();
  const add = (a, b, duration, name) => { const list = adjacency.get(a) || []; list.push({ to: b, duration, name }); adjacency.set(a, list); };
  let start, end;
  for (const edge of graph.edges) {
    if (blocked.has(edge.id)) continue;
    const a = nodes.get(edge.from), b = nodes.get(edge.to), seconds = distance(a, b) / edge.speedMps;
    add(edge.from, edge.to, seconds, edge.name);
    if (!edge.oneway) add(edge.to, edge.from, seconds, edge.name);
    const p = project(from, a, b), q = project(to, a, b);
    if (!start || p.gap < start.gap) start = { ...p, edge, seconds };
    if (!end || q.gap < end.gap) end = { ...q, edge, seconds };
  }
  if (!start || !end || start.gap > 180 || end.gap > 180) return unavailable('No accessible road within 180 m of this location. Move the pin to a road access point.');
  const S = '__start', T = '__target'; nodes.set(S, start.point); nodes.set(T, end.point);
  add(S, start.edge.to, (1 - start.t) * start.seconds, start.edge.name);
  if (!start.edge.oneway) add(S, start.edge.from, start.t * start.seconds, start.edge.name);
  add(end.edge.from, T, end.t * end.seconds, end.edge.name);
  if (!end.edge.oneway) add(end.edge.to, T, (1 - end.t) * end.seconds, end.edge.name);
  if (start.edge.id === end.edge.id && (!start.edge.oneway || end.t >= start.t)) add(S, T, Math.abs(end.t - start.t) * start.seconds, start.edge.name);
  const cost = new Map([[S, 0]]), previous = new Map(), heap = [[0, S]];
  function push(item) { heap.push(item); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= item[0]) break; heap[i] = heap[p]; i = p; } heap[i] = item; }
  function pop() { const result = heap[0], last = heap.pop(); if (heap.length) { let i = 0; while (2 * i + 1 < heap.length) { let c = 2 * i + 1; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (last[0] <= heap[c][0]) break; heap[i] = heap[c]; i = c; } heap[i] = last; } return result; }
  while (heap.length) {
    const [value, id] = pop(); if (value !== cost.get(id)) continue; if (id === T) break;
    for (const edge of adjacency.get(id) || []) { const next = value + edge.duration; if (next < (cost.get(edge.to) ?? Infinity)) { cost.set(edge.to, next); previous.set(edge.to, { id, name: edge.name }); push([next, edge.to]); } }
  }
  if (!cost.has(T)) return unavailable('No safe road route avoids the current fire and closed roads.');
  const path = []; let current = T;
  while (current !== S) { const p = previous.get(current); if (!p) return unavailable('Road route could not be reconstructed.'); const [lon, lat] = nodes.get(current); path.push({ lon, lat, name: p.name }); current = p.id; }
  path.push({ lon: start.point[0], lat: start.point[1], name: path.at(-1)?.name || '' }); path.reverse();
  return routeFromPoints(path, Math.max(1, cost.get(T)));
}
