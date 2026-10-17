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
export function factorSol(pref, v) {
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
