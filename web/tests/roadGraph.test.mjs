import test from 'node:test';
import assert from 'node:assert/strict';
import { roadRoute, positionAlong, blockedEdges, distance } from '../src/ops/roadGraph.mjs';
const nodes = [{id:'a',lon:0,lat:0},{id:'b',lon:.01,lat:0},{id:'c',lon:.01,lat:.01},{id:'d',lon:0,lat:.01}];
const edge = (id,from,to,oneway=false) => ({id,from,to,oneway,speedMps:10,name:id});
const graph={nodes,edges:[edge('ab','a','b'),edge('bc','b','c'),edge('ad','a','d'),edge('dc','d','c')]};
test('routes and animation follow road bends, including the exact endpoint',()=>{
 const r=roadRoute({nodes,edges:graph.edges.slice(0,2)},[0,0],[.01,.01]);
 assert.equal(r.onRoads,true); assert.ok(r.distanceM>2100);
 const halfway=positionAlong(r.points,.5); assert.ok(halfway[0]>.0099 && halfway[1]<.0001);
 assert.deepEqual(positionAlong(r.points,1),[.01,.01]);
});
test('a closed road forces a real detour',()=>{
 const context={closures:[{active:true,lon1:.009,lat1:.004,lon2:.011,lat2:.004}]};
 assert.ok(blockedEdges(graph,context).has('bc'));
 const r=roadRoute(graph,[0,0],[.01,.01],context); assert.equal(r.onRoads,true);
 assert.ok(r.points.some(p=>p.lat===.01 && p.lon===0));
});
test('observed fire excludes intersecting road edges',()=>{
 const context={grid:{originLat:-.001,originLon:-.001,rows:20,cols:20,cellSizeM:100},fireCells:[{cellId:5*20+12}]};
 assert.ok(blockedEdges(graph,context).has('bc'));
 const r=roadRoute(graph,[0,0],[.01,.01],context);assert.equal(r.onRoads,true);assert.ok(r.points.some(p=>p.lon===0&&p.lat===.01));
});
test('disconnected or distant endpoints return no invented route',()=>{
 const g={nodes,edges:[edge('ab','a','b'),edge('dc','d','c')]};
 for(const to of [[.005,.01],[1,1]]) { const r=roadRoute(g,[.005,0],to);assert.equal(r.onRoads,false);assert.deepEqual(r.coords,[]); }
});
test('one-way roads reject travel against the permitted direction',()=>{
 const g={nodes:nodes.slice(0,2),edges:[edge('ab','a','b',true)]};
 assert.equal(roadRoute(g,[.002,0],[.008,0]).onRoads,true);
 assert.equal(roadRoute(g,[.008,0],[.002,0]).onRoads,false);
});
test('every animated sample stays on the displayed road polyline',()=>{
 const r=roadRoute(graph,[.002,0],[.01,.009]);
 for(let f=0;f<=1;f+=.01){const p=positionAlong(r.points,f);assert.ok(p[1]<1e-7 || Math.abs(p[0]-.01)<1e-7);}
 assert.ok(distance(r.coords[0],[.002,0])<.01);
});
