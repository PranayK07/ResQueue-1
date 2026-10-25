import { roadRoute, blockedEdges, positionAlong } from '../../web/src/ops/roadGraph.mjs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const p = JSON.parse(input);
if (p.action === 'closures') process.stdout.write(JSON.stringify([...blockedEdges(p.graph, p.context)]));
else if (p.action === 'matrix') process.stdout.write(JSON.stringify(p.pairs.map(pair => { const route = roadRoute(p.graph, pair.from, pair.to, p.context); return { request_id: pair.id, station_id: pair.stationId, travel_s: route.onRoads ? route.durationS : 1e9, reachable: route.onRoads }; })));
else {
  const from = p.previous ? positionAlong(p.previous.points, p.previous.fraction) || p.from : p.from;
  process.stdout.write(JSON.stringify(roadRoute(p.graph, from, p.to, p.context)));
}
