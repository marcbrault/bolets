"""Construeix les capes geogràfiques per cel·la (data/capes-<km>km.json).

Fonts (es descarreguen al runner de GitHub; vegeu .github/workflows/capes.yml):
  - CREAF, Mapa de Cobertes del Sòl de Catalunya, 4a edició (2009), llegenda nivell 5 (WMS MiraMon)
  - ICGC, Mapa geològic de Catalunya 1:250.000 (vectorial)
  - ICGC, Model d'Elevacions del Terreny (WCS icc:met)
Ús: pip install numpy pillow pyproj geopandas rasterio requests && python scripts/build-capes.py
"""
import html, io, json, math, re, sys, time, zipfile, tempfile, collections, unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np, requests
from PIL import Image
from pyproj import Transformer

DATA = Path(__file__).resolve().parent.parent / 'data'
UA = {'User-Agent': 'MapaBoletaire/1.0 (github.com/marcbrault/bolets)'}
BBOX = (258000, 4485000, 532000, 4750000)  # Catalunya en EPSG:25831 (x0, y0, x1, y1)
to3857 = Transformer.from_crs(25831, 3857, always_xy=True)
to25831 = Transformer.from_crs(4326, 25831, always_xy=True)
GRIDS = {km: json.loads((DATA / f'grid-{km}km.json').read_text()) for km in (5, 10)}
diag = {}


def log(msg, nivell='notice'):
    print(f'::{nivell} title=Capes::{msg}', flush=True)


def get(url, params=None, intents=5, timeout=120):
    for k in range(intents):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout)
            if r.status_code == 200:
                return r
            err = f'HTTP {r.status_code}'
        except requests.RequestException as e:
            err = str(e)
        time.sleep(3 * (k + 1))
    raise RuntimeError(f'{url}: {err}')


def norm(s):
    return unicodedata.normalize('NFKD', s.lower()).encode('ascii', 'ignore').decode()


def cel_index(grid, x3857, y3857):
    """Índex de cel·la (o -1) per a coordenades Web Mercator."""
    col = np.floor((x3857 - grid['x0']) / grid['step']).astype(np.int64)
    row = np.floor((grid['y1'] - y3857) / grid['step']).astype(np.int64)
    lut = np.full(grid['nx'] * grid['ny'], -1, np.int64)
    for i, (c, r, *_) in enumerate(grid['cells']):
        lut[r * grid['nx'] + c] = i
    ok = (col >= 0) & (col < grid['nx']) & (row >= 0) & (row < grid['ny'])
    out = np.full(col.shape, -1, np.int64)
    out[ok] = lut[row[ok] * grid['nx'] + col[ok]]
    return out


def raster_a_cel(classes, x0, y1, res, ncl):
    """Comptatge de píxels per classe i cel·la, per a cada graella. classes: int array (0 = sense dades)."""
    h, w = classes.shape
    xs = x0 + (np.arange(w) + 0.5) * res
    ys = y1 - (np.arange(h) + 0.5) * res
    out = {}
    for km, g in GRIDS.items():
        n = len(g['cells'])
        cnt = np.zeros((n, ncl), np.int64)
        for r0 in range(0, h, 256):  # per blocs de files per estalviar memòria
            X, Y = np.meshgrid(xs, ys[r0:r0 + 256])
            mx, my = to3857.transform(X, Y)
            ci = cel_index(g, mx, my).ravel()
            cl = classes[r0:r0 + 256].ravel()
            ok = ci >= 0
            np.add.at(cnt, (ci[ok], cl[ok]), 1)
        out[km] = cnt
    return out



# ---------------------------------------------------------------- WMS: mosaic + calibratge de colors
def wms_classifica(url, capa, res, nt, consulta, vots_base=3, vots_grans=11):
    """Descarrega la capa en nt×nt peces i, per a cada color, consulta GetFeatureInfo en diversos píxels.
    Com que dues categories poden compartir color, cada color es reparteix entre les categories segons els vots.
    Retorna (comptes per color i cel·la per graella, matriu color→{categoria: pes})."""
    x0, y0, x1, y1 = BBOX
    tw = math.ceil((x1 - x0) / res / nt)
    mosaic = np.zeros((nt * tw, nt * tw), np.uint32)
    for ty in range(nt):
        for tx in range(nt):
            bx0, by1 = x0 + tx * tw * res, y1 - ty * tw * res
            r = get(url, dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetMap', LAYERS=capa, STYLES='',
                              CRS='EPSG:25831', BBOX=f'{bx0},{by1 - tw * res},{bx0 + tw * res},{by1}',
                              WIDTH=tw, HEIGHT=tw, FORMAT='image/png', TRANSPARENT='TRUE'), timeout=600)
            a = np.asarray(Image.open(io.BytesIO(r.content)).convert('RGBA')).astype(np.uint32)
            codi = (a[..., 0] << 24) | (a[..., 1] << 16) | (a[..., 2] << 8) | a[..., 3]
            codi[a[..., 3] == 0] = 0
            mosaic[ty * tw:(ty + 1) * tw, tx * tw:(tx + 1) * tw] = codi
    colors, inv, comptes = np.unique(mosaic, return_inverse=True, return_counts=True)
    inv = inv.reshape(mosaic.shape)
    ordre = np.argsort(inv.ravel(), kind='stable')
    inici = np.concatenate([[0], np.cumsum(comptes)])
    total = comptes[colors != 0].sum()

    def calibra(ci):
        if colors[ci] == 0 or comptes[ci] < 10:
            return ci, {}
        nv = vots_grans if comptes[ci] / total > 0.002 else vots_base
        mostra = np.random.default_rng(int(ci)).choice(ordre[inici[ci]:inici[ci + 1]], size=min(nv, comptes[ci]), replace=False)
        vots = collections.Counter()
        for k in mostra:
            y, x = divmod(int(k), mosaic.shape[1])
            try:
                cat = consulta(x0 + (x + 0.5) * res, y1 - (y + 0.5) * res)
            except Exception:
                cat = None
            if cat:
                vots[cat] += 1
        n = sum(vots.values())
        return ci, {c: v / n for c, v in vots.items()}

    with ThreadPoolExecutor(4) as ex:
        pesos = dict(ex.map(calibra, range(len(colors))))
    cnt = raster_a_cel(inv.astype(np.int64), x0, y1, res, len(colors))
    return colors, comptes, pesos, cnt


def agrega(cnt, pesos, valor):
    """Suma, per cel·la, els píxels de cada color ponderats per valor(categoria) (0–1). Retorna també els píxels amb dades."""
    n = len(pesos)
    w = np.array([sum(p * valor(c) for c, p in pesos[ci].items()) for ci in range(n)])
    conegut = np.array([1.0 if pesos[ci] else 0.0 for ci in range(n)])
    return cnt @ w, cnt @ conegut


def html_net(s):
    return html.unescape(re.sub(r'<[^>]+>', ' ', s)).strip()


# ---------------------------------------------------------------- CREAF: cobertes del sòl
MCSC = 'https://opengis.grumets.cat/cgi-bin/MCSC/MiraMon.cgi'
GRUPS = [  # (clau, patrons sobre la categoria normalitzada)
    ('pi_roig', r'pi roig|pinus sylvestris'), ('pi_negre', r'pi negre|pinus uncinata'),
    ('avet', r'avet|abies'), ('pinassa', r'pinassa|pinus nigra'), ('pi_blanc', r'pi blanc|pinus halepensis'),
    ('pinyer', r'pi pinyer|pinus pinea'), ('pinastre', r'pinastre|pinus pinaster'),
    ('faig', r'faig|fageda|fagus'), ('roure', r'roure|roured|quercus (humilis|pubescens|petraea|robur|faginea|cerrioides)'),
    ('alzina', r'alzin|quercus (ilex|rotundifolia)|carrasc'), ('surera', r'surer|sured|suro|quercus suber'),
    ('castanyer', r'castany'), ('ribera', r'ribera|pollanc|omed|vern|freix|salze|plataner|avellan|bedoll'),
    ('prat', r'prat|pastur|herbassar'), ('matollar', r'matoll|bruguer|garriga|boixed|ginestar'),
]
BOSC = re.compile(r'%cc|regeneracio|plantacio|bosc|pineda|avetosa|fageda|roureda|alzinar|sureda|castanyeda|freixeneda|bedollar|caducifoli|ribera')
NO_BOSC = re.compile(r'conreu|fruiter|oliver|vinya|prat|herbassar|zones verdes|parc')


def classifica_coberta(cat):
    c = norm(cat)
    grups = [k for k, p in GRUPS if re.search(p, c)]
    bosc = bool(BOSC.search(c)) and not NO_BOSC.search(c)
    return bosc, grups


def cobertes():
    def consulta(x, y):
        r = get(MCSC, dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetFeatureInfo', LAYERS='MCSCv4Nivell5',
                           QUERY_LAYERS='MCSCv4Nivell5', STYLES='', CRS='EPSG:25831',
                           BBOX=f'{x - 3},{y - 3},{x + 3},{y + 3}', WIDTH=3, HEIGHT=3, I=1, J=1,
                           INFO_FORMAT='text/xml', FORMAT='image/png'))
        m = re.search(r'name="CATEGORY"[^>]*value="([^"]*)"', r.content.decode('latin-1'))
        return html.unescape(m.group(1)).strip() if m else None

    colors, comptes, pesos, cnt = wms_classifica(MCSC, 'MCSCv4Nivell5', 50, 2, consulta)
    info = {}
    for p in pesos.values():
        for c in p:
            info.setdefault(c, classifica_coberta(c))
    px = collections.Counter()
    for ci, p in pesos.items():
        for c, w in p.items():
            px[c] += comptes[ci] * w
    diag['cobertes'] = {c: {'bosc': info[c][0], 'grups': info[c][1], 'pixels': int(px[c])} for c in info}
    diag['cobertes_colors_barrejats'] = [{c: round(w, 2) for c, w in p.items()} for p in pesos.values() if len(p) > 1]
    log(f'MCSC: {len(colors)} colors, {len(info)} categories, {len(diag["cobertes_colors_barrejats"])} colors compartits')
    out = {}
    for km, C in cnt.items():
        bosc, tot = agrega(C, pesos, lambda c: float(info[c][0]))
        tot = tot.clip(min=1)
        arbres = {k: np.round(100 * agrega(C, pesos, lambda c, k=k: float(k in info[c][1]))[0] / tot).astype(int).tolist() for k, _ in GRUPS}
        out[km] = {'bosc': np.round(100 * bosc / tot).astype(int).tolist(), 'arbres': arbres}
    return out


# ---------------------------------------------------------------- ICGC: geologia (WMS 1:250.000)
GEOWMS = 'https://geoserveis.icgc.cat/servei/catalunya/geologia-territorial/wms'
GEOCAPA = 'unitats-geologiques-250000'
CALC = r'calcar|calcari|calcilut|calcaren|dolomi|marg|guix|evapor|travert|carbonat|sal gemma|halit|creta|tosca'
SILI = (r'granit|granodior|tonalit(a|es)\b|diorit|pissarr|esquist|gneis|quarsit|basalt|volcan|porfir|migmatit|cornubian|'
        r'lidit|riolit|andesit|filit|arcos|licorell|piroclast|leucogran|ignimbrit|grauvac|saul|metamorf|pelit|ritmit|cornean|ofit')
DETR = r'gres|arenisc|conglomerat|lutit|argil|llim|grava|sorr|bretxa|al.?luvi|col.?luvi|terrass|ventall|dipos'


def descripcio_geo(text):
    """Del text pla de l'ICGC ('capçalera; valors'), en treu Descripcio i Descripcio_protolit."""
    m = re.match(r'@\S+\s+(.*?;)\s+(.*)$', text)
    if not m:
        return text
    camps, vals = m.group(1).split(';'), m.group(2).split(';')
    d = dict(zip(camps, vals))
    return ' '.join(v for k in ('Descripcio', 'Descripcio_protolit') if (v := d.get(k)) and v != 'Null') or text


def classifica_roca(text):
    """1 = calcari, 2 = mixt/detrític, 3 = silici. La primera roca esmentada és la dominant."""
    t = norm(re.sub(r'\([^)]*\)', ' ', descripcio_geo(text)))  # sense topònims
    pos = lambda pat: (m.start() if (m := re.search(pat, t)) else 10 ** 6)
    c, s, d = pos(CALC), pos(SILI), pos(DETR)
    if s < 10 ** 6 and c == 10 ** 6:
        return 3
    if c < 10 ** 6 and s == 10 ** 6:
        return 1  # roques carbonatades, o detrítics amb margues/calcàries (sòls calcaris de la Depressió Central)
    if c < 10 ** 6 or s < 10 ** 6 or d < 10 ** 6:
        return 2
    return 0


def geologia():
    formats = ['application/json', 'text/plain', 'text/html']

    def consulta(x, y):
        for f in list(formats):
            r = get(GEOWMS, dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetFeatureInfo', LAYERS=GEOCAPA,
                                 QUERY_LAYERS=GEOCAPA, STYLES='', CRS='EPSG:25831',
                                 BBOX=f'{x - 10},{y - 10},{x + 10},{y + 10}', WIDTH=3, HEIGHT=3, I=1, J=1,
                                 INFO_FORMAT=f, FEATURE_COUNT=1, FORMAT='image/png'), intents=3)
            t = r.content.decode('utf-8', 'replace')
            if 'ServiceException' in t or len(t.strip()) < 20:
                if f in formats and len(formats) > 1 and 'ServiceException' in t:
                    formats.remove(f)
                continue
            if f == 'application/json':
                try:
                    props = [ft.get('properties', {}) for ft in json.loads(t).get('features', [])]
                    t = ' | '.join(f'{k}: {v}' for p in props for k, v in p.items() if isinstance(v, str))
                except ValueError:
                    pass
            else:
                t = html_net(t)
            t = re.sub(r'\s+', ' ', t).strip()
            return t[:1500] or None
        return None

    colors, comptes, pesos, cnt = wms_classifica(GEOWMS, GEOCAPA, 100, 2, consulta)
    cls = {}
    for p in pesos.values():
        for t in p:
            cls.setdefault(t, classifica_roca(t))
    px = collections.Counter()
    for ci, p in pesos.items():
        for t, w in p.items():
            px[t] += comptes[ci] * w
    diag['geologia'] = {'format': formats[0], 'classes': collections.Counter(cls.values()),
                        'mostra': [{'t': descripcio_geo(t)[:200], 'cls': cls[t], 'px': int(n)} for t, n in px.most_common(400)]}
    log(f'Geologia: {len(colors)} colors, {len(cls)} unitats, format {formats[0]}, sense classe: {sum(1 for v in cls.values() if v == 0)}')
    out = {}
    for km, C in cnt.items():
        cal, _ = agrega(C, pesos, lambda t: float(cls[t] == 1))
        mix, _ = agrega(C, pesos, lambda t: float(cls[t] == 2))
        sil, _ = agrega(C, pesos, lambda t: float(cls[t] == 3))
        tot = (cal + mix + sil).clip(min=1e-9)
        ok = (cal + mix + sil) > 0
        out[km] = {k: np.where(ok, np.round(100 * v / tot), 0).astype(int).tolist() for k, v in (('calcari', cal), ('mixt', mix), ('silici', sil))}
    return out

# ---------------------------------------------------------------- ICGC: elevacions
WCS = 'https://geoserveis.icgc.cat/icc_mdt/wcs/service'


def bbox_cel(g, c, r):
    R = 6378137
    lon = lambda x: x / R * 180 / math.pi
    lat = lambda y: (2 * math.atan(math.exp(y / R)) - math.pi / 2) * 180 / math.pi
    xa, xb = g['x0'] + c * g['step'], g['x0'] + (c + 1) * g['step']
    ya, yb = g['y1'] - (r + 1) * g['step'], g['y1'] - r * g['step']
    X, Y = to25831.transform([lon(xa), lon(xb), lon(xa), lon(xb)], [lat(ya), lat(ya), lat(yb), lat(yb)])
    return min(X), min(Y), max(X), max(Y)


def relleu_cel(args):
    g, c, r, res = args
    xa, ya, xb, yb = bbox_cel(g, c, r)
    while (xb - xa) / res * (yb - ya) / res > 34000:
        res *= 1.1
    txt = get(WCS, dict(SERVICE='WCS', VERSION='1.0.0', REQUEST='GetCoverage', COVERAGE='icc:met', CRS='EPSG:25831',
                        BBOX=f'{xa:.0f},{ya:.0f},{xb:.0f},{yb:.0f}', RESX=f'{res:.1f}', RESY=f'{res:.1f}', FORMAT='ArcGrid')).text
    linies = txt.splitlines()
    cap = {l.split()[0].upper(): float(l.split()[1]) for l in linies[:6]}
    z = np.loadtxt(io.StringIO('\n'.join(linies[6:])), dtype=np.float32)
    z[z == cap.get('NODATA_VALUE', -9999)] = np.nan
    z[z < -100] = np.nan
    if np.isnan(z).all():
        return None
    cs = cap['CELLSIZE']
    dzdy, dzdx = np.gradient(z, cs)  # files cap avall = sud
    dzdn = -dzdy                       # pendent cap al nord
    gm = np.hypot(dzdx, dzdn)
    pend = np.degrees(np.arctan(gm))
    with np.errstate(invalid='ignore', divide='ignore'):
        cosnord = -dzdn / gm            # 1 = vessant que mira al nord
    inclinat = pend > 8
    v = ~np.isnan(pend)
    return {'elev': float(np.nanmean(z)), 'pendent': float(np.nanmean(pend)),
            'obaga': float((inclinat & (cosnord > 0.5)).sum() / max(v.sum(), 1)),
            'solell': float((inclinat & (cosnord < -0.5)).sum() / max(v.sum(), 1))}


def elevacions():
    out = {}
    for km, g in GRIDS.items():
        res = 30 if km == 5 else 60
        with ThreadPoolExecutor(6) as ex:
            rs = list(ex.map(relleu_cel, [(g, c, r, res) for c, r, *_ in g['cells']]))
        falten = sum(x is None for x in rs)
        log(f'MET {km} km: {len(rs) - falten} cel·les, {falten} sense dades')
        out[km] = {'elev': [round(x['elev']) if x else None for x in rs],
                   'pendent': [round(x['pendent'], 1) if x else None for x in rs],
                   'obaga': [round(100 * x['obaga']) if x else None for x in rs],
                   'solell': [round(100 * x['solell']) if x else None for x in rs]}
    return out


if __name__ == '__main__':
    parts = sys.argv[1:] or ['cobertes', 'geologia', 'elevacions']
    resultat = {km: {} for km in GRIDS}
    fonts = {
        'cobertes': 'CREAF, Mapa de Cobertes del Sòl de Catalunya, 4a ed. (2009), nivell 5',
        'geologia': "ICGC, Mapa geològic de Catalunya 1:250.000 (WMS geologia territorial)",
        'elevacions': "ICGC, Model d'Elevacions del Terreny (WCS icc:met)",
    }
    for km in GRIDS:  # conserva les capes ja construïdes si només se'n refà una part
        f = DATA / f'capes-{km}km.json'
        if f.exists():
            resultat[km] = json.loads(f.read_text())
    errors = []
    for p in parts:
        try:
            t = time.time()
            r = globals()[p]()
            for km, v in r.items():
                resultat[km].update(v)
                resultat[km].setdefault('fonts', {})[p] = fonts[p]
            log(f'{p}: fet en {time.time() - t:.0f} s')
        except Exception as e:
            errors.append(p)
            log(f'{p}: {e}', 'error')
    for km, v in resultat.items():
        v['km'] = km
        v['generat'] = time.strftime('%Y-%m-%d')
        (DATA / f'capes-{km}km.json').write_text(json.dumps(v, separators=(',', ':'), ensure_ascii=False))
    (DATA / 'capes-diagnosi.json').write_text(json.dumps(diag, ensure_ascii=False, indent=1, default=int))
    sys.exit(1 if len(errors) == len(parts) else 0)
