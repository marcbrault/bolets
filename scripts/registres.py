"""Descarrega de GBIF totes les observacions georeferenciades de les espècies de l'app dins Catalunya.

Sortida: data/registres.json
  { generat, font, especies: { id: [[lon, lat, 'AAAA-MM-DD' | 'AAAA-MM' | null, incertesa_m | null, tipus, dataset], ...] },
    taxons: { id: [[nom, taxonKey], ...] }, datasets: { clau: [títol, n] } }
GBIF recull iNaturalist, herbaris (BCN, MA-Fungi…), atles i projectes de ciència ciutadana.
Ús: pip install requests && python scripts/registres.py
"""
import json, sys, time
from collections import Counter
from pathlib import Path
import requests

DATA = Path(__file__).resolve().parent.parent / 'data'
API = 'https://api.gbif.org/v1'
UA = {'User-Agent': 'MapaBoletaire/1.0 (github.com/marcbrault/bolets)'}
NOMS = {
    'rovello': ['Lactarius sanguifluus'],
    'pinetell': ['Lactarius deliciosus'],
    'rovello-avet': ['Lactarius salmonicolor'],
    'rovello-vinader': ['Lactarius vinosus'],
    'cep': ['Boletus edulis', 'Boletus pinophilus', 'Boletus aereus', 'Boletus reticulatus'],
    'rossinyol': ['Cantharellus cibarius', 'Cantharellus pallens', 'Cantharellus subpruinosus'],
    'oudereig': ['Amanita caesarea'],
    'trompeta': ['Craterellus cornucopioides'],
    'carlet': ['Hygrophorus russula'],
    'camagroc': ['Craterellus lutescens'],
    'fredolic': ['Tricholoma terreum'],
    'fredolic-gros': ['Tricholoma portentosum'],
    'llenega': ['Hygrophorus latitabundus', 'Hygrophorus limacinus'],
    'carrereta': ['Marasmius oreades'],
    'moixerno': ['Calocybe gambosa'],
    'marcot': ['Hygrophorus marzuolus'],
    'murgola': ['Morchella'],
    'llenegall': ['Hygrophorus persoonii', 'Hygrophorus dichrous'],
    'esteperol': ['Leccinellum lepidum', 'Leccinellum corsicum', 'Leccinum lepidum', 'Leccinum corsicum'],
}
TIPUS = {'HUMAN_OBSERVATION': 'O', 'PRESERVED_SPECIMEN': 'H', 'MATERIAL_SAMPLE': 'H', 'OCCURRENCE': 'A',
         'MACHINE_OBSERVATION': 'O', 'MATERIAL_CITATION': 'B', 'OBSERVATION': 'O', 'LIVING_SPECIMEN': 'H'}


def get(path, **params):
    for k in range(6):
        try:
            r = requests.get(API + path, params=params, headers=UA, timeout=60)
            if r.status_code == 200:
                return r.json()
            err = f'HTTP {r.status_code}'
        except requests.RequestException as e:
            err = str(e)
        time.sleep(2 * (k + 1))
    raise RuntimeError(f'{path}: {err}')


cat = json.loads((DATA / 'catalunya.geojson').read_text())['features'][0]['geometry']
POLYS = [cat['coordinates']] if cat['type'] == 'Polygon' else cat['coordinates']


def in_ring(x, y, r):
    c = False
    j = len(r) - 1
    for i in range(len(r)):
        if (r[i][1] > y) != (r[j][1] > y) and x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]:
            c = not c
        j = i
    return c


def a_catalunya(x, y):
    return any(in_ring(x, y, p[0]) and not any(in_ring(x, y, h) for h in p[1:]) for p in POLYS)


def taxon(nom):
    m = get('/species/match', name=nom, kingdom='Fungi', verbose='false')
    if m.get('matchType') == 'NONE':
        return None
    return m.get('acceptedUsageKey') or m.get('usageKey'), m.get('scientificName'), m.get('status')


def data_de(o):
    if o.get('year') and o.get('month') and o.get('day'):
        return f"{o['year']:04d}-{o['month']:02d}-{o['day']:02d}"
    if o.get('year') and o.get('month'):
        return f"{o['year']:04d}-{o['month']:02d}"
    return None


especies, taxons, datasets = {}, {}, Counter()
titols = {}
for sp, noms in NOMS.items():
    claus = []
    for nom in noms:
        t = taxon(nom)
        if t and t[0] not in [c[1] for c in claus]:
            claus.append([t[1], t[0]])
    taxons[sp] = claus
    vistos, regs = set(), []
    for _, key in claus:
        offset = 0
        while True:
            r = get('/occurrence/search', taxonKey=key, decimalLatitude='40.45,42.9', decimalLongitude='0.1,3.4',
                    hasCoordinate='true', hasGeospatialIssue='false', occurrenceStatus='PRESENT', limit=300, offset=offset)
            for o in r['results']:
                lon, lat = o.get('decimalLongitude'), o.get('decimalLatitude')
                if lon is None or not a_catalunya(lon, lat):
                    continue
                d = data_de(o)
                k = (round(lon, 4), round(lat, 4), d)
                if k in vistos:
                    continue
                vistos.add(k)
                ds = o.get('datasetKey', '')[:8]
                datasets[ds] += 1
                titols.setdefault(ds, o.get('datasetName') or o.get('institutionCode') or o.get('publishingOrgKey', ''))
                unc = o.get('coordinateUncertaintyInMeters')
                regs.append([round(lon, 5), round(lat, 5), d, round(unc) if unc else None,
                             TIPUS.get(o.get('basisOfRecord'), 'A'), ds])
            offset += 300
            if r.get('endOfRecords') or offset >= r.get('count', 0) or offset >= 99000:
                break
    especies[sp] = regs
    amb_data = sum(1 for x in regs if x[2] and len(x[2]) == 10)
    print(f'::notice title=Registres {sp}::{len(regs)} registres ({amb_data} amb data completa) · taxons: {claus}', flush=True)

out = {'generat': time.strftime('%Y-%m-%d'), 'font': 'GBIF.org (www.gbif.org), dades amb llicència CC0 / CC BY / CC BY-NC',
       'especies': especies, 'taxons': taxons,
       'datasets': {k: [titols.get(k, ''), n] for k, n in datasets.most_common()}}
(DATA / 'registres.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
print(f"::notice title=Registres::total {sum(len(v) for v in especies.values())}, {len(datasets)} conjunts de dades")
if not any(especies.values()):
    sys.exit(1)
