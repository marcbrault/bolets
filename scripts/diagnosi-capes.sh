#!/usr/bin/env bash
# Diagnosi única: comprova els serveis del CREAF i l'ICGC des del runner i desa les respostes a diag/.
set -u
mkdir -p diag
c() { curl -sS -L -m 60 -A "MapaBoletaire/1.0 (github.com/marcbrault/bolets)" "$@"; }

# --- CREAF: MCSC 4a edició, nivell 5 (GetFeatureInfo en 3 punts: Vidrà, Montseny, Lleida)
M='https://opengis.grumets.cat/cgi-bin/MCSC/MiraMon.cgi?SERVICE=WMS&VERSION=1.3.0'
i=0
for b in 435000,4660000,435100,4660100 451000,4625000,451100,4625100 300000,4610000,300100,4610100; do
  i=$((i+1))
  for f in text/xml text/html; do
    c "$M&REQUEST=GetFeatureInfo&LAYERS=MCSCv4Nivell5&QUERY_LAYERS=MCSCv4Nivell5&STYLES=&CRS=EPSG:25831&BBOX=$b&WIDTH=5&HEIGHT=5&I=2&J=2&INFO_FORMAT=$f&FORMAT=image/png" > "diag/creaf-gfi-$i.${f#text/}" 2>&1
  done
done
c "$M&REQUEST=GetMap&LAYERS=MCSCv4Nivell5&STYLES=&CRS=EPSG:25831&BBOX=430000,4655000,440000,4665000&WIDTH=400&HEIGHT=400&FORMAT=image/png" -o diag/creaf-getmap.png
c "$M&REQUEST=GetMap&LAYERS=VBA_REC&STYLES=&CRS=EPSG:25831&BBOX=430000,4655000,440000,4665000&WIDTH=400&HEIGHT=400&FORMAT=image/png" -o diag/creaf-rec.png
c "$M&REQUEST=GetCapabilities" -o diag/creaf-caps.xml
c "$M&REQUEST=GetLegendGraphic&LAYER=MCSCv4Nivell5&FORMAT=image/png" -o diag/creaf-llegenda.png

# --- ICGC: elevacions (WCS)
W='https://geoserveis.icgc.cat/icc_mdt/wcs/service?SERVICE=WCS&VERSION=1.0.0'
c "$W&REQUEST=GetCoverage&COVERAGE=icc:met&CRS=EPSG:25831&BBOX=430000,4655000,435000,4660000&RESX=30&RESY=30&FORMAT=ArcGrid" -o diag/met.asc
c "$W&REQUEST=GetCapabilities" -o diag/met-caps.xml
c "$W&REQUEST=DescribeCoverage&COVERAGE=icc:met" -o diag/met-describe.xml

# --- ICGC: geologia. Descobreix els endpoints WMS des de les pàgines de l'ICGC i en llista les capes
for p in https://www.icgc.cat/ca/Geoinformacio-i-mapes/Geoinformacio-en-linia-Geoserveis/WMS-Geologia-territorial \
         https://www.icgc.cat/en/Geoinformation-and-Maps/Data-and-products/Geologic-and-geophysical-geoinformation/Geological-cartography/Map-lithological-groups-Catalonia-1250000; do
  c "$p" | grep -oE 'https?://[a-zA-Z0-9./_?=&;:-]*(geoserveis|datacloud|descarregues)[a-zA-Z0-9./_?=&;:%-]*' >> diag/icgc-urls.txt
done
sort -u diag/icgc-urls.txt -o diag/icgc-urls.txt
grep -iE 'wms' diag/icgc-urls.txt | sed -E 's/[?].*//' | sort -u | head -8 | while read -r u; do
  n=$(echo "$u" | tr -c 'a-zA-Z0-9' _)
  c "$u?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0" -o "diag/caps-$n.xml"
  grep -oE '<Name>[^<]+</Name>' "diag/caps-$n.xml" | head -60 > "diag/capes-$n.txt"
done
# llistat del datacloud de geologia (si n'hi ha)
c https://datacloud.icgc.cat/datacloud/ | grep -oE 'href="[^"]+"' | head -100 > diag/datacloud.txt
ls -la diag
