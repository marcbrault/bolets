// Genera les dades geogràfiques estàtiques de l'app.
// Ús: npm i es-atlas topojson-client  &&  node scripts/build-geodata.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as topo from 'topojson-client';
const require = createRequire(import.meta.url);
const muni = JSON.parse(readFileSync(require.resolve('es-atlas/es/municipalities.json')));
const OUT = new URL('../data/', import.meta.url);

// --- Contorn de Catalunya
const regions = topo.feature(muni, muni.objects.autonomous_regions);
const cat = regions.features.find(f => f.id === '09');
const round = c => Array.isArray(c[0]) ? c.map(round) : [+c[0].toFixed(4), +c[1].toFixed(4)];
cat.geometry.coordinates = round(cat.geometry.coordinates);
writeFileSync(new URL('catalunya.geojson', OUT), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Catalunya' }, geometry: cat.geometry }] }));

// --- Municipis (centroides) per a la cerca i per anomenar zones
const isCat = id => /^(08|17|25|43)/.test(String(id));
const munis = topo.feature(muni, muni.objects.municipalities).features.filter(f => isCat(f.id));
const ringCentroid = ring => { let a = 0, x = 0, y = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]; a += f; x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f; } return [x / (3 * a), y / (3 * a), Math.abs(a / 2)]; };
const municipis = munis.map(f => {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const best = polys.map(p => ringCentroid(p[0])).sort((a, b) => b[2] - a[2])[0];
  return [f.properties.name, +best[0].toFixed(4), +best[1].toFixed(4)];
}).sort((a, b) => a[0].localeCompare(b[0], 'ca'));
writeFileSync(new URL('municipis.json', OUT), JSON.stringify(municipis));

// --- Graelles regulars en Web Mercator (alineades amb el mapa)
const polys = cat.geometry.type === 'Polygon' ? [cat.geometry.coordinates] : cat.geometry.coordinates;
const inRing = (x, y, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
const inside = (x, y) => polys.some(p => inRing(x, y, p[0]) && !p.slice(1).some(h => inRing(x, y, h)));
const R = 6378137, mx = lon => lon * Math.PI / 180 * R, my = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const lonOf = x => x / R * 180 / Math.PI, latOf = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
const bbox = [0.15, 40.5, 3.35, 42.9];
for (const km of [5, 10]) {
  const step = km * 1000 / Math.cos(41.7 * Math.PI / 180); // pas en metres Mercator ≈ km reals
  const x0 = mx(bbox[0]), y1 = my(bbox[3]);
  const nx = Math.ceil((mx(bbox[2]) - x0) / step), ny = Math.ceil((y1 - my(bbox[1])) / step);
  const cells = [];
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const lon = lonOf(x0 + (c + 0.5) * step), lat = latOf(y1 - (r + 0.5) * step);
    if (!inside(lon, lat)) continue;
    let bi = 0, bd = 1e9; municipis.forEach((m, i) => { const d = (m[1] - lon) ** 2 * 0.56 + (m[2] - lat) ** 2; if (d < bd) { bd = d; bi = i; } });
    cells.push([c, r, +lon.toFixed(4), +lat.toFixed(4), bi]);
  }
  writeFileSync(new URL(`grid-${km}km.json`, OUT), JSON.stringify({ km, step, x0, y1, nx, ny, west: lonOf(x0), east: lonOf(x0 + nx * step), north: latOf(y1), south: latOf(y1 - ny * step), cells }));
  console.log(`graella ${km} km: ${nx}x${ny}, ${cells.length} cel·les`);
}
console.log(`municipis: ${municipis.length}`);
