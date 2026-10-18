import { descarregaMeteo, preparaMeteo, meteoDemo, DIES_PASSATS } from './weather.js';
import { derivaEstatiques, calculaAigua, index, mapaDia } from './scoring.js';
import { Heatmap, RAMPES, color, css, gradientCSS } from './heatmap.js';
import { preparaConeixement, aplicaCapes } from './coneixement.js';

const $ = s => document.querySelector(s);
// Vista prèvia (artifact de Claude): sense tessel·les externes ni Open-Meteo, que el navegador hi bloqueja.
const PREVIEW = !!window.BOLETS_PREVIEW;
const token = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const DIES_ENRERE = 14; // dies passats visibles a la línia de temps
const CACHE_HORES = 3;

const estat = {
  especies: [], sp: null, municipis: [], contorn: null, sols: null, atles: null,
  km: 10, grid: null, M: null, S: null, heat: null,
  avui: DIES_PASSATS, dia: DIES_PASSATS, vista: 'index',
  sel: -1, cacheDia: new Map(),
};

// ---------- Preferències ----------
const prefs = (() => { try { return JSON.parse(localStorage.getItem('bolets-prefs') || '{}'); } catch { return {}; } })();
const desaPrefs = () => { try { localStorage.setItem('bolets-prefs', JSON.stringify({ sp: estat.sp?.id, km: estat.km, vista: estat.vista, base: $('#base').value, opac: $('#opacitat').value })); } catch { /* sense emmagatzematge */ } };

// ---------- Mapa ----------
const BASES = {
  'icgc-topo': { tiles: ['https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wmts/topografic/MON3857NW/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© <a href="https://www.icgc.cat">ICGC</a>' },
  'icgc-orto': { tiles: ['https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wmts/orto/MON3857NW/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© <a href="https://www.icgc.cat">ICGC</a>' },
  opentopo: { tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'], maxzoom: 17, attribution: '© OpenStreetMap, SRTM · <a href="https://opentopomap.org">OpenTopoMap</a>' },
  osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
};

const map = new maplibregl.Map({
  container: 'mapa',
  style: {
    version: 8,
    ...(PREVIEW ? {} : { glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf' }),
    sources: PREVIEW ? {} : Object.fromEntries(Object.entries(BASES).map(([k, b]) => [k, { type: 'raster', tileSize: 256, ...b }])),
    layers: [{ id: 'fons', type: 'background', paint: { 'background-color': token('--mapa') || '#e9e4d6' } },
      ...(PREVIEW ? [] : Object.keys(BASES).map(k => ({ id: 'base-' + k, type: 'raster', source: k, layout: { visibility: 'none' } })))],
  },
  center: [1.75, 41.75], zoom: 7.1, minZoom: 6, maxZoom: 17,
  maxBounds: [[-1.5, 39.6], [5.2, 43.6]],
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

let baseActual = null, baseFallida = false;
function posaBase(k) {
  if (PREVIEW) return;
  if (baseActual) map.setLayoutProperty('base-' + baseActual, 'visibility', 'none');
  map.setLayoutProperty('base-' + k, 'visibility', 'visible');
  baseActual = k; $('#base').value = k;
}
map.on('error', e => {
  // si les tessel·les de l'ICGC fallen, passem a OpenTopoMap una sola vegada
  if (!baseFallida && e.sourceId?.startsWith('icgc') && e.sourceId === baseActual) { baseFallida = true; posaBase('opentopo'); }
});

const mapaLlest = new Promise(r => map.on('load', r));

// ---------- Càrrega de dades ----------
const getJSON = async (url, opts) => { const r = await fetch(url, opts); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); };

function carregant(txt) {
  $('#carregant').hidden = !txt;
  if (txt) $('#carregant-txt').textContent = txt;
}
function avis(txt) { $('#avis').hidden = !txt; $('#avis').innerHTML = txt || ''; }

async function obteMeteo(grid, forca = false) {
  const clau = `bolets-meteo-${grid.km}`;
  if (!forca) {
    // 1) fitxer generat per la GitHub Action
    try {
      const raw = await getJSON(`data/meteo-${grid.km}km.json`, { cache: 'no-cache' });
      if (Date.now() - Date.parse(raw.generat) < 30 * 3600e3 && raw.elev.length === grid.cells.length) return { raw, font: 'fitxer diari' };
    } catch { /* encara no existeix */ }
    // 2) memòria cau del navegador
    try {
      const raw = JSON.parse(localStorage.getItem(clau) || 'null');
      if (raw && Date.now() - Date.parse(raw.generat) < CACHE_HORES * 3600e3) return { raw, font: 'memòria cau' };
    } catch { /* res */ }
  }
  // 3) Open-Meteo en directe
  carregant('Descarregant meteo… 0%');
  const raw = await descarregaMeteo(grid, { onProgress: p => carregant(`Descarregant meteo… ${Math.round(p * 100)}%`) });
  try { localStorage.setItem(clau, JSON.stringify(raw)); } catch { /* massa gran o bloquejat */ }
  return { raw, font: 'Open-Meteo en directe' };
}

async function carregaGraella(km, forca = false) {
  carregant('Carregant graella…');
  const grid = await getJSON(`data/grid-${km}km.json`);
  let raw, font;
  try {
    ({ raw, font } = await obteMeteo(grid, forca));
    avis('');
  } catch (err) {
    console.warn(err);
    raw = meteoDemo(grid); font = 'demostració';
    avis(PREVIEW
      ? '<b>Vista prèvia amb dades de demostració.</b> Aquí no es pot connectar amb Open-Meteo ni carregar mapes base, així que la pluja i la temperatura són inventades. Publicada a GitHub Pages, l\'app fa servir la meteo real.'
      : '<b>Mode demostració.</b> No s\'ha pogut connectar amb Open-Meteo, així que les dades meteorològiques són inventades. Torna-ho a provar més tard.');
  }
  const M = preparaMeteo(raw);
  M.aigua = calculaAigua(M);
  estat.km = km; estat.grid = grid; estat.M = M;
  const capes = await getJSON(`data/capes-${km}km.json`).catch(() => null);
  if (capes && capes.elev?.length !== grid.cells.length) console.warn('capes: mida diferent de la graella');
  const relleuOM = derivaEstatiques(grid, M.elev); // aproximació a partir de l'altitud d'Open-Meteo
  estat.S = { ...relleuOM, ...preparaConeixement(grid, estat.sols, estat.atles, estat.municipis) };
  aplicaCapes(estat.S, capes, M.elev);
  estat.capes = capes;
  estat.heat = new Heatmap(grid, estat.contorn);
  estat.cacheDia.clear();
  // índex del dia d'avui dins les dates
  const avuiISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const k = M.dates.indexOf(avuiISO);
  estat.avui = k >= 0 ? k : Math.min(DIES_PASSATS, M.nd - 1);
  estat.dia = estat.avui;
  estat.sel = -1;
  $('#estat-dades').textContent = `Font: ${font} · ${grid.cells.length} zones de ${km} km · actualitzat ${new Date(M.generat).toLocaleString('ca-ES', { dateStyle: 'short', timeStyle: 'short' })}${estat.capes ? ' · bosc CREAF, geologia i relleu ICGC' : ''}`;
  carregant('');
}

// ---------- Càlculs amb memòria ----------
function valorsIndex(d) {
  const k = estat.sp.id + ':' + d;
  if (!estat.cacheDia.has(k)) estat.cacheDia.set(k, mapaDia(estat.sp, estat.M, estat.S, d));
  return estat.cacheDia.get(k);
}

function valorsVista(d) {
  const { M, S } = estat, n = M.elev.length, nd = M.nd;
  if (estat.vista === 'index') return valorsIndex(d);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * nd;
    if (estat.vista === 'elev') out[i] = M.elev[i];
    else if (estat.vista === 'sol') out[i] = isNaN(S.sol[i]) ? 0.5 : S.sol[i];
    else if (estat.vista === 'bosc') out[i] = S.boscPct ? S.boscPct[i] / 100 : S.bosc[i];
    else if (estat.vista === 'habitat') out[i] = S.arbres && estat.sp.arbres ? (estat.sp.arbres.reduce((a, k) => a + (S.arbres[k]?.[i] ?? 0), 0) + 0.5 * (estat.sp.arbres2 || []).reduce((a, k) => a + (S.arbres[k]?.[i] ?? 0), 0)) / 100 : S.bosc[i];
    else {
      let s = 0, c = 0;
      for (let j = Math.max(0, d - 6); j <= d; j++) { s += estat.vista === 'pluja7' ? M.precip[o + j] : M.tmean[o + j]; c++; }
      out[i] = estat.vista === 'pluja7' ? s : s / c;
    }
  }
  return out;
}

const diesVisibles = () => {
  const a = Math.max(0, estat.avui - DIES_ENRERE), b = estat.M.nd - 1;
  return [a, b];
};

// ---------- Capes del mapa ----------
async function preparaCapes() {
  await mapaLlest;
  const g = estat.heat;
  const url = g.pinta(valorsVista(estat.dia), estat.vista);
  if (map.getSource('heat')) {
    map.getSource('heat').updateImage({ url, coordinates: g.coordinates });
    return;
  }
  map.addSource('heat', { type: 'image', url, coordinates: g.coordinates });
  map.addLayer({ id: 'heat', type: 'raster', source: 'heat', paint: { 'raster-opacity': +$('#opacitat').value, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } });

  // fora de Catalunya, una mica esvaït
  const forats = (estat.contorn.type === 'Polygon' ? [estat.contorn.coordinates] : estat.contorn.coordinates).map(p => p[0]);
  map.addSource('mascara', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-10, 35], [10, 35], [10, 48], [-10, 48], [-10, 35]], ...forats] } } });
  map.addLayer({ id: 'mascara', type: 'fill', source: 'mascara', paint: { 'fill-color': token('--paper') || '#f5f0e6', 'fill-opacity': PREVIEW ? 0.7 : 0.45 } });
  if (PREVIEW) {
    map.addSource('base', { type: 'geojson', data: 'data/base.geojson' });
    map.addLayer({ id: 'base-muni', type: 'line', source: 'base', filter: ['==', ['get', 'k'], 'muni'], paint: { 'line-color': token('--ink') || '#1f2a22', 'line-opacity': 0.13, 'line-width': 0.6 } });
    map.addLayer({ id: 'base-prov', type: 'line', source: 'base', filter: ['==', ['get', 'k'], 'prov'], paint: { 'line-color': token('--ink') || '#1f2a22', 'line-opacity': 0.35, 'line-width': 1, 'line-dasharray': [3, 2] } });
  }
  map.addSource('contorn', { type: 'geojson', data: { type: 'Feature', geometry: estat.contorn } });
  map.addLayer({ id: 'contorn', type: 'line', source: 'contorn', paint: { 'line-color': token('--ink') || '#1f2a22', 'line-width': 1.4, 'line-opacity': 0.7 } });

  if (!PREVIEW) {
    // Espais naturals de protecció especial (parcs, paratges, reserves) — servei INSPIRE de la Generalitat
    map.addSource('enp', { type: 'raster', tileSize: 256, attribution: 'Espais naturals: © Generalitat de Catalunya',
      tiles: ['https://geoserveis.ide.cat/servei/catalunya/inspire-espais-naturals-proteccio-especial/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=PS.ProtectedSite&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true'] });
    map.addLayer({ id: 'enp', type: 'raster', source: 'enp', layout: { visibility: $('#mostra-enp').checked ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.75 } });
  }
  map.addSource('recents', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'recents', type: 'circle', source: 'recents', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 11, 7], 'circle-color': '#c2410c',
    'circle-opacity': ['interpolate', ['linear'], ['get', 'dies'], 0, 0.95, 21, 0.35],
    'circle-stroke-color': '#fffdf8', 'circle-stroke-width': 1.5 } });
  map.on('click', 'recents', e => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ className: 'popup-zona', closeButton: false, offset: 8 })
      .setLngLat(e.lngLat).setHTML(`<b>${p.nom}</b><br><small>${p.data} · fa ${p.dies} dies · <a href="${p.url}" target="_blank" rel="noopener">iNaturalist</a></small>`).addTo(map);
  });
  map.on('mouseenter', 'recents', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'recents', () => { map.getCanvas().style.cursor = ''; });
  map.addSource('atles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'atles-punt', type: 'circle', source: 'atles', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 11, 6], 'circle-color': '#fffdf8',
    'circle-stroke-color': '#1f2a22', 'circle-stroke-width': 1.6 } });
  if (!PREVIEW) map.addLayer({ id: 'atles-nom', type: 'symbol', source: 'atles', minzoom: 9, layout: {
    'text-field': ['get', 'nom'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] },
    paint: { 'text-color': '#1f2a22', 'text-halo-color': '#fffdf8', 'text-halo-width': 1.5 } });
  map.on('click', 'atles-punt', e => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ className: 'popup-zona', closeButton: false, offset: 8 })
      .setLngLat(e.lngLat).setHTML(`<b>${p.nom}</b><br><small>${p.comarca}: ${p.habitat}</small>`).addTo(map);
  });
  map.on('mouseenter', 'atles-punt', () => { map.getCanvas().style.cursor = 'pointer'; });

  map.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'sel-fill', type: 'fill', source: 'sel', paint: { 'fill-color': token('--card') || '#fff', 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#1f2a22', 'line-width': 2.2 } });
  aplicaTema();
}

function pintaAtles() {
  const src = map.getSource('atles'); if (!src) return;
  const vis = $('#mostra-atles').checked;
  const feats = [];
  if (vis) for (const z of estat.S.zones) if (z.sp.includes(estat.sp.id)) for (const [lon, lat, nom] of z.punts)
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { nom, comarca: z.comarca, habitat: z.habitat } });
  src.setData({ type: 'FeatureCollection', features: feats });
}

function repinta() {
  if (!estat.heat || !map.getSource('heat')) return;
  map.getSource('heat').updateImage({ url: estat.heat.pinta(valorsVista(estat.dia), estat.vista), coordinates: estat.heat.coordinates });
}

// ---------- UI: espècies ----------
function pintaEspecies() {
  const cont = $('#especies');
  cont.innerHTML = '';
  for (const sp of estat.especies) {
    const b = document.createElement('button');
    b.className = 'xip'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', sp === estat.sp);
    const mes = new Date().getMonth(), t = Math.max(sp.temporada[mes], sp.temporada[(mes + 1) % 12] * 0.7);
    if (t < 0.15) { b.classList.add('fora'); b.title = 'Fora de temporada'; }
    b.innerHTML = `<span class="punt" style="background:${sp.color}"></span>${sp.nom}`;
    b.onclick = () => triaEspecie(sp);
    cont.appendChild(b);
  }
  const sp = estat.sp;
  const nZones = estat.S ? estat.S.zones.filter(z => z.sp.includes(sp.id)).length : 0;
  const solTxt = { 'silici': 'sòls silicis (àcids)', 'silici-suau': 'preferentment sòls silicis', 'calcari': 'sòls calcaris', 'calcari-suau': 'preferentment sòls calcaris' }[sp.sol] || 'indiferent al substrat';
  $('#especie-info').innerHTML = `<em>${sp.llati}</em><br>${sp.habitat} · ${solTxt}. ${sp.notes}` +
    (nZones ? `<span class="nota-atles">📖 ${nZones} ${nZones > 1 ? 'zones citades' : 'zona citada'} a l'Atles del Boletaire</span>` : '');
  $('#obre-panell-txt').textContent = sp.nom;
}

function triaEspecie(sp) {
  estat.sp = sp;
  pintaEspecies(); desaPrefs(); pintaAtles(); pintaRecents();
  if (estat.vista !== 'index' && estat.vista !== 'habitat') triaVista('index'); else actualitzaTot();
}

// ---------- Troballes recents (iNaturalist, últims 21 dies) ----------
const recentsCache = new Map();
async function pintaRecents() {
  const src = map.getSource('recents');
  if (!src) return;
  const sp = estat.sp, on = $('#mostra-recents').checked && !PREVIEW;
  if (!on || !sp.noms_cientifics) { src.setData({ type: 'FeatureCollection', features: [] }); $('#recents-info').textContent = ''; return; }
  if (!recentsCache.has(sp.id)) {
    const d1 = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
    const peticions = sp.noms_cientifics.map(nom => fetch(`https://api.inaturalist.org/v1/observations?taxon_name=${encodeURIComponent(nom)}` +
      `&swlat=40.45&swlng=0.1&nelat=42.9&nelng=3.4&d1=${d1}&per_page=200&order_by=observed_on`).then(r => r.ok ? r.json() : { error: true }).catch(() => ({ error: true })));
    const resp = await Promise.all(peticions);
    if (resp.every(j => j.error)) { $('#recents-info').textContent = 'No s\'ha pogut consultar iNaturalist'; return; }
    const obs = resp.flatMap(j => j.results || []);
    recentsCache.set(sp.id, obs.filter(o => o.geojson).map(o => ({ type: 'Feature', geometry: o.geojson,
      properties: { nom: o.taxon?.preferred_common_name || o.taxon?.name || sp.nom, data: o.observed_on, url: o.uri,
        dies: Math.max(0, Math.round((Date.now() - Date.parse(o.observed_on)) / 864e5)) } })));
  }
  if (estat.sp !== sp) return;
  const f = recentsCache.get(sp.id);
  src.setData({ type: 'FeatureCollection', features: f });
  $('#recents-info').textContent = f.length ? `${f.length} troballes a iNaturalist els últims 21 dies` : 'Cap troballa a iNaturalist els últims 21 dies';
}

// ---------- UI: vista / llegenda ----------
function triaVista(v) {
  estat.vista = v;
  document.querySelectorAll('#vista button').forEach(b => b.classList.toggle('actiu', b.dataset.v === v));
  pintaLlegenda(); desaPrefs(); repinta();
}

function pintaLlegenda() {
  const R = RAMPES[estat.vista];
  const fmt = R.format || (v => Math.round(v) + R.unitat);
  const mig = (R.min + R.max) / 2;
  $('#llegenda').innerHTML = `
    <div class="rampa" style="background:${gradientCSS(estat.vista)}"></div>
    <div class="escala"><span>${fmt(R.min)}</span><span>${fmt(mig)}</span><span>${fmt(R.max)}${estat.vista === 'pluja7' ? '+' : ''}</span></div>
    ${R.etiquetes ? `<div class="classes">${R.etiquetes.map(e => `<span>${e}</span>`).join('')}</div>` : ''}`;
}

// ---------- UI: línia de temps ----------
const fmtData = (iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(iso + 'T12:00:00').toLocaleDateString('ca-ES', opts);

function percentil90(arr) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.9)] || 0;
}

function pintaLiniaTemps() {
  const [a, b] = diesVisibles();
  const slider = $('#dia');
  slider.min = a; slider.max = b; slider.value = estat.dia;
  const vals = [];
  for (let d = a; d <= b; d++) vals.push(percentil90(valorsIndex(d)));
  const max = Math.max(20, ...vals);
  $('#barres').innerHTML = vals.map((v, k) => {
    const d = a + k;
    return `<i class="${d > estat.avui ? 'prev' : ''} ${d === estat.dia ? 'sel' : ''}" style="height:${Math.max(6, v / max * 100)}%" title="${fmtData(estat.M.dates[d])}: ${Math.round(v)}"></i>`;
  }).join('');
  const d = estat.dia, M = estat.M;
  $('#data-txt').textContent = fmtData(M.dates[d], { weekday: 'long', day: 'numeric', month: 'long' });
  const tag = $('#data-tag');
  const delta = d - estat.avui;
  tag.className = 'tag' + (delta === 0 ? ' avui' : delta > 0 ? ' previsio' : '');
  tag.textContent = delta === 0 ? 'avui' : delta > 0 ? `previsió +${delta} d` : `fa ${-delta} d`;
}

let reproduint = null;
function play() {
  if (reproduint) { clearInterval(reproduint); reproduint = null; $('#play').textContent = '▶'; return; }
  $('#play').textContent = '❚❚';
  const [a, b] = diesVisibles();
  if (estat.dia >= b) estat.dia = a - 1;
  reproduint = setInterval(() => {
    if (estat.dia >= b) { play(); return; }
    estat.dia++; actualitzaDia();
  }, 650);
}

// ---------- UI: top zones ----------
function classe(v) {
  if (v >= 80) return ['Molt alta', 'Condicions molt favorables'];
  if (v >= 60) return ['Alta', 'Condicions favorables'];
  if (v >= 40) return ['Moderada', 'Pot sortir alguna cosa'];
  if (v >= 20) return ['Baixa', 'Poc probable'];
  return ['Molt baixa', 'Gairebé impossible'];
}

function pintaTop() {
  const vals = valorsIndex(estat.dia), g = estat.grid;
  const ordre = Array.from(vals.keys()).sort((a, b) => vals[b] - vals[a]);
  const vistos = new Set(), top = [];
  for (const i of ordre) {
    const nom = estat.municipis[g.cells[i][4]][0];
    if (vistos.has(nom)) continue;
    vistos.add(nom); top.push(i);
    if (top.length === 8) break;
  }
  const ol = $('#top-zones');
  if (!top.length || vals[top[0]] < 5) {
    ol.innerHTML = `<li class="pista">Cap zona amb condicions mínimes aquest dia per al ${estat.sp.nom.toLowerCase()}.</li>`;
    return;
  }
  ol.innerHTML = top.map((i, k) => {
    const v = vals[i], col = color('index', v);
    return `<li><button data-i="${i}"><span class="pos">${k + 1}</span>
      <span>${estat.municipis[g.cells[i][4]][0]}<span class="alt">${Math.round(estat.M.elev[i])} m</span></span>
      <span class="val" style="background:${css([...col.slice(0, 3), 0.25])}">${Math.round(v)}</span></button></li>`;
  }).join('');
  ol.querySelectorAll('button').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, [, , lon, lat] = g.cells[i];
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), estat.km >= 10 ? 10 : 11), speed: 1.4 });
    selecciona(i);
  });
}

// ---------- UI: fitxa de zona ----------
function selecciona(i) {
  estat.sel = i;
  map.getSource('sel')?.setData(i < 0 ? { type: 'FeatureCollection', features: [] } :
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [estat.heat.quadrat(i)] } });
  pintaFitxa();
  if (window.matchMedia('(max-width: 760px)').matches && i >= 0) $('#panell').classList.add('obert');
}

function sparkline(i) {
  const [a, b] = diesVisibles(), { M } = estat, nd = M.nd;
  const W = 300, H = 74, n = b - a + 1, bw = W / n;
  const vals = [], pluja = [];
  for (let d = a; d <= b; d++) { vals.push(index(estat.sp, M, estat.S, i, d)); pluja.push(M.precip[i * nd + d]); }
  const maxP = Math.max(20, ...pluja);
  const y = v => H - 4 - v / 100 * (H - 10);
  const pts = vals.map((v, k) => `${(k + 0.5) * bw},${y(v)}`).join(' ');
  const xAvui = (estat.avui - a + 0.5) * bw, xSel = (estat.dia - a + 0.5) * bw;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Evolució de l'índex i la pluja">
    <rect x="${xAvui}" y="0" width="${W - xAvui}" height="${H}" style="fill:var(--accent)" opacity=".08"/>
    ${pluja.map((p, k) => p > 0.5 ? `<rect x="${k * bw + 2}" y="${H - p / maxP * (H * 0.55)}" width="${bw - 4}" height="${p / maxP * (H * 0.55)}" style="fill:var(--pluja)" opacity=".7"><title>${fmtData(M.dates[a + k])}: ${p} mm</title></rect>` : '').join('')}
    <line x1="${xAvui}" x2="${xAvui}" y1="0" y2="${H}" style="stroke:var(--ink)" stroke-dasharray="2 3" opacity=".5"/>
    <polyline points="${pts}" fill="none" style="stroke:var(--ink)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${xSel}" cy="${y(vals[estat.dia - a])}" r="4" style="fill:var(--accent);stroke:var(--card)" stroke-width="1.5"/>
  </svg>`;
}

function millorFinestra(i) {
  const { M } = estat, vals = [];
  for (let d = estat.avui; d < M.nd; d++) vals.push([d, index(estat.sp, M, estat.S, i, d)]);
  const best = vals.reduce((m, x) => x[1] > m[1] ? x : m, [estat.avui, -1]);
  if (best[1] < 25) return `Sense cap finestra favorable en els propers ${M.nd - estat.avui} dies.`;
  // dies consecutius per sobre del 80% del màxim
  let d0 = best[0], d1 = best[0];
  while (d0 - 1 >= estat.avui && index(estat.sp, M, estat.S, i, d0 - 1) >= best[1] * 0.8) d0--;
  while (d1 + 1 < M.nd && index(estat.sp, M, estat.S, i, d1 + 1) >= best[1] * 0.8) d1++;
  const f = d => fmtData(M.dates[d], { day: 'numeric', month: 'short' });
  return `Millor finestra estimada: <b>${d0 === d1 ? f(d0) : f(d0) + ' – ' + f(d1)}</b> (índex fins a ${Math.round(best[1])}).`;
}

function pintaFitxa() {
  const i = estat.sel, el = $('#fitxa');
  $('#fitxa-buida').hidden = i >= 0; el.hidden = i < 0;
  if (i < 0) return;
  const { M, grid } = estat, [, , lon, lat, mi] = grid.cells[i];
  const r = index(estat.sp, M, estat.S, i, estat.dia, true);
  const [cl, desc] = classe(r.valor), col = color('index', r.valor);
  el.innerHTML = `
    <h2>Prop de ${estat.municipis[mi][0]}</h2>
    <p class="coords">${lat.toFixed(3)}, ${lon.toFixed(3)} · zona de ${grid.km}×${grid.km} km · ${fmtData(M.dates[estat.dia])}</p>
    <div class="marcador">
      <div class="num" style="color:${css([...col.slice(0, 3).map(x => x * 0.8), 1])}">${Math.round(r.valor)}<small>/100</small></div>
      <div class="classe">${estat.sp.nom}: ${cl}<span>${desc}</span></div>
    </div>
    <div class="dades-zona">
      <div class="dada"><b>${Math.round(r.pluja7)} mm</b><span>pluja últims 7 dies</span></div>
      <div class="dada"><b>${r.dies === null ? '> 40' : r.dies} d</b><span>des de pluja ≥ 10 mm</span></div>
      <div class="dada"><b>${r.t7.toFixed(1)} °C</b><span>temp. mitjana 7 dies</span></div>
      <div class="dada"><b>${Math.round(M.elev[i])} m</b><span>altitud mitjana</span></div>
    </div>
    <div class="factors">${r.factors.map(f => {
      const c = color('index', f.v * 100);
      return `<div class="factor"><span class="nom">${f.nom}${f.txt ? `<small>${f.txt}</small>` : ''}</span>
        <span class="barra"><i style="width:${Math.round(f.v * 100)}%;background:${css([...c.slice(0, 3), 1])}"></i></span>
        <span class="pc">${Math.round(f.v * 100)}</span></div>`;
    }).join('')}</div>
    <div class="grafic-zona">
      <div class="tit"><span>Índex (línia) i pluja (barres)</span><span>previsió →</span></div>
      ${sparkline(i)}
    </div>
    <p class="finestra">${millorFinestra(i)}</p>
    ${r.atles ? `<div class="bloc-atles"><b>📖 Zona citada a l'Atles del Boletaire</b>
      ${r.atles.comarca}${r.atles.pagines ? ` (p. ${r.atles.pagines})` : ''}: ${r.atles.habitat}.
      <span>Bonificació +${Math.round((r.atles.bonus - 1) * 100)} %${r.atles.prox < 1 ? ' (a la vora de la zona)' : ''}</span></div>` : ''}`;
}

// ---------- Actualització ----------
function actualitzaDia() {
  repinta(); pintaLiniaTemps(); pintaTop(); pintaFitxa();
}
function actualitzaTot() {
  pintaLlegenda(); actualitzaDia();
}

// ---------- Inici ----------
async function inici() {
  const [especies, municipis, contorn, sols, atles] = await Promise.all([
    getJSON('data/species.json'), getJSON('data/municipis.json'), getJSON('data/catalunya.geojson'),
    getJSON('data/sols.json'), getJSON('data/atles.json'),
  ]);
  estat.especies = especies; estat.municipis = municipis; estat.contorn = contorn.features[0].geometry;
  estat.sols = sols; estat.atles = atles;
  estat.sp = especies.find(s => s.id === prefs.sp) || especies[0];
  estat.vista = prefs.vista || 'index';
  if (prefs.opac) $('#opacitat').value = prefs.opac;
  const km = prefs.km === 5 ? 5 : 10;
  $('#resolucio').value = km;

  $('#llista-municipis').innerHTML = municipis.map(m => `<option value="${m[0]}">`).join('');
  pintaEspecies();
  document.querySelectorAll('#vista button').forEach(b => b.classList.toggle('actiu', b.dataset.v === estat.vista));

  await mapaLlest;
  posaBase(BASES[prefs.base] ? prefs.base : 'icgc-topo');
  if (PREVIEW) $('#base').closest('label').hidden = true;
  await carregaGraella(km);
  await preparaCapes();
  pintaEspecies(); pintaAtles(); pintaRecents();
  actualitzaTot();
}

// ---------- Esdeveniments ----------
$('#dia').addEventListener('input', e => { estat.dia = +e.target.value; actualitzaDia(); });
$('#play').addEventListener('click', play);
document.querySelectorAll('#vista button').forEach(b => b.addEventListener('click', () => triaVista(b.dataset.v)));
$('#opacitat').addEventListener('input', e => { if (map.getLayer('heat')) map.setPaintProperty('heat', 'raster-opacity', +e.target.value); desaPrefs(); });
$('#mostra-atles').addEventListener('change', pintaAtles);
$('#mostra-recents').addEventListener('change', pintaRecents);
$('#mostra-enp').addEventListener('change', e => { if (map.getLayer('enp')) map.setLayoutProperty('enp', 'visibility', e.target.checked ? 'visible' : 'none'); });
$('#base').addEventListener('change', e => { posaBase(e.target.value); desaPrefs(); });
$('#resolucio').addEventListener('change', async e => {
  await carregaGraella(+e.target.value); selecciona(-1); await preparaCapes(); pintaAtles(); actualitzaTot(); desaPrefs();
});
$('#recarrega').addEventListener('click', async () => {
  await carregaGraella(estat.km, true); selecciona(-1); await preparaCapes(); actualitzaTot();
});
$('#cerca').addEventListener('change', e => {
  const q = e.target.value.trim().toLowerCase();
  const m = estat.municipis.find(x => x[0].toLowerCase() === q) || estat.municipis.find(x => x[0].toLowerCase().startsWith(q));
  if (!m) return;
  map.flyTo({ center: [m[1], m[2]], zoom: 11.5, speed: 1.5 });
  const i = estat.heat?.cellaA(m[1], m[2]);
  if (i >= 0) selecciona(i);
  e.target.blur();
});
map.on('click', e => {
  if (!estat.heat || map.queryRenderedFeatures(e.point, { layers: ['atles-punt'] }).length) return;
  selecciona(estat.heat.cellaA(e.lngLat.lng, e.lngLat.lat));
});
map.on('mousemove', e => { map.getCanvas().style.cursor = estat.heat && estat.heat.cellaA(e.lngLat.lng, e.lngLat.lat) >= 0 ? 'crosshair' : ''; });
$('#obre-panell').addEventListener('click', () => $('#panell').classList.add('obert'));
$('#tanca-panell').addEventListener('click', () => $('#panell').classList.remove('obert'));
document.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const [a, b] = estat.M ? diesVisibles() : [0, 0];
  if (e.key === 'ArrowRight' && estat.dia < b) { estat.dia++; actualitzaDia(); }
  if (e.key === 'ArrowLeft' && estat.dia > a) { estat.dia--; actualitzaDia(); }
});

inici().catch(err => { console.error(err); carregant(''); avis('No s\'ha pogut iniciar l\'aplicació: ' + err.message); });

// Colors del mapa segons el tema (clar/fosc) del visor
function aplicaTema() {
  if (!map.isStyleLoaded()) return;
  const set = (l, p, v) => { if (map.getLayer(l) && v) map.setPaintProperty(l, p, v); };
  set('fons', 'background-color', token('--mapa'));
  set('mascara', 'fill-color', token('--paper'));
  for (const l of ['contorn', 'base-muni', 'base-prov', 'sel-line']) set(l, 'line-color', token('--ink'));
  set('atles-punt', 'circle-color', token('--card'));
  set('atles-punt', 'circle-stroke-color', token('--ink'));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', aplicaTema);
new MutationObserver(aplicaTema).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
map.on('load', aplicaTema);
