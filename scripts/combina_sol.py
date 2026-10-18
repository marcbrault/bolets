"""Combina les fonts de substrat en un sol índex (0 = calcari, 100 = silici) i en valida cada font
amb els registres de GBIF d'espècies indicadores.

Fonts (de data/capes-<km>km.json): geologia 1:250.000, geologia 1:50.000, pH SoilGrids, vegetació indicadora (CREAF).
Validació: AUC = probabilitat que un registre d'espècie silicícola caigui en una cel·la amb índex més silici
que un registre d'espècie calcícola (0,5 = atzar, 1 = perfecte).
Sortida: camp 'sol' i 'sol_fonts' a data/capes-<km>km.json i un informe a cache/validacio-sol.json.
Ús: python scripts/combina_sol.py   (no necessita xarxa)
"""
import itertools, json, math
from pathlib import Path
import numpy as np

ARREL = Path(__file__).resolve().parent.parent
D = ARREL / 'data'
R = json.loads((D / 'registres.json').read_text())
CALCICOLES = ['rovello', 'llenega']
SILICICOLES = ['marcot', 'rovello-vinader', 'rossinyol', 'cep', 'rovello-avet', 'fredolic-gros']


def fonts(C):
    n = len(C['bosc'])
    F = {}

    def geo(suf):
        c, m, s = (np.array(C.get(k + suf, [0] * n), float) for k in ('calcari', 'mixt', 'silici'))
        t = c + m + s
        return np.where(t > 0, (s + 0.5 * m) / np.maximum(t, 1), np.nan)
    if 'calcari' in C:
        F['geologia250'] = geo('')
    if 'calcari50' in C:
        F['geologia50'] = geo('50')
    if 'ph' in C:
        ph = np.array(C['ph'], float) / 10
        # pH 5,5 o menys → 1 (àcid); 7,8 o més → 0 (calcari)
        F['ph'] = np.where(ph > 0, np.clip((7.8 - ph) / (7.8 - 5.5), 0, 1), np.nan)
    A = {k: np.array(v, float) for k, v in C['arbres'].items()}
    acid = A['surera'] + A['castanyer'] + A['pinastre']
    basic = A['pi_blanc'] + A['pinassa']
    F['vegetacio'] = np.where(acid + basic >= 3, acid / np.maximum(acid + basic, 1e-9), np.nan)
    return F


def cel_de(G):
    R6 = 6378137
    idx = {(c[0], c[1]): i for i, c in enumerate(G['cells'])}

    def f(lon, lat):
        x = lon * math.pi / 180 * R6
        y = R6 * math.log(math.tan(math.pi / 4 + lat * math.pi / 360))
        return idx.get((int((x - G['x0']) // G['step']), int((G['y1'] - y) // G['step'])))
    return f


def auc(v, ic, isl):
    a, b = v[ic], v[isl]
    a, b = a[~np.isnan(a)], b[~np.isnan(b)]
    if not len(a) or not len(b):
        return None
    a = np.sort(a)
    menors = np.searchsorted(a, b, 'left'); iguals = np.searchsorted(a, b, 'right') - menors
    return float((menors + 0.5 * iguals).sum() / (len(a) * len(b)))


def combina(F, pesos):
    num = sum(w * np.nan_to_num(F[k]) for k, w in pesos.items())
    den = sum(w * ~np.isnan(F[k]) for k, w in pesos.items())
    return np.where(den > 0, num / np.maximum(den, 1e-9), np.nan)


informe = {}
for km in (5, 10):
    G = json.loads((D / f'grid-{km}km.json').read_text())
    path = D / f'capes-{km}km.json'
    C = json.loads(path.read_text())
    F = fonts(C)
    cel = cel_de(G)
    regs = lambda sps: np.array([i for sp in sps for x in R['especies'][sp] if (x[3] or 0) <= 5000 and (i := cel(x[0], x[1])) is not None])
    ic, isl = regs(CALCICOLES), regs(SILICICOLES)
    rep = {'fonts': {k: round(auc(v, ic, isl), 3) for k, v in F.items()}}
    # cerca de pesos (0–3) que maximitzen l'AUC; la vegetació inclou hostes d'espècies indicadores, així que pesa com a màxim 1
    millor, best = None, -1
    noms = list(F)
    for ws in itertools.product(*[[0, 1, 2, 3] if k != 'vegetacio' else [0, 1] for k in noms]):
        if not any(ws):
            continue
        p = dict(zip(noms, ws))
        a = auc(combina(F, p), ic, isl)
        if a is not None and a > best + 0.002:  # només canvia si millora de debò
            best, millor = a, p
    rep['pesos'] = millor; rep['auc_combinat'] = round(best, 3)
    informe[km] = rep
    sol = combina(F, millor)
    C['sol'] = [None if np.isnan(v) else int(round(100 * v)) for v in sol]
    C['sol_fonts'] = millor
    path.write_text(json.dumps(C, separators=(',', ':'), ensure_ascii=False))
    print(km, 'km', rep)
(ARREL / 'cache').mkdir(exist_ok=True)
(ARREL / 'cache/validacio-sol.json').write_text(json.dumps(informe, indent=1))
