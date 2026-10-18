"""Calibra els paràmetres de cada espècie amb els registres de GBIF (data/registres.json + cache/registres-extra.json)
i en valida l'efecte amb les capes fines (data/fina.*).

Principis:
  - Es combina el valor expert (species.json) amb el que diuen les dades, amb un pes w = n / (n + 80) per a les dades
    (n = registres útils de l'espècie): com més registres, més pes.
  - Temporada: registres per mes dividits per l'esforç de mostreig (tots els fongs a Catalunya per mes).
  - Altitud: altitud exacta del punt (MET ICGC), percentils 5–25–75–95.
  - Temperatura: mitjana de 7 dies ERA5 corregida a l'altitud del punt (−0,65 °C/100 m).
  - Pluja: només es rebaixa el llindar (ERA5 a 25 km suavitza els aiguats), fins a la mitjana entre l'expert i la mediana.
  - Orientació: preferència pròpia d'obaga o solell respecte de tots els registres de bolets.
Validació: AUC del factor estàtic (altitud × hàbitat × sòl × orientació) als registres de l'espècie
contra els registres de la resta d'espècies (fons «target-group»), abans i després.
Ús: python scripts/calibra.py [--aplica]
"""
import gzip, json, math, sys
from pathlib import Path
import numpy as np

ARREL = Path(__file__).resolve().parent.parent
D = ARREL / 'data'
R = json.loads((D / 'registres.json').read_text())
X = json.loads((ARREL / 'cache/registres-extra.json').read_text())
# Sempre es parteix dels paràmetres experts (cache/species-expert.json), perquè tornar a calibrar sigui reproduïble.
# Els camps que no es calibren (noms, notes, hàbitat, solRang…) es prenen de data/species.json.
EXPERT = {s['id']: s for s in json.loads((ARREL / 'cache/species-expert.json').read_text())}
SPP = json.loads((D / 'species.json').read_text())
for s_ in SPP:
    for k in ('temporada', 'elev', 'temp', 'pluja'):
        s_[k] = EXPERT[s_['id']][k]
    s_.pop('orientacio', None)
LAPSE = -0.0065
APLICA = '--aplica' in sys.argv

# ---------- capes fines (500 m) per a la validació
m = json.loads((D / 'fina.json').read_text())
buf = gzip.decompress((D / 'fina.bin.gz').read_bytes())
NF = m['nx'] * m['ny']
FB = {b['nom']: np.frombuffer(buf, dtype=b['tipus'], count=NF, offset=b['offset']) for b in m['bandes']}
RM = 6378137


def px(lon, lat):
    c = int((lon * math.pi / 180 * RM - m['x0']) // m['step'])
    r = int((m['y1'] - RM * math.log(math.tan(math.pi / 4 + lat * math.pi / 360))) // m['step'])
    if 0 <= c < m['nx'] and 0 <= r < m['ny']:
        p = r * m['nx'] + c
        return p if FB['dins'][p] else None
    return None


def trap(x, a):
    a0, b, c, d = a
    if x <= a0 or x >= d: return 0.0
    if x < b: return (x - a0) / (b - a0)
    if x > c: return (d - x) / (d - c)
    return 1.0


def f_sol(sp, v):
    if v is None or np.isnan(v): return 0.85
    if sp.get('solRang'):
        a, b, c, d = sp['solRang']; lo, hi, mig = max(0, a - 0.05), min(1.05, d + 0.05), (b + c) / 2
        t = 1.0
        if v < b and mig >= 0.45: t = 0 if v <= lo else (v - lo) / (b - lo)
        elif v > c and mig <= 0.55: t = 0 if v >= hi else (hi - v) / (hi - c)
        return 0.25 + 0.75 * t
    return 1.0


def f_hab(sp, p):
    q = sum(0 if FB[k][p] == 255 else FB[k][p] for k in sp['arbres']) + 0.5 * sum(0 if FB[k][p] == 255 else FB[k][p] for k in sp.get('arbres2', []))
    return 0.12 + 0.88 * min(1, q / 100 / 0.3) ** 0.6


def estatic(sp, p):
    z = FB['elev'][p]; s = FB['sol'][p]; nord = 0 if FB['nord'][p] == -128 else FB['nord'][p]
    ori = 1 + sp.get('orientacio', 0) * nord / 100
    return trap(z, sp['elev']) * f_hab(sp, p) * f_sol(sp, np.nan if s == 255 else s / 100) * ori


def auc(pos, neg):
    neg = np.sort(np.asarray(neg)); pos = np.asarray(pos)
    if not len(pos) or not len(neg): return None
    lo = np.searchsorted(neg, pos, 'left'); hi = np.searchsorted(neg, pos, 'right')
    return float((lo + 0.5 * (hi - lo)).sum() / (len(pos) * len(neg)))


# píxel de cada registre (precisió ≤ 1,5 km)
PX = {sp: [px(x[0], x[1]) if (x[3] or 0) <= 1500 else None for x in L] for sp, L in R['especies'].items()}

# fons d'orientació: tots els registres amb pendent > 8°
tots_ori = [t[2] for sp in R['especies'] for t in X['terreny'][sp] if t and t[1] > 8]
fons_nord = sum(1 for a in tots_ori if a >= 315 or a < 45) / len(tots_ori)
fons_sud = sum(1 for a in tots_ori if 135 <= a < 225) / len(tots_ori)
ef = np.array(X['esforc_mesos'], float)

def auc_sp(spx):
    pos = [p for p in PX[spx['id']] if p is not None]
    neg = [p for o, ps in PX.items() if o != spx['id'] for p in ps if p is not None]
    return auc([estatic(spx, p) for p in pos], [estatic(spx, p) for p in neg])


informe = {}
for sp in SPP:
    sid = sp['id']; L = R['especies'][sid]; T = X['terreny'][sid]; M = X['meteo'][sid]
    n = sum(1 for t, x in zip(T, L) if t and (x[3] or 0) <= 1500)
    w = n / (n + 80)
    rep = {'n': n, 'w': round(w, 2)}
    abans = dict(temporada=list(sp['temporada']), elev=list(sp['elev']), temp=list(sp['temp']), pluja=sp['pluja'], orientacio=sp.get('orientacio', 0))
    # --- temporada
    mes = np.zeros(12)
    for x in L:
        if x[2] and len(x[2]) >= 7: mes[int(x[2][5:7]) - 1] += 1
    if mes.sum() >= 20:
        corr = mes / np.maximum(ef, 1); corr /= corr.max()
        nova = (1 - w) * np.array(sp['temporada']) + w * corr
        sp['temporada'] = [round(float(v), 2) for v in nova / nova.max()]
    # --- altitud (punt exacte)
    z = np.array([t[0] for t, x in zip(T, L) if t and (x[3] or 0) <= 1500], float)
    if len(z) >= 20:
        p5, p25, p75, p95 = np.percentile(z, [5, 25, 75, 95])
        dades = [max(0, p5 - 150), p25, p75, p95 + 150]
        nova = [int(round(((1 - w) * a + w * b) / 10) * 10) for a, b in zip(sp['elev'], dades)]
        if auc_sp({**sp, 'elev': nova}) >= auc_sp(sp) - 0.005:  # només si no empitjora la validació
            sp['elev'] = nova
        else:
            rep['elev_rebutjada'] = nova
    # --- temperatura (7 dies, corregida a l'altitud del punt) i pluja
    t7s, r3s = [], []
    for mm, t in zip(M, T):
        if not mm: continue
        dz = (t[0] - mm['z']) if (t and mm.get('z') is not None) else 0
        t7s.append(sum(mm['t'][-7:]) / 7 + LAPSE * dz)
        P = mm['p']; d = len(P) - 1
        r3s.append(max(P[j] + P[j - 1] + P[j - 2] for j in range(max(2, d - sp['lag'][1]), d - sp['lag'][0] + 1)))
    if len(t7s) >= 15:
        wt = len(t7s) / (len(t7s) + 60)
        q5, q25, q75, q95 = np.percentile(t7s, [5, 25, 75, 95])
        dades = [q5 - 3, q25 - 1, q75 + 1, q95 + 3]
        sp['temp'] = [round((1 - wt) * a + wt * b, 1) for a, b in zip(sp['temp'], dades)]
        med = float(np.median(r3s))
        if med < sp['pluja']:
            sp['pluja'] = int(round((sp['pluja'] + max(med, 10)) / 2))
        rep['t7_punt'] = [round(float(v), 1) for v in (q5, q25, np.median(t7s), q75, q95)]
        rep['r3_mediana'] = round(med, 1)
    # --- orientació pròpia
    asp = [t[2] for t, x in zip(T, L) if t and t[1] > 8 and (x[3] or 0) <= 1500]
    if len(asp) >= 25:
        fn = sum(1 for a in asp if a >= 315 or a < 45) / len(asp); fs = sum(1 for a in asp if 135 <= a < 225) / len(asp)
        # índex −1 (solell) … +1 (obaga), respecte del fons; amb encongiment segons la mida de la mostra
        idx = (fn / fons_nord - fs / fons_sud) / (fn / fons_nord + fs / fons_sud + 1e-9)
        nova = round(float(np.clip(0.25 * idx * len(asp) / (len(asp) + 40), -0.2, 0.2)), 3)
        if auc_sp({**sp, 'orientacio': nova}) >= auc_sp(sp) - 0.005:
            sp['orientacio'] = nova
        rep['obaga_solell'] = [round(fn, 2), round(fs, 2)]
    # --- validació (estàtica) abans / després
    pos = [p for p in PX[sid] if p is not None]
    neg = [p for o, ps in PX.items() if o != sid for p in ps if p is not None]
    sp_abans = {**sp, **abans}
    rep['auc_abans'] = round(auc([estatic(sp_abans, p) for p in pos], [estatic(sp_abans, p) for p in neg]), 3)
    rep['auc_despres'] = round(auc([estatic(sp, p) for p in pos], [estatic(sp, p) for p in neg]), 3)
    rep['abans'] = abans
    rep['despres'] = dict(temporada=sp['temporada'], elev=sp['elev'], temp=sp['temp'], pluja=sp['pluja'], orientacio=sp.get('orientacio', 0))
    informe[sid] = rep
    print(f"{sid:16} n={n:3d} w={w:.2f}  AUC estàtic {rep['auc_abans']} → {rep['auc_despres']}  elev {abans['elev']} → {sp['elev']}  "
          f"temp {abans['temp']} → {sp['temp']}  pluja {abans['pluja']} → {sp['pluja']}  ori {sp.get('orientacio', 0)}")

print('fons: obaga', round(fons_nord, 2), 'solell', round(fons_sud, 2))
(ARREL / 'cache/calibracio.json').write_text(json.dumps(informe, indent=1, ensure_ascii=False))
if APLICA:
    (D / 'species.json').write_text(json.dumps(SPP, ensure_ascii=False, indent=1) + '\n')
    print('species.json actualitzat')
