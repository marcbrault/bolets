// Graella fina (500 m): capes estàtiques a 500 m (data/fina.*) combinades amb la meteo de 5 o 10 km.
// La meteo s'interpola entre cel·les i la temperatura es corregeix per l'altitud real de cada casella.

import { trapezi, dinamica, fGelada, fHabitat, fOrientacio } from './scoring.js';
import { factorSol, SOL_VAL } from './coneixement.js';

const R = 6378137, LAPSE = -0.0065, BONUS_ATLES = 0.35, KM_LAT = 111.2;
const TIPUS = { int16: Int16Array, uint8: Uint8Array, int8: Int8Array };
const lonDe = x => x / R * 180 / Math.PI;
const latDe = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
const mercX = lon => lon * Math.PI / 180 * R;
const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

export async function carregaFina() {
  try {
    const meta = await (await fetch('data/fina.json')).json();
    const r = await fetch('data/fina.bin.gz');
    if (!r.ok) return null;
    let buf = await r.arrayBuffer();
    const u = new Uint8Array(buf, 0, 2);
    if (u[0] === 0x1f && u[1] === 0x8b) { // encara comprimit (el servidor no l'ha descomprimit)
      if (typeof DecompressionStream === 'undefined') return null;
      buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    return new Fina(meta, buf);
  } catch (e) {
    console.warn('Graella fina no disponible', e);
    return null;
  }
}

export class Fina {
  constructor(meta, buf) {
    Object.assign(this, meta);
    this.N = this.nx * this.ny;
    this.b = {};
    for (const bd of meta.bandes) this.b[bd.nom] = new TIPUS[bd.tipus](buf, bd.offset, this.N);
    const dins = [];
    for (let p = 0; p < this.N; p++) if (this.b.dins[p]) dins.push(p);
    this.dins = Int32Array.from(dins);
    this.lon = new Float32Array(this.N); this.lat = new Float32Array(this.N);
    for (let r = 0; r < this.ny; r++) {
      const la = latDe(this.y1 - (r + 0.5) * this.step);
      for (let c = 0; c < this.nx; c++) { const p = r * this.nx + c; this.lon[p] = lonDe(this.x0 + (c + 0.5) * this.step); this.lat[p] = la; }
    }
    this.west = lonDe(this.x0); this.east = lonDe(this.x0 + this.nx * this.step);
    this.north = latDe(this.y1); this.south = latDe(this.y1 - this.ny * this.step);
    this.km = 0.5; this.cells = [];
    this.cacheAtles = new Map();
  }

  get coordinates() { return [[this.west, this.north], [this.east, this.north], [this.east, this.south], [this.west, this.south]]; }

  pixel(lon, lat) {
    const c = Math.floor((mercX(lon) - this.x0) / this.step), r = Math.floor((this.y1 - mercY(lat)) / this.step);
    if (c < 0 || r < 0 || c >= this.nx || r >= this.ny) return -1;
    const p = r * this.nx + c;
    return this.b.dins[p] ? p : -1;
  }

  /** Prepara la interpolació des de la graella de meteo (5 o 10 km). */
  enllaca(grid) {
    if (this.grid === grid) return;
    this.grid = grid;
    const idx = new Int32Array(grid.nx * grid.ny).fill(-1);
    grid.cells.forEach(([c, r], i) => { idx[r * grid.nx + c] = i; });
    const n = this.dins.length;
    this.v4 = new Int32Array(4 * n); this.w4 = new Float32Array(4 * n);
    for (let k = 0; k < n; k++) {
      const p = this.dins[k], c = p % this.nx, r = (p - c) / this.nx;
      const u = (this.x0 + (c + 0.5) * this.step - grid.x0) / grid.step - 0.5;
      const v = (grid.y1 - (this.y1 - (r + 0.5) * this.step)) / grid.step - 0.5;
      const c0 = Math.floor(u), r0 = Math.floor(v), fx = u - c0, fy = v - r0;
      const at = (rr, cc) => (rr < 0 || cc < 0 || rr >= grid.ny || cc >= grid.nx) ? -1 : idx[rr * grid.nx + cc];
      const q = [[r0, c0, (1 - fx) * (1 - fy)], [r0, c0 + 1, fx * (1 - fy)], [r0 + 1, c0, (1 - fx) * fy], [r0 + 1, c0 + 1, fx * fy]];
      q.forEach(([rr, cc, w], j) => { this.v4[4 * k + j] = at(rr, cc); this.w4[4 * k + j] = w; });
    }
  }

  /** Valor interpolat d'un vector per cel·la de meteo a la casella k (ordre de this.dins). */
  interp(arr, k) {
    let s = 0, w = 0;
    for (let j = 0; j < 4; j++) {
      const i = this.v4[4 * k + j], wt = this.w4[4 * k + j];
      if (i < 0 || wt === 0) continue;
      const v = arr[i];
      if (!Number.isNaN(v)) { s += v * wt; w += wt; }
    }
    return w ? s / w : NaN;
  }

  /** Substrat segons les zones de l'Atles (com preparaConeixement, però a 500 m). */
  solAtles(sols) {
    if (this._solAtles) return this._solAtles;
    const out = new Float32Array(this.N).fill(NaN);
    for (const p of this.dins) {
      let best = 1;
      for (const z of sols.zones) {
        const kx = KM_LAT * Math.cos((this.lat[p] + z.lat) / 2 * Math.PI / 180);
        const q = Math.hypot((this.lon[p] - z.lon) * kx, (this.lat[p] - z.lat) * KM_LAT) / z.r;
        if (q < best) { best = q; out[p] = SOL_VAL[z.tipus]; }
      }
    }
    return (this._solAtles = out);
  }

  /** Proximitat (0–1) a les zones de l'Atles on surt l'espècie. */
  proxAtles(sp, S, radiKm = 7) {
    if (this.cacheAtles.has(sp.id)) return this.cacheAtles.get(sp.id);
    const out = new Float32Array(this.N);
    const pas = this.step * Math.cos(41.7 * Math.PI / 180) / 1000, rad = Math.ceil(2 * radiKm / pas) + 1;
    for (const z of S.zones || []) if (z.sp.includes(sp.id)) for (const [lon, lat] of z.punts) {
      const c0 = Math.floor((mercX(lon) - this.x0) / this.step), r0 = Math.floor((this.y1 - mercY(lat)) / this.step);
      for (let r = Math.max(0, r0 - rad); r <= Math.min(this.ny - 1, r0 + rad); r++)
        for (let c = Math.max(0, c0 - rad); c <= Math.min(this.nx - 1, c0 + rad); c++) {
          const p = r * this.nx + c;
          const kx = KM_LAT * Math.cos((this.lat[p] + lat) / 2 * Math.PI / 180);
          const d = Math.hypot((this.lon[p] - lon) * kx, (this.lat[p] - lat) * KM_LAT);
          const v = d <= radiKm ? 1 : d < 2 * radiKm ? 1 - (d - radiKm) / radiKm : 0;
          if (v > out[p]) out[p] = v;
        }
    }
    this.cacheAtles.set(sp.id, out);
    return out;
  }

  /** Variables meteo per cel·la (vectors) per a un dia i una espècie. */
  dinamiques(sp, M, S, d) {
    const n = M.elev.length, fTP = new Float32Array(n), t7 = new Float32Array(n), tmin = new Float32Array(n), p7 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const D = dinamica(sp, M, i, d);
      fTP[i] = D.fTemp * D.fPluja; t7[i] = D.t7; tmin[i] = D.tmin4;
      let s = 0; for (let j = Math.max(0, d - 6); j <= d; j++) s += M.precip[i * M.nd + j];
      p7[i] = s;
    }
    return { fTP, t7, tmin, p7, zM: S.elevMeteo || M.elev };
  }

  /** Factors d'una casella (k = posició dins this.dins). */
  factors(sp, M, S, sols, Dn, k) {
    const p = this.dins[k], b = this.b;
    const zRaw = b.elev[p], z = zRaw === -32768 ? this.interp(M.elev, k) : zRaw;
    const dz = z - this.interp(Dn.zM, k);
    const t7 = this.interp(Dn.t7, k) + LAPSE * dz, tmin = this.interp(Dn.tmin, k) + LAPSE * dz;
    const fTP = this.interp(Dn.fTP, k);
    const fT = trapezi(t7, sp.temp), fGel = fGelada(sp, tmin), fAlt = trapezi(z, sp.elev);
    const pct = key => { const v = b[key]?.[p]; return v == null || v === 255 ? 0 : v; };
    const fH = sp.arbres ? fHabitat(sp, pct) : 1;
    const nord = b.nord[p] === -128 ? 0 : b.nord[p];
    const fOri = fOrientacio(t7, nord, sp);
    const sRaw = b.sol[p], sFi = sRaw === 255 ? NaN : sRaw / 100, sA = this.solAtles(sols)[p];
    const sol = Number.isNaN(sFi) ? sA : Number.isNaN(sA) ? sFi : 0.5 * sFi + 0.5 * sA;
    const fSol = factorSol(sp.sol, sol, sp.solRang);
    const prox = this.proxAtles(sp, S)[p];
    const valor = Math.min(100, 100 * fTP * Math.pow(fT, 0.8) * fAlt * fH * fOri * fGel * fSol * (1 + BONUS_ATLES * prox));
    return { valor, z, t7, tmin, fTP, fT, fGel, fAlt, fH, fOri, fSol, sol, nord, prox, p7: this.interp(Dn.p7, k) };
  }

  /** Mapa (vector N, NaN fora) d'una vista: index, elev, bosc, habitat, sol, temp7, pluja7. */
  mapa(vista, sp, M, S, sols, d) {
    const out = new Float32Array(this.N).fill(NaN), b = this.b, n = this.dins.length;
    if (vista === 'elev' || vista === 'bosc' || vista === 'habitat') {
      for (let k = 0; k < n; k++) {
        const p = this.dins[k];
        if (vista === 'elev') out[p] = b.elev[p] === -32768 ? NaN : b.elev[p];
        else if (vista === 'bosc') out[p] = b.bosc[p] === 255 ? NaN : b.bosc[p] / 100;
        else {
          let q = 0;
          for (const key of sp.arbres || []) q += b[key][p] === 255 ? 0 : b[key][p];
          for (const key of sp.arbres2 || []) q += b[key][p] === 255 ? 0 : 0.5 * b[key][p];
          out[p] = q / 100;
        }
      }
      return out;
    }
    const Dn = this.dinamiques(sp, M, S, d);
    for (let k = 0; k < n; k++) {
      const p = this.dins[k];
      if (vista === 'pluja7') { out[p] = this.interp(Dn.p7, k); continue; }
      const f = this.factors(sp, M, S, sols, Dn, k);
      out[p] = vista === 'index' ? f.valor : vista === 'temp7' ? f.t7 : vista === 'sol' ? (Number.isNaN(f.sol) ? 0.5 : f.sol) : NaN;
    }
    return out;
  }

  /** Detall d'un punt per a la fitxa. */
  detall(p, sp, M, S, sols, d) {
    const k = this.dins.indexOf(p);
    if (k < 0) return null;
    const f = this.factors(sp, M, S, sols, this.dinamiques1(sp, M, S, d, k), k);
    const hostes = sp.arbres ? fHabitat(sp, key => { const v = this.b[key]?.[p]; return v == null || v === 255 ? 0 : v; }, true).hostes : [];
    return { ...f, hostes, pend: this.b.pend[p], bosc: this.b.bosc[p] };
  }

  /** Com dinamiques(), però només per a les cel·les que toca la casella k (més ràpid per a un sol punt). */
  dinamiques1(sp, M, S, d, k) {
    const n = M.elev.length, fTP = new Float32Array(n).fill(NaN), t7 = fTP.slice(), tmin = fTP.slice(), p7 = fTP.slice();
    for (let j = 0; j < 4; j++) {
      const i = this.v4[4 * k + j];
      if (i < 0) continue;
      const D = dinamica(sp, M, i, d);
      fTP[i] = D.fTemp * D.fPluja; t7[i] = D.t7; tmin[i] = D.tmin4;
      let s = 0; for (let q = Math.max(0, d - 6); q <= d; q++) s += M.precip[i * M.nd + q];
      p7[i] = s;
    }
    return { fTP, t7, tmin, p7, zM: S.elevMeteo || M.elev };
  }
}

// ---------- Trossos de 100 m (es carreguen en fer zoom) ----------
export class Trossos {
  static async carrega(dir = 'data/fina100/') {
    try {
      const r = await fetch(dir + 'index.json');
      if (!r.ok) return null;
      return new Trossos(await r.json(), dir);
    } catch { return null; }
  }

  constructor(index, dir) {
    const { tros: mida, ...resta } = index;
    Object.assign(this, resta);
    this.mida = mida; // costat del tros en caselles (el mètode tros() carrega un tros)
    this.dir = dir;
    this.disponibles = new Set(index.trossos);
    this.cache = new Map(); // clau → Promise<Fina>
  }

  clauA(lon, lat) {
    const c = Math.floor((mercX(lon) - this.x0) / (this.step * this.mida)), r = Math.floor((this.y1 - mercY(lat)) / (this.step * this.mida));
    return `${c}_${r}`;
  }

  /** Claus dels trossos que toquen un rectangle (lon/lat). */
  visibles(w, s, e, n, max = 16) {
    const T = this.step * this.mida;
    const c0 = Math.floor((mercX(w) - this.x0) / T), c1 = Math.floor((mercX(e) - this.x0) / T);
    const r0 = Math.floor((this.y1 - mercY(n)) / T), r1 = Math.floor((this.y1 - mercY(s)) / T);
    const out = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (this.disponibles.has(`${c}_${r}`)) out.push(`${c}_${r}`);
    return out.length <= max ? out : [];
  }

  tros(clau) {
    if (!this.cache.has(clau)) {
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
      const [c, r] = clau.split('_').map(Number);
      const meta = { nx: this.mida, ny: this.mida, step: this.step, bandes: this.bandes, grups: this.grups, factor: this.factor,
        x0: this.x0 + c * this.mida * this.step, y1: this.y1 - r * this.mida * this.step };
      this.cache.set(clau, (async () => {
        const res = await fetch(`${this.dir}${clau}.bin.gz`);
        if (!res.ok) throw new Error(clau);
        let buf = await res.arrayBuffer();
        const u = new Uint8Array(buf, 0, 2);
        if (u[0] === 0x1f && u[1] === 0x8b)
          buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        const f = new Fina(meta, buf);
        f.km = 0.1;
        return f;
      })());
    }
    return this.cache.get(clau);
  }
}
