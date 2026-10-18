"""Capes estàtiques a 500 m per a tot Catalunya (data/fina.json + data/fina.bin.gz).

Graella alineada amb la de 5 km (cada cel·la de 5 km = 10 × 10 caselles de 500 m), en Web Mercator.
Capes (una per banda, graella completa nx × ny, fila a fila des del nord):
  elev   int16  altitud mitjana (m), MET ICGC a 100 m
  pend   uint8  pendent mitjà (°)
  nord   int8   orientació: % obaga − % solell (pendents > 8°), de −100 a 100
  sol    uint8  índex de sòl 0 (calcari) … 100 (silici); 255 = sense dades. Geologia 1:50.000 + pH SoilGrids
  bosc   uint8  % de bosc (CREAF MCSC-4)
  <grup> uint8  % de cada grup d'arbres o hàbitat (pi_roig, …, prat, matollar)
  dins   uint8  1 = dins de Catalunya
Ús (runner): python scripts/build-fina.py   — fa servir cache/cobertes* i cache/geologia50* per als colors.
"""
import gzip, importlib.util, io, json, math, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
from PIL import Image

ARREL = Path(__file__).resolve().parent.parent
sys.argv = [sys.argv[0]]
spec = importlib.util.spec_from_file_location('bc', ARREL / 'scripts/build-capes.py')
bc = importlib.util.module_from_spec(spec); spec.loader.exec_module(bc)
log, get, BBOX, to3857 = bc.log, bc.get, bc.BBOX, bc.to3857

G5 = bc.GRIDS[5]
import os
F = int(os.environ.get('FACTOR', '10'))  # caselles per cel·la de 5 km: 10 → 500 m, 50 → 100 m
TILE = 4  # amb F > 10: trossos de 4 × 4 cel·les de 5 km (20 km)
STEP = G5['step'] / F
NX, NY = G5['nx'] * F, G5['ny'] * F
X0, Y1 = G5['x0'], G5['y1']
N = NX * NY
log(f'graella fina: {NX} × {NY}, pas {STEP:.1f} m Mercator ({round(5000 / F)} m reals)')


def idx_fi(x25831, y25831):
    """Índex de casella fina (o -1) per a coordenades EPSG:25831."""
    mx, my = to3857.transform(x25831, y25831)
    c = np.floor((mx - X0) / STEP).astype(np.int64)
    r = np.floor((Y1 - my) / STEP).astype(np.int64)
    ok = (c >= 0) & (c < NX) & (r >= 0) & (r < NY)
    out = np.full(c.shape, -1, np.int64)
    out[ok] = r[ok] * NX + c[ok]
    return out


_IDX = {}


def idx_raster(shape, x0, y1, res):
    """Índex de casella fina per a cada píxel d'un ràster EPSG:25831 (es calcula un cop per mida i origen)."""
    k = (shape, x0, y1, res)
    if k not in _IDX:
        h, w = shape
        xs = x0 + (np.arange(w) + 0.5) * res
        out = np.empty(h * w, np.int64)
        for r0 in range(0, h, 400):
            ys = y1 - (np.arange(r0, min(h, r0 + 400)) + 0.5) * res
            X, Y = np.meshgrid(xs, ys)
            out[r0 * w:(r0 + len(ys)) * w] = idx_fi(X, Y).ravel()
        _IDX[k] = out
    return _IDX[k]


def agrega_raster(valors, x0, y1, res):
    """Mitjana per casella fina d'un ràster EPSG:25831 (valors 2D, NaN = buit). Retorna (suma, n)."""
    ii = idx_raster(valors.shape, x0, y1, res)
    v = valors.ravel()
    ok = (ii >= 0) & ~np.isnan(v)
    return (np.bincount(ii[ok], weights=v[ok], minlength=N)[:N], np.bincount(ii[ok], minlength=N)[:N].astype(float))


# ---------------------------------------------------------------- màscara de Catalunya
def mascara():
    from rasterio import features
    from rasterio.transform import from_origin
    from shapely.geometry import shape
    from shapely.ops import transform as stransform
    geom = json.loads((ARREL / 'data/catalunya.geojson').read_text())['features'][0]['geometry']
    from pyproj import Transformer
    t = Transformer.from_crs(4326, 3857, always_xy=True)
    g = stransform(lambda x, y, z=None: t.transform(x, y), shape(geom))
    m = features.rasterize([(g, 1)], out_shape=(NY, NX), transform=from_origin(X0, Y1, STEP, STEP), fill=0, dtype='uint8')
    return m.ravel()


# ---------------------------------------------------------------- MET (ICGC, 100 m)
def met():
    res, tile = (100, 10000) if F <= 10 else (50, 5000)  # a 100 m cal el MET a 50 m perquè no quedin forats
    x0, y0, x1, y1 = BBOX
    W, H = int((x1 - x0) / res), int((y1 - y0) / res)
    Z = np.full((H, W), np.nan, np.float32)

    def peca(args):
        tx, ty = args
        bx0, by1 = x0 + tx * tile, y1 - ty * tile
        try:
            t = get(bc.WCS, dict(SERVICE='WCS', VERSION='1.0.0', REQUEST='GetCoverage', COVERAGE='icc:met', CRS='EPSG:25831',
                                 BBOX=f'{bx0},{by1 - tile},{bx0 + tile},{by1}', WIDTH=tile // res, HEIGHT=tile // res,
                                 FORMAT='ArcGrid'), intents=4).text
            L = t.splitlines()
            z = np.loadtxt(io.StringIO('\n'.join(L[6:])), dtype=np.float32)
            z[z < -100] = np.nan
            return tx, ty, z
        except Exception:
            return tx, ty, None

    nt_x, nt_y = math.ceil((x1 - x0) / tile), math.ceil((y1 - y0) / tile)
    with ThreadPoolExecutor(8) as ex:
        for tx, ty, z in ex.map(peca, [(a, b) for b in range(nt_y) for a in range(nt_x)]):
            if z is None:
                continue
            r0, c0 = ty * (tile // res), tx * (tile // res)
            h, w = min(z.shape[0], H - r0), min(z.shape[1], W - c0)
            if h > 0 and w > 0:
                Z[r0:r0 + h, c0:c0 + w] = z[:h, :w]
    log(f'MET: {np.isfinite(Z).mean() * 100:.0f} % de píxels amb dades')
    dzdy, dzdx = np.gradient(Z, res)
    dzdn = -dzdy
    gm = np.hypot(dzdx, dzdn)
    pend = np.degrees(np.arctan(gm))
    with np.errstate(invalid='ignore', divide='ignore'):
        cosn = -dzdn / gm
    incl = pend > 8
    nord = np.where(np.isnan(pend), np.nan, np.where(incl & (cosn > 0.5), 1.0, np.where(incl & (cosn < -0.5), -1.0, 0.0)))
    out = {}
    for nom, v in (('elev', Z), ('pend', pend), ('nord', nord)):
        s, n = agrega_raster(v, x0, y1, res)
        out[nom] = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    return out


# ---------------------------------------------------------------- WMS amb colors calibrats (cache)
def mosaic_wms(url, capa, res, nt):
    x0, y0, x1, y1 = BBOX
    tw = math.ceil((x1 - x0) / res / nt)
    mos = np.zeros((nt * tw, nt * tw), np.uint32)
    for ty in range(nt):
        for tx in range(nt):
            bx0, by1 = x0 + tx * tw * res, y1 - ty * tw * res
            r = get(url, dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetMap', LAYERS=capa, STYLES='', CRS='EPSG:25831',
                              BBOX=f'{bx0},{by1 - tw * res},{bx0 + tw * res},{by1}', WIDTH=tw, HEIGHT=tw,
                              FORMAT='image/png', TRANSPARENT='TRUE'), timeout=600)
            a = np.asarray(Image.open(io.BytesIO(r.content)).convert('RGBA')).astype(np.uint32)
            codi = (a[..., 0] << 24) | (a[..., 1] << 16) | (a[..., 2] << 8) | a[..., 3]
            codi[a[..., 3] == 0] = 0
            mos[ty * tw:(ty + 1) * tw, tx * tw:(tx + 1) * tw] = codi
    return mos, x0, y1


def per_color(nom, mos, valor):
    """Per a cada píxel, el valor (0–1 o NaN) derivat de les categories calibrades del seu color."""
    z = np.load(ARREL / f'cache/{nom}.npz')
    pj = json.loads((ARREL / f'cache/{nom}-pesos.json').read_text())
    colors = z['colors']
    taula = np.full(len(colors), np.nan)
    for k, p in pj.items():
        if p:
            vv = [(valor(c), w) for c, w in p.items()]
            vv = [(v, w) for v, w in vv if not np.isnan(v)]
            if vv:
                taula[int(k)] = sum(v * w for v, w in vv) / sum(w for _, w in vv)
    pos = np.searchsorted(colors, mos.ravel())
    pos = np.clip(pos, 0, len(colors) - 1)
    trobat = colors[pos] == mos.ravel()
    out = np.where(trobat, taula[pos], np.nan).reshape(mos.shape)
    log(f'{nom}: {trobat.mean() * 100:.1f} % de píxels amb color conegut')
    return out


def cobertes():
    mos, x0, y1 = mosaic_wms(bc.MCSC, 'MCSCv4Nivell5', 50, 2)
    info = {}
    pj = json.loads((ARREL / 'cache/cobertes-pesos.json').read_text())
    for p in pj.values():
        for c in p:
            info.setdefault(c, bc.classifica_coberta(c))
    out = {}
    conegut = per_color('cobertes', mos, lambda c: 1.0)
    _, n = agrega_raster(np.where(np.isnan(conegut), np.nan, 1.0), x0, y1, 50)
    s, _ = agrega_raster(per_color('cobertes', mos, lambda c: float(info[c][0])), x0, y1, 50)
    out['bosc'] = np.where(n > 0, 100 * s / np.maximum(n, 1), np.nan)
    for k, _ in bc.GRUPS:
        s, _ = agrega_raster(per_color('cobertes', mos, lambda c, k=k: float(k in info[c][1])), x0, y1, 50)
        out[k] = np.where(n > 0, 100 * s / np.maximum(n, 1), np.nan)
    return out


def geologia50():
    mos, x0, y1 = mosaic_wms(bc.GEOWMS, 'unitats-geologiques-50000', 50, 3)
    cls = {}
    val = {1: 0.0, 2: 0.5, 3: 1.0}

    def v(t):
        if t not in cls:
            cls[t] = bc.classifica_roca(t)
        return val.get(cls[t], np.nan)
    s, n = agrega_raster(per_color('geologia50', mos, v), x0, y1, 50)
    return np.where(n > 0, s / np.maximum(n, 1), np.nan)


# ---------------------------------------------------------------- pH (SoilGrids 250 m)
def ph():
    import rasterio
    lon = (np.arange(NX) + 0.5) * STEP + X0
    lat = Y1 - (np.arange(NY) + 0.5) * STEP
    LON = lon / 6378137 * 180 / math.pi
    LAT = (2 * np.arctan(np.exp(lat / 6378137)) - math.pi / 2) * 180 / math.pi
    out = np.full((NY, NX), np.nan)
    for lon0 in np.arange(0.1, 3.4, 1.1):
        for lat0 in np.arange(40.45, 42.9, 1.0):
            capes = []
            for prof in ('0-5cm', '5-15cm'):
                url = (f'{bc.SG}&SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=phh2o_{prof}_mean&FORMAT=GEOTIFF_INT16'
                       f'&SUBSET=long({lon0:.2f},{min(lon0 + 1.1, 3.4):.2f})&SUBSET=lat({lat0:.2f},{min(lat0 + 1.0, 42.9):.2f})'
                       '&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&OUTPUTCRS=http://www.opengis.net/def/crs/EPSG/0/4326')
                r = get(url, timeout=300)
                with rasterio.MemoryFile(r.content) as mf, mf.open() as ds:
                    a = ds.read(1).astype(float); a[(a <= 0)] = np.nan; tr = ds.transform
                capes.append(a / 10)
            v = np.nanmean(np.stack(capes), axis=0)
            # interpolació bilineal (els píxels de 250 m de SoilGrids no fan blocs)
            fx = (LON - tr.c) / tr.a - 0.5; fy = (LAT - tr.f) / tr.e - 0.5
            X, Y = np.meshgrid(fx, fy)
            x0i, y0i = np.floor(X).astype(int), np.floor(Y).astype(int)
            wx, wy = X - x0i, Y - y0i
            num = np.zeros((NY, NX)); den = np.zeros((NY, NX))
            for dy, dx, w in ((0, 0, (1 - wx) * (1 - wy)), (0, 1, wx * (1 - wy)), (1, 0, (1 - wx) * wy), (1, 1, wx * wy)):
                yy, xx = y0i + dy, x0i + dx
                ok = (yy >= 0) & (yy < v.shape[0]) & (xx >= 0) & (xx < v.shape[1])
                val = np.full((NY, NX), np.nan)
                val[ok] = v[yy[ok], xx[ok]]
                bo = ok & ~np.isnan(val)
                num[bo] += (w * val)[bo]; den[bo] += w[bo]
            sub = np.where(den > 0.25, num / np.maximum(den, 1e-9), np.nan)
            out = np.where(np.isnan(out), sub, out)
    return np.clip((7.3 - out) / (7.3 - 6.2), 0, 1).ravel()


if __name__ == '__main__':
    t0 = time.time()
    capes = {'dins': mascara()}
    log(f'màscara: {int(capes["dins"].sum())} caselles dins de Catalunya')
    capes.update(met()); log(f'MET fet ({time.time() - t0:.0f} s)')
    capes.update(cobertes()); log(f'cobertes fetes ({time.time() - t0:.0f} s)')
    g50 = geologia50(); log(f'geologia fet ({time.time() - t0:.0f} s)')
    p = ph(); log(f'pH fet ({time.time() - t0:.0f} s)')
    sol = np.where(np.isnan(g50), p, np.where(np.isnan(p), g50, 0.5 * g50 + 0.5 * p))  # pesos de combina_sol.py (1 : 1)
    capes['sol'] = sol * 100
    bandes = [('elev', 'int16'), ('pend', 'uint8'), ('nord', 'int8'), ('sol', 'uint8'), ('bosc', 'uint8')] + \
             [(k, 'uint8') for k, _ in bc.GRUPS] + [('dins', 'uint8')]
    arr = []
    for nom, tipus in bandes:
        v = np.asarray(capes[nom], float).reshape(-1)
        if nom == 'nord':
            v = v * 100
        buit = {'int16': -32768, 'uint8': 255, 'int8': -128}[tipus]
        info = np.iinfo(tipus)
        a = np.where(np.isnan(v), buit, np.clip(np.round(v), info.min + 1 if tipus != 'uint8' else 0, info.max - 1 if tipus == 'uint8' else info.max)).astype(tipus)
        if nom != 'dins':
            a[capes['dins'] == 0] = buit
        arr.append((nom, tipus, buit, a.reshape(NY, NX)))
        capes.pop(nom, None)

    def empaqueta(talls):
        buf, cap = io.BytesIO(), []
        for (nom, tipus, buit, a), t in zip(arr, talls):
            cap.append({'nom': nom, 'tipus': tipus, 'offset': buf.tell(), 'buit': buit})
            buf.write(np.ascontiguousarray(t).tobytes())
        return buf.getvalue(), cap

    fonts = f'MET ICGC ({"100" if F <= 10 else "50"} m), CREAF MCSC-4 (50 m), ICGC geologia 1:50.000, ISRIC SoilGrids pH (250 m)'
    if F <= 10:
        raw, cap = empaqueta([a for *_, a in arr])
        (ARREL / 'data/fina.bin.gz').write_bytes(gzip.compress(raw, 9))
        (ARREL / 'data/fina.json').write_text(json.dumps({
            'generat': time.strftime('%Y-%m-%d'), 'nx': NX, 'ny': NY, 'x0': X0, 'y1': Y1, 'step': STEP, 'factor': F,
            'bandes': cap, 'grups': [k for k, _ in bc.GRUPS], 'fonts': fonts}, ensure_ascii=False))
        log(f'fet en {time.time() - t0:.0f} s; {len(raw) / 1e6:.1f} MB → {(ARREL / "data/fina.bin.gz").stat().st_size / 1e6:.2f} MB comprimit')
    else:
        dir_ = ARREL / f'data/fina{round(5000 / F)}'
        dir_.mkdir(exist_ok=True)
        for f in dir_.glob('*.bin.gz'):
            f.unlink()
        tp = TILE * F
        dins = arr[-1][3]
        trossos, total = [], 0
        for tr in range(math.ceil(NY / tp)):
            for tc in range(math.ceil(NX / tp)):
                sl = (slice(tr * tp, (tr + 1) * tp), slice(tc * tp, (tc + 1) * tp))
                if not dins[sl].any():
                    continue
                talls = []
                for nom, _, buit, a in arr:
                    t = a[sl]
                    if t.shape != (tp, tp):  # tros de la vora: s'omple fins a la mida completa
                        ple = np.full((tp, tp), 0 if nom == 'dins' else buit, a.dtype)
                        ple[:t.shape[0], :t.shape[1]] = t
                        t = ple
                    talls.append(t)
                raw, cap = empaqueta(talls)
                z = gzip.compress(raw, 9)
                (dir_ / f'{tc}_{tr}.bin.gz').write_bytes(z)
                trossos.append(f'{tc}_{tr}'); total += len(z)
        (dir_ / 'index.json').write_text(json.dumps({
            'generat': time.strftime('%Y-%m-%d'), 'tros': tp, 'x0': X0, 'y1': Y1, 'step': STEP, 'factor': F,
            'bandes': cap, 'grups': [k for k, _ in bc.GRUPS], 'trossos': trossos, 'fonts': fonts}, ensure_ascii=False))
        log(f'fet en {time.time() - t0:.0f} s; {len(trossos)} trossos de {tp} × {tp}, {total / 1e6:.1f} MB comprimits')
