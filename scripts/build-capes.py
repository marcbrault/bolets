"""Construeix les capes geogràfiques per cel·la (data/capes-<km>km.json).

Fonts (es descarreguen al runner de GitHub; vegeu .github/workflows/capes.yml):
  - CREAF, Mapa de Cobertes del Sòl de Catalunya, 4a edició (2009), llegenda nivell 5 (WMS MiraMon)
  - ICGC, Mapa geològic de Catalunya 1:250.000 (vectorial)
  - ICGC, Model d'Elevacions del Terreny (WCS icc:met)
Ús: pip install numpy pillow pyproj geopandas rasterio requests && python scripts/build-capes.py
"""
import io, json, math, re, sys, time, zipfile, tempfile, collections, unicodedata
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


# ---------------------------------------------------------------- CREAF: cobertes del sòl
MCSC = 'https://opengis.grumets.cat/cgi-bin/MCSC/MiraMon.cgi'
GRUPS = [  # (clau, patrons sobre la categoria normalitzada)
    ('pi_roig', r'pi roig|pinus sylvestris'), ('pi_negre', r'pi negre|pinus uncinata'),
    ('avet', r'avet|abies'), ('pinassa', r'pinassa|pinus nigra'), ('pi_blanc', r'pi blanc|pinus halepensis'),
    ('pinyer', r'pi pinyer|pinus pinea'), ('pinastre', r'pinastre|pinus pinaster'),
    ('faig', r'faig|fageda|fagus'), ('roure', r'roure|roured|quercus (humilis|pubescens|petraea|robur|faginea|cerrioides)'),
    ('alzina', r'alzin|quercus (ilex|rotundifolia)|carrasc'), ('surera', r'surer|suro|quercus suber'),
    ('castanyer', r'castany'), ('ribera', r'ribera|pollanc|om |omed|vern|freix|salze|plataner|avellan'),
    ('prat', r'prat|pastur|herbassar'), ('matollar', r'matoll|bruguer|garriga|boixed|ginestar'),
]
BOSC = re.compile(r'bosc|pined|pi |pins|avet|fage|roured|alzin|sured|castany|ribera|planifoli|conifer|esclerofil|plantaci')
NO_BOSC = re.compile(r'urba|conreu|regadiu|secan|fruiter|vinya|oliver|aigua|roquissar|tarter|platja|vial|infraestr')


def classifica_coberta(cat):
    c = norm(cat)
    grups = [k for k, p in GRUPS if re.search(p, c)]
    bosc = bool(BOSC.search(c)) and not NO_BOSC.search(c) and 'prat' not in grups
    return bosc, grups


def cobertes():
    res = 50
    x0, y0, x1, y1 = BBOX
    nt = 2
    tw = math.ceil((x1 - x0) / res / nt)
    tiles = []
    for ty in range(nt):
        for tx in range(nt):
            bx0, by1 = x0 + tx * tw * res, y1 - ty * tw * res
            r = get(MCSC, dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetMap', LAYERS='MCSCv4Nivell5', STYLES='',
                               CRS='EPSG:25831', BBOX=f'{bx0},{by1 - tw * res},{bx0 + tw * res},{by1}',
                               WIDTH=tw, HEIGHT=tw, FORMAT='image/png'), timeout=600)
            a = np.asarray(Image.open(io.BytesIO(r.content)).convert('RGBA'))
            tiles.append((bx0, by1, a))
    mosaic = np.zeros((nt * tw, nt * tw), np.uint32)
    for k, (bx0, by1, a) in enumerate(tiles):
        ty, tx = divmod(k, nt)
        rgba = a.astype(np.uint32)
        codi = (rgba[..., 0] << 24) | (rgba[..., 1] << 16) | (rgba[..., 2] << 8) | rgba[..., 3]
        codi[rgba[..., 3] == 0] = 0
        mosaic[ty * tw:(ty + 1) * tw, tx * tw:(tx + 1) * tw] = codi
    # calibra cada color amb GetFeatureInfo (vot entre 3 píxels)
    colors, inv, comptes = np.unique(mosaic, return_inverse=True, return_counts=True)
    inv = inv.reshape(mosaic.shape)
    ordre = np.argsort(inv.ravel(), kind='stable')
    inici = np.concatenate([[0], np.cumsum(comptes)])
    cat_de_color = {}

    def consulta(x, y):
        r = get(MCSC, dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetFeatureInfo', LAYERS='MCSCv4Nivell5',
                           QUERY_LAYERS='MCSCv4Nivell5', STYLES='', CRS='EPSG:25831',
                           BBOX=f'{x - 3},{y - 3},{x + 3},{y + 3}', WIDTH=3, HEIGHT=3, I=1, J=1,
                           INFO_FORMAT='text/xml', FORMAT='image/png'))
        m = re.search(r'name="CATEGORY"[^>]*value="([^"]*)"', r.content.decode('latin-1'))
        return m.group(1).strip() if m else None

    def calibra(ci):
        if colors[ci] == 0 or comptes[ci] < 20:
            return ci, None
        vots = collections.Counter()
        for k in np.random.default_rng(int(ci)).choice(ordre[inici[ci]:inici[ci + 1]], size=3, replace=False):
            y, x = divmod(int(k), mosaic.shape[1])
            cat = consulta(x0 + (x + 0.5) * res, y1 - (y + 0.5) * res)
            if cat:
                vots[cat] += 1
        return ci, vots.most_common(1)[0][0] if vots else None

    with ThreadPoolExecutor(4) as ex:
        for ci, cat in ex.map(calibra, range(len(colors))):
            cat_de_color[ci] = cat
    cats = sorted({c for c in cat_de_color.values() if c})
    # classe de sortida: 0 = sense dades; 1 = no bosc; 2.. = categories
    cls_de_cat = {c: i + 2 for i, c in enumerate(cats)}
    lut = np.array([cls_de_cat.get(cat_de_color.get(ci), 1 if colors[ci] else 0) for ci in range(len(colors))], np.int64)
    classes = lut[inv]
    cnt = raster_a_cel(classes, x0, y1, res, len(cats) + 2)
    info = {c: classifica_coberta(c) for c in cats}
    diag['cobertes'] = {c: {'bosc': b, 'grups': g, 'pixels': int((classes == cls_de_cat[c]).sum())} for c, (b, g) in info.items()}
    log(f'MCSC: {len(colors)} colors, {len(cats)} categories')
    out = {}
    for km, C in cnt.items():
        tot = C[:, 1:].sum(1).clip(min=1)
        bosc = sum(C[:, cls_de_cat[c]] for c in cats if info[c][0])
        g = {k: sum((C[:, cls_de_cat[c]] for c in cats if k in info[c][1]), np.zeros(len(tot), np.int64)) for k, _ in GRUPS}
        out[km] = {'bosc': np.round(100 * bosc / tot).astype(int).tolist(),
                   'arbres': {k: np.round(100 * v / tot).astype(int).tolist() for k, v in g.items()},
                   '_dades': (C[:, 1:].sum(1) > 0)}
    return out


# ---------------------------------------------------------------- ICGC: geologia
GEOL = 'https://datacloud.icgc.cat/datacloud/descarregues-web/bd/icgc_mgl250mv01_etrs89.zip'
CALC = r'calcar|calcari|calcilut|calcaren|dolomi|marg|guix|evapor|travert|carbonat|sal gemma|halit|creta'
SILI = (r'granit|granodior|tonalit|diorit|pissarr|esquist|gneis|quarsit|gres|arenisc|saul|basalt|volcan|porfir|'
        r'migmatit|cornubian|lidit|riolit|andesit|filit|arcos|licorell|piroclast|leucogran|ignimbrit|grauvac')
MIXT = r'conglomerat|al.?luvi|col.?luvi|quaternari|grava|llim|argil|lutit|bretxa|terrass|ventall|dipos'


def classifica_roca(text):
    t = norm(text)
    c, s = bool(re.search(CALC, t)), bool(re.search(SILI, t))
    if c and not s:
        return 1
    if s and not c:
        return 3
    if c or s or re.search(MIXT, t):
        return 2
    return 0


def geologia():
    import geopandas as gpd
    from rasterio import features
    from rasterio.transform import from_origin
    tmp = Path(tempfile.mkdtemp())
    zipfile.ZipFile(io.BytesIO(get(GEOL, timeout=900).content)).extractall(tmp)
    fitxers = sorted(tmp.rglob('*.shp')) + sorted(tmp.rglob('*.gpkg'))
    log('Geologia: ' + ', '.join(f.name for f in fitxers))
    gdfs = [gpd.read_file(f) for f in fitxers]
    gdf = max((g for g in gdfs if g.geom_type.isin(['Polygon', 'MultiPolygon']).any()), key=len).to_crs(25831)
    txt = gdf.drop(columns='geometry').astype(str).agg(' '.join, axis=1)
    gdf['cls'] = [classifica_roca(t) for t in txt]
    mostra = collections.Counter(zip(txt.str.slice(0, 160), gdf['cls']))
    diag['geologia'] = {'camps': list(gdf.columns), 'classes': collections.Counter(map(int, gdf['cls'])),
                        'mostra': [{'t': t, 'cls': int(c), 'n': n} for (t, c), n in mostra.most_common(400)]}
    res = 100
    x0, y0, x1, y1 = BBOX
    w, h = math.ceil((x1 - x0) / res), math.ceil((y1 - y0) / res)
    ras = features.rasterize(((g, int(c)) for g, c in zip(gdf.geometry, gdf['cls']) if c), out_shape=(h, w),
                             transform=from_origin(x0, y1, res, res), fill=0, dtype='int32')
    cnt = raster_a_cel(ras.astype(np.int64), x0, y1, res, 4)
    out = {}
    for km, C in cnt.items():
        tot = C[:, 1:].sum(1).clip(min=1)
        out[km] = {k: np.round(100 * C[:, i] / tot).astype(int).tolist() for k, i in (('calcari', 1), ('mixt', 2), ('silici', 3))}
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
        'geologia': "ICGC, Mapa geològic de Catalunya 1:250.000",
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
                v.pop('_dades', None)
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
