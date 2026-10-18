// Capes de coneixement expert: substrat aproximat i zones citades a l'Atles del Boletaire.

const KM_LAT = 111.2;
const distKm = (lon1, lat1, lon2, lat2) => {
  const kx = KM_LAT * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.hypot((lon1 - lon2) * kx, (lat1 - lat2) * KM_LAT);
};

export const SOL_VAL = { silici: 1, mixt: 0.5, calcari: 0 };
export const SOL_NOM = v => isNaN(v) ? 'desconegut' : v > 0.75 ? 'silici (àcid)' : v < 0.25 ? 'calcari (bàsic)' : 'mixt / descalcificat';

/** Afinitat espècie–substrat. */
const TAULA = {
  'silici':       { silici: 1, mixt: 0.75, calcari: 0.2, desc: 0.8 },
  'silici-suau':  { silici: 1, mixt: 0.9, calcari: 0.7, desc: 0.88 },
  'calcari':      { silici: 0.25, mixt: 0.75, calcari: 1, desc: 0.8 },
  'calcari-suau': { silici: 0.75, mixt: 0.9, calcari: 1, desc: 0.88 },
};
/**
 * Afinitat espècie–substrat. Si l'espècie té rang calibrat amb registres (solRang = percentils 5, 25, 75, 95
 * de l'índex de sòl on surt), es fa servir; si no, la preferència qualitativa.
 */
export function factorSol(pref, v, rang) {
  if (rang && !isNaN(v)) {
    const [a, b, c, d] = rang, lo = Math.max(0, a - 0.05), hi = Math.min(1.05, d + 0.05), mig = (b + c) / 2;
    // l'extrem del costat que l'espècie prefereix no es penalitza (pocs registres allà per manca de bosc, no de sòl)
    let t = 1;
    if (v < b && mig >= 0.45) t = v <= lo ? 0 : (v - lo) / (b - lo);
    else if (v > c && mig <= 0.55) t = v >= hi ? 0 : (hi - v) / (hi - c);
    return 0.25 + 0.75 * t;
  }
  if (!pref) return 1;
  const t = TAULA[pref];
  if (isNaN(v)) return t.desc;
  return v > 0.75 ? t.silici : v < 0.25 ? t.calcari : t.mixt;
}

export function preparaConeixement(grid, sols, atles, municipis) {
  const n = grid.cells.length;

  // --- Substrat: la zona on la cel·la queda més "endins" (d / r mínim)
  const sol = new Float32Array(n).fill(NaN), solNom = new Array(n).fill(null);
  grid.cells.forEach(([, , lon, lat], i) => {
    let best = 1;
    for (const z of sols.zones) {
      const q = distKm(lon, lat, z.lon, z.lat) / z.r;
      if (q < best) { best = q; sol[i] = SOL_VAL[z.tipus]; solNom[i] = z.nom; }
    }
  });

  // --- Atles: punts de referència per espècie
  const perNom = new Map(municipis.map(m => [m[0].toLowerCase(), m]));
  const noTrobats = [];
  const zones = []; // llista plana de zones amb els seus punts
  for (const c of atles.comarques) for (const z of c.zones) {
    const punts = [];
    for (const ll of z.llocs) {
      if (Array.isArray(ll)) { punts.push([ll[1], ll[2], ll[0]]); continue; }
      const m = perNom.get(ll.toLowerCase());
      if (m) punts.push([m[1], m[2], m[0]]); else noTrobats.push(ll);
    }
    zones.push({ comarca: c.comarca, pagines: c.pagines, habitat: z.habitat, sp: z.sp, punts });
  }
  if (noTrobats.length) console.warn('Atles: llocs no trobats', noTrobats);

  const R = atles.radiKm || 7;
  const perSp = new Map();
  for (const z of zones) for (const sp of z.sp) if (!perSp.has(sp)) perSp.set(sp, { prox: new Float32Array(n), zona: new Int16Array(n).fill(-1) });
  zones.forEach((z, zi) => {
    for (const sp of z.sp) {
      const S = perSp.get(sp);
      grid.cells.forEach(([, , lon, lat], i) => {
        let d = Infinity;
        for (const p of z.punts) d = Math.min(d, distKm(lon, lat, p[0], p[1]));
        const prox = d <= R ? 1 : d < 2 * R ? 1 - (d - R) / R : 0;
        if (prox > S.prox[i]) { S.prox[i] = prox; S.zona[i] = zi; }
      });
    }
  });

  return { sol, solNom, zones, perSp, noTrobats };
}

// ---------- Capes geogràfiques reals (CREAF + ICGC), generades per scripts/build-capes.py ----------
export const ARBRES_NOM = {
  pi_roig: 'pi roig', pi_negre: 'pi negre', avet: 'avet', pinassa: 'pinassa', pi_blanc: 'pi blanc', pinyer: 'pi pinyer',
  pinastre: 'pinastre', faig: 'faig', roure: 'roure', alzina: 'alzina', surera: 'surera', castanyer: 'castanyer',
  ribera: 'ribera', prat: 'prat', matollar: 'matollar',
};

/** Substitueix les aproximacions per les capes reals quan existeixen. Modifica S i elev. */
export function aplicaCapes(S, capes, elev) {
  if (!capes) return;
  const n = elev.length;
  if (capes.bosc?.length === n) {
    S.bosc = Float32Array.from(capes.bosc, p => Math.max(0.05, Math.min(1, p / 60)));
    S.boscPct = capes.bosc;
    S.arbres = capes.arbres;
  }
  if (capes.sol?.length === n || capes.calcari?.length === n) {
    const atles = S.sol;
    S.sol = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      let geo;
      if (capes.sol?.length === n) geo = capes.sol[i] == null ? NaN : capes.sol[i] / 100; // geologia + pH + vegetació (scripts/combina_sol.py)
      else {
        const t = capes.calcari[i] + capes.mixt[i] + capes.silici[i];
        geo = t > 0 ? (capes.silici[i] + 0.5 * capes.mixt[i]) / t : NaN;
      }
      // l'Atles descriu descalcificacions i matisos que el mapa 1:250.000 no recull
      S.sol[i] = isNaN(geo) ? atles[i] : isNaN(atles[i]) ? geo : 0.5 * geo + 0.5 * atles[i];
    }
    S.solGeo = true;
  }
  if (capes.elev?.length === n) {
    capes.elev.forEach((z, i) => { if (z != null) elev[i] = z; });
    S.obaga = capes.obaga; S.solell = capes.solell; S.pendent = capes.pendent;
  }
}
