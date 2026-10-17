// Meteorologia: Open-Meteo (gratuït, sense clau). Funciona igual al navegador i a Node (GitHub Action).
// Per a cada cel·la de la graella obtenim, en dies: pluja, temperatura mitjana i mínima, ET0 i altitud.

export const DIES_PASSATS = 33;
export const DIES_PREVISIO = 7;
const VARS = 'precipitation_sum,temperature_2m_mean,temperature_2m_min,et0_fao_evapotranspiration';
const LOT = 100; // ubicacions per petició

const espera = ms => new Promise(r => setTimeout(r, ms));

// Open-Meteo gratuït: 600 crides/minut i 5.000/hora. Cada ubicació compta com a
// max(1, dies/14) crides, així que 40 dies × 1.612 cel·les (5 + 10 km) ≈ 4.600 crides.
export const PES_UBICACIO = (DIES_PASSATS + DIES_PREVISIO) / 14;

async function fetchLot(cells, fetchImpl, log) {
  const lat = cells.map(c => c[3]).join(',');
  const lon = cells.map(c => c[2]).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=${VARS}&past_days=${DIES_PASSATS}&forecast_days=${DIES_PREVISIO}&timezone=Europe%2FMadrid`;
  let darrer = '';
  for (let intent = 0; intent < 4; intent++) {
    let res;
    try {
      res = await fetchImpl(url);
    } catch (err) {
      // error de xarxa (timeout, DNS…): reintenta amb espera creixent
      darrer = `xarxa: ${err.message}${err.cause ? ' (' + (err.cause.code || err.cause.message) + ')' : ''}`;
      log(`Open-Meteo ${darrer} — reintent en ${10 * (intent + 1)} s`);
      await espera(10000 * (intent + 1)); continue;
    }
    if (res.ok) { const j = await res.json(); return Array.isArray(j) ? j : [j]; }
    darrer = `${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (res.status === 429 || res.status >= 500) {
      const ms = res.status === 429 ? 65000 : 3000 * (intent + 1);
      log(`Open-Meteo ${darrer} — reintent en ${Math.round(ms / 1000)} s`);
      await espera(ms); continue;
    }
    break;
  }
  throw new Error(`Open-Meteo ${darrer}`);
}

/** Descarrega la meteo de totes les cel·les. Retorna un objecte compacte serialitzable. */
export async function descarregaMeteo(grid, { fetchImpl = fetch, onProgress = () => {}, pesPerMinut = 0, log = () => {} } = {}) {
  const cells = grid.cells, n = cells.length;
  const lots = [];
  for (let k = 0; k < n; k += LOT) lots.push(cells.slice(k, k + LOT));
  let fets = 0, dates = null;
  const resultats = new Array(lots.length);
  if (pesPerMinut > 0) {
    // Mode servidor (GitHub Action): seqüencial i a ritme controlat
    for (let k = 0; k < lots.length; k++) {
      const t0 = Date.now();
      resultats[k] = await fetchLot(lots[k], fetchImpl, log);
      onProgress(++fets / lots.length);
      const msMinim = lots[k].length * PES_UBICACIO / pesPerMinut * 60000;
      if (k < lots.length - 1) await espera(Math.max(0, msMinim - (Date.now() - t0)));
    }
  } else {
    // Mode navegador: 3 peticions en paral·lel com a màxim
    let seg = 0;
    async function treballador() {
      while (seg < lots.length) {
        const k = seg++;
        resultats[k] = await fetchLot(lots[k], fetchImpl, log);
        onProgress(++fets / lots.length);
      }
    }
    await Promise.all([treballador(), treballador(), treballador()]);
  }

  const flat = resultats.flat();
  dates = flat[0].daily.time;
  const nd = dates.length;
  const out = { generat: new Date().toISOString(), km: grid.km, dates, nd,
    elev: [], precip: [], tmean: [], tmin: [], et0: [] };
  const r1 = v => (v == null || isNaN(v)) ? 0 : Math.round(v * 10) / 10;
  for (const loc of flat) {
    out.elev.push(Math.round(loc.elevation));
    const D = loc.daily;
    for (let d = 0; d < nd; d++) {
      out.precip.push(r1(D.precipitation_sum[d]));
      out.tmean.push(r1(D.temperature_2m_mean[d]));
      out.tmin.push(r1(D.temperature_2m_min[d]));
      out.et0.push(r1(D.et0_fao_evapotranspiration[d]));
    }
  }
  return out;
}

/** Converteix l'objecte serialitzat a arrays tipats per al càlcul. */
export function preparaMeteo(raw) {
  return {
    generat: raw.generat, demo: !!raw.demo, dates: raw.dates, nd: raw.nd,
    elev: Float32Array.from(raw.elev), precip: Float32Array.from(raw.precip),
    tmean: Float32Array.from(raw.tmean), tmin: Float32Array.from(raw.tmin), et0: Float32Array.from(raw.et0),
  };
}

/** Dades sintètiques per quan no hi ha connexió (marcades clarament com a demostració). */
export function meteoDemo(grid) {
  const nd = DIES_PASSATS + DIES_PREVISIO, avui = new Date();
  const dates = Array.from({ length: nd }, (_, d) => {
    const t = new Date(avui); t.setDate(t.getDate() + d - DIES_PASSATS); return t.toISOString().slice(0, 10);
  });
  const raw = { generat: avui.toISOString(), km: grid.km, dates, nd, demo: true, elev: [], precip: [], tmean: [], tmin: [], et0: [] };
  for (const [, , lon, lat] of grid.cells) {
    // altitud fictícia: més alta al nord (Pirineu), amb ondulacions
    const pir = Math.max(0, lat - 42.05) * 3200, ser = Math.max(0, Math.sin(lon * 3.1 + lat * 5.3)) * 700;
    const elev = Math.round(Math.min(2900, 40 + pir + ser * (lat > 41 ? 1 : 0.5) + (lon < 0.9 ? 250 : 0)));
    raw.elev.push(elev);
    for (let d = 0; d < nd; d++) {
      const front = (d >= 22 && d <= 24) || (d >= 37 && d <= 38);
      const p = front ? (14 + 22 * Math.max(0, Math.sin(lon * 2 + d)) + (lat - 40.5) * 10) : (Math.sin(d * 1.7 + lon) > 0.93 ? 4 : 0);
      const tm = 19 - d * 0.12 - elev * 0.0062 + Math.sin(d / 3) * 1.5;
      raw.precip.push(+p.toFixed(1)); raw.tmean.push(+tm.toFixed(1));
      raw.tmin.push(+(tm - 6).toFixed(1)); raw.et0.push(+Math.max(0.4, 2.6 - d * 0.03).toFixed(1));
    }
  }
  return raw;
}
