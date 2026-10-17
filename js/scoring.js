// Model d'idoneïtat boletaire.
// Cada factor retorna un valor 0–1; l'índex final (0–100) és un producte ponderat,
// de manera que si un factor clau és dolent (fora de temporada, sense pluja…) l'índex cau.

import { factorSol, SOL_NOM } from './coneixement.js';

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const BONUS_ATLES = 0.35; // fins a +35 % on l'Atles del Boletaire cita l'espècie

/** Trapezi suau: 0 fora de [a,d], 1 entre [b,c], rampes lineals entre mig. */
export function trapezi(x, [a, b, c, d]) {
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / (b - a);
  if (x > c) return (d - x) / (d - c);
  return 1;
}

/** Corba de saturació: 0 → 0, x = 1 → 0,8, x = 2 → ~1. */
const satura = x => 1 - Math.exp(-1.6 * x * x);

/** Pes de temporada per a una data, interpolant els 12 valors mensuals (centrats a mig mes). */
export function temporada(sp, date) {
  const d = new Date(date);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 864e5;
  const m = (doy / 365.25) * 12 - 0.5; // posició contínua de mes
  const i0 = Math.floor(m), f = m - i0;
  const w = sp.temporada;
  return w[(i0 + 12) % 12] * (1 - f) + w[(i0 + 13) % 12] * f;
}

/**
 * Variables derivades estàtiques per cel·la: proxy de bosc a partir del relleu i l'altitud.
 * A Catalunya les planes (Lleida, Empordà, costa urbanitzada, delta) són sobretot agrícoles o urbanes
 * i les zones accidentades són majoritàriament forestals. És una APROXIMACIÓ fins que integrem
 * el Mapa Forestal / Mapa de Cobertes del Sòl (fase 2).
 */
export function derivaEstatiques(grid, elev) {
  const n = grid.cells.length;
  const idx = new Map(grid.cells.map((c, i) => [c[0] + ',' + c[1], i]));
  const relleu = new Float32Array(n), bosc = new Float32Array(n);
  const rad = 1; // veïns immediats (3×3)
  for (let i = 0; i < n; i++) {
    const [c, r] = grid.cells[i];
    const vals = [];
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      const j = idx.get((c + dc) + ',' + (r + dr));
      if (j !== undefined && !isNaN(elev[j])) vals.push(elev[j]);
    }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    relleu[i] = sd * (5 / grid.km); // normalitzat a l'escala de 5 km
    const perRelleu = clamp((relleu[i] - 20) / 140, 0.08, 1);
    const perAltitud = elev[i] > 2300 ? clamp(1 - (elev[i] - 2300) / 400, 0.05, 1) : 1; // límit del bosc
    const perCota = elev[i] < 60 ? 0.35 : 1; // franja litoral/deltes, molt transformada
    bosc[i] = clamp(perRelleu * perAltitud * perCota, 0.05, 1);
  }
  return { relleu, bosc };
}

/**
 * Calcula l'índex d'una espècie per a una cel·la i un dia.
 * @param {object} sp  espècie (species.json)
 * @param {object} M   meteo: { dates, nd, precip, tmean, tmin, et0, elev, aigua }
 * @param {object} S   estàtiques: { bosc, sol, perSp (Atles) }
 * @param {number} i   índex de cel·la
 * @param {number} d   índex de dia dins M.dates
 * @param {boolean} detall  si cal retornar els factors
 */
export function index(sp, M, S, i, d, detall = false) {
  const nd = M.nd, o = i * nd;
  const P = M.precip, T = M.tmean, Tn = M.tmin;

  // 1) Temporada
  const fTemp = temporada(sp, M.dates[d]);

  // 2) Pluja desencadenant: màxim de pluja acumulada en 3 dies dins la finestra de latència
  let disparador = 0;
  for (let j = Math.max(2, d - sp.lag[1]); j <= d - sp.lag[0]; j++) {
    const r3 = P[o + j] + P[o + j - 1] + P[o + j - 2];
    if (r3 > disparador) disparador = r3;
  }
  const fDisp = satura(disparador / sp.pluja);

  // 3) Humitat del sòl (balanç simple pluja − evapotranspiració)
  const aigua = M.aigua[o + d];
  const fHum = satura(aigua / 25);
  const fPluja = Math.pow(fDisp, 0.6) * Math.pow(Math.max(fHum, 0.12), 0.4);

  // 4) Temperatura mitjana dels últims 7 dies
  let ts = 0, tc = 0;
  for (let j = Math.max(0, d - 6); j <= d; j++) { ts += T[o + j]; tc++; }
  const t7 = ts / tc;
  const fT = trapezi(t7, sp.temp);

  // 5) Gelades recents
  let tmin4 = Infinity;
  for (let j = Math.max(0, d - 3); j <= d; j++) tmin4 = Math.min(tmin4, Tn[o + j]);
  const fGel = tmin4 < sp.gelada ? clamp(1 - (sp.gelada - tmin4) * 0.18, 0.15, 1) : 1;

  // 6) Altitud
  const fAlt = trapezi(M.elev[i], sp.elev);

  // 7) Bosc (aproximació). Pes negatiu = espècie de prat, prefereix zones obertes.
  const pesBosc = sp.boscPes ?? 1;
  const fBosc = pesBosc >= 0 ? Math.pow(S.bosc[i], pesBosc) : 1 - Math.abs(pesBosc) * 0.8 * S.bosc[i];

  // 8) Substrat (silici / calcari)
  const fSol = factorSol(sp.sol, S.sol ? S.sol[i] : NaN);

  // 9) Coneixement expert: zona citada a l'Atles del Boletaire
  const A = S.perSp?.get(sp.id);
  const prox = A ? A.prox[i] : 0;
  const fAtles = 1 + BONUS_ATLES * prox;

  const valor = Math.min(100, 100 * fTemp * fPluja * Math.pow(fT, 0.8) * fAlt * fBosc * fGel * fSol * fAtles);
  if (!detall) return valor;
  const zona = A && A.zona[i] >= 0 && prox > 0 ? S.zones[A.zona[i]] : null;

  // Dies des de l'última pluja ≥ 10 mm
  let dies = null;
  for (let j = d; j >= 0; j--) if (P[o + j] >= 10) { dies = d - j; break; }
  let pluja7 = 0;
  for (let j = Math.max(0, d - 6); j <= d; j++) pluja7 += P[o + j];

  return {
    valor, t7, tmin4, disparador, aigua, pluja7, dies,
    factors: [
      { nom: 'Temporada', v: fTemp },
      { nom: 'Pluja desencadenant', v: fDisp, txt: `${Math.round(disparador)} mm en 3 dies, fa ${sp.lag[0]}–${sp.lag[1]} dies` },
      { nom: 'Humitat del sòl', v: fHum, txt: `reserva ≈ ${Math.round(aigua)} mm` },
      { nom: 'Temperatura', v: fT, txt: `${t7.toFixed(1)} °C de mitjana (7 dies)` },
      { nom: 'Sense gelades', v: fGel, txt: `mínima ${tmin4.toFixed(1)} °C` },
      { nom: 'Altitud', v: fAlt, txt: `${Math.round(M.elev[i])} m` },
      { nom: pesBosc < 0 ? 'Espai obert (aprox.)' : 'Bosc (aprox.)', v: fBosc },
      { nom: 'Substrat', v: fSol, txt: sp.sol ? `${SOL_NOM(S.sol[i])} · prefereix ${sp.sol.replace('-suau', ' (lleu)')}` : `${SOL_NOM(S.sol[i])} · indiferent` },
    ],
    atles: zona ? { ...zona, prox, bonus: fAtles } : null,
  };
}

/** Precalcula la reserva d'aigua del sòl (mm) per a totes les cel·les i dies. */
export function calculaAigua(M) {
  const { nd, precip, et0 } = M;
  const n = precip.length / nd;
  const aigua = new Float32Array(precip.length);
  for (let i = 0; i < n; i++) {
    let w = 15;
    for (let d = 0; d < nd; d++) {
      const k = i * nd + d;
      // la pluja forta s'escola parcialment; l'ET0 asseca el sòl
      const p = precip[k] > 40 ? 40 + (precip[k] - 40) * 0.4 : precip[k];
      w = clamp(w + p - 0.75 * et0[k], 0, 80);
      aigua[k] = w;
    }
  }
  return aigua;
}

/** Índex per a totes les cel·les d'un dia. */
export function mapaDia(sp, M, S, d) {
  const n = M.elev.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = index(sp, M, S, i, d);
  return out;
}
