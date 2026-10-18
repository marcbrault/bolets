"""Enriqueix data/registres.json per calibrar el model (s'executa al runner; vegeu registres.yml).

Sortida: cache/registres-extra.json
  esforc_mesos: registres de fongs (tots) a Catalunya per mes (1–12), per corregir l'esforç de mostreig
  esforc_anys:  idem per any
  terreny: { sp: [[elev, pendent, aspect] | null, ...] }   alineat amb data/registres.json
  meteo:   { sp: [ {p: pluja 45 dies abans (fins al dia), t: tmitjana 10 dies, n: tmin 5 dies} | null, ...] }
"""
import io, json, math, sys, time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np, requests
from pyproj import Transformer

ARREL = Path(__file__).resolve().parent.parent
R = json.loads((ARREL / 'data/registres.json').read_text())
UA = {'User-Agent': 'MapaBoletaire/1.0 (github.com/marcbrault/bolets)'}
to25831 = Transformer.from_crs(4326, 25831, always_xy=True)
out = {'generat': time.strftime('%Y-%m-%d')}


def log(m, n='notice'):
    print(f'::{n} title=Registres extra::{m}', flush=True)


def get(url, params, intents=5, timeout=90):
    err = ''
    for k in range(intents):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout)
            if r.status_code == 200:
                return r
            err = f'HTTP {r.status_code} {r.text[:200]}'
            if r.status_code == 429:
                time.sleep(60)
        except requests.RequestException as e:
            err = str(e)
        time.sleep(3 * (k + 1))
    raise RuntimeError(err)


# ---- 1) Esforç de mostreig: tots els fongs a la caixa de Catalunya
def esforc():
    base = dict(kingdomKey=5, decimalLatitude='40.45,42.9', decimalLongitude='0.1,3.4', hasCoordinate='true',
                hasGeospatialIssue='false', limit=0)
    m = get('https://api.gbif.org/v1/occurrence/search', dict(base, facet='month', **{'month.facetLimit': 12})).json()
    a = get('https://api.gbif.org/v1/occurrence/search', dict(base, facet='year', **{'year.facetLimit': 200})).json()
    mesos = {int(c['name']): c['count'] for c in m['facets'][0]['counts']} if m.get('facets') else {}
    anys = {int(c['name']): c['count'] for c in a['facets'][0]['counts']} if a.get('facets') else {}
    out['esforc_mesos'] = [mesos.get(i, 0) for i in range(1, 13)]
    out['esforc_anys'] = dict(sorted(anys.items()))
    log(f"esforç per mesos: {out['esforc_mesos']}")


# ---- 2) Terreny al punt (ICGC WCS, 30 m, finestra de 150 m)
WCS = 'https://geoserveis.icgc.cat/icc_mdt/wcs/service'


def terreny_punt(lonlat):
    lon, lat = lonlat
    x, y = to25831.transform(lon, lat)
    try:
        t = get(WCS, dict(SERVICE='WCS', VERSION='1.0.0', REQUEST='GetCoverage', COVERAGE='icc:met', CRS='EPSG:25831',
                          BBOX=f'{x - 75:.0f},{y - 75:.0f},{x + 75:.0f},{y + 75:.0f}', RESX='30', RESY='30',
                          FORMAT='ArcGrid'), intents=3).text
        L = t.splitlines()
        cap = {l.split()[0].upper(): float(l.split()[1]) for l in L[:6]}
        z = np.loadtxt(io.StringIO('\n'.join(L[6:])), dtype=float)
        z[z <= -100] = np.nan
        if np.isnan(z).all():
            return None
        dzdy, dzdx = np.gradient(z, cap['CELLSIZE'])
        gx, gn = np.nanmean(dzdx), -np.nanmean(dzdy)  # pendent cap a l'est i cap al nord
        pend = math.degrees(math.atan(math.hypot(gx, gn)))
        aspect = (math.degrees(math.atan2(-gx, -gn)) + 360) % 360  # direcció cap on mira el vessant (0 = N)
        return [round(float(np.nanmean(z))), round(pend, 1), round(aspect)]
    except Exception:
        return None


def terreny():
    tots = [(sp, k, (x[0], x[1])) for sp, L in R['especies'].items() for k, x in enumerate(L)]
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(terreny_punt, [t[2] for t in tots]))
    T = {sp: [None] * len(L) for sp, L in R['especies'].items()}
    for (sp, k, _), v in zip(tots, res):
        T[sp][k] = v
    out['terreny'] = T
    log(f'terreny: {sum(v is not None for v in res)} de {len(res)} punts')


# ---- 3) Meteo històrica (Open-Meteo Archive) per cel·la de 0,1° i any
def meteo():
    grups = defaultdict(list)
    for sp, L in R['especies'].items():
        for k, x in enumerate(L):
            d = x[2]
            if not d or len(d) != 10 or int(d[:4]) < 1990 or (x[3] or 0) > 5000:
                continue
            grups[(round(x[0], 1), round(x[1], 1), int(d[:4]))].append((sp, k, d))
    M = {sp: [None] * len(L) for sp, L in R['especies'].items()}
    avui = time.strftime('%Y-%m-%d')
    fets = errors = 0
    for (lon, lat, any_), regs in sorted(grups.items(), key=lambda kv: kv[0][2]):
        ini, fi = f'{any_ - 1}-12-01', min(f'{any_}-12-31', avui)
        try:
            j = get('https://archive-api.open-meteo.com/v1/archive',
                    dict(latitude=lat, longitude=lon, start_date=ini, end_date=fi, timezone='Europe/Madrid',
                         daily='precipitation_sum,temperature_2m_mean,temperature_2m_min')).json()['daily']
        except Exception as e:
            errors += 1
            if errors <= 3:
                log(f'Open-Meteo {lon},{lat},{any_}: {e}', 'warning')
            continue
        idx = {d: i for i, d in enumerate(j['time'])}
        for sp, k, d in regs:
            i = idx.get(d)
            if i is None or i < 45:
                continue
            P = j['precipitation_sum'][i - 45:i + 1]
            T = j['temperature_2m_mean'][i - 9:i + 1]
            N = j['temperature_2m_min'][i - 4:i + 1]
            if None in P or None in T or None in N:
                continue
            M[sp][k] = {'p': [round(v, 1) for v in P], 't': [round(v, 1) for v in T], 'n': [round(v, 1) for v in N]}
        fets += 1
        time.sleep(0.4)  # per sota dels límits d'ús gratuït
    out['meteo'] = M
    log(f'meteo: {fets} sèries (cel·la-any), {errors} errors, {sum(v is not None for L in M.values() for v in L)} registres amb meteo')


for f in [esforc, terreny, meteo]:
    try:
        f()
    except Exception as e:
        log(f'{f.__name__}: {e}', 'error')
(ARREL / 'cache').mkdir(exist_ok=True)
(ARREL / 'cache/registres-extra.json').write_text(json.dumps(out, separators=(',', ':')))
