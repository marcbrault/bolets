# 🍄 Mapa Boletaire de Catalunya

Visor web que calcula, per a cada zona de Catalunya i cada dia, un **índex d'idoneïtat (0–100)** per buscar bolets, per espècie. Web estàtica: es publica amb GitHub Pages, sense servidor.

## Què fa

- **19 espècies**: rovelló, pinetell, rovelló d'avet, rovelló vinader, cep, rossinyol, ou de reig, trompeta, carlet, llenegall, esteperol, camagroc, fredolic, fredolic gros, llenega, carrereta, moixernó, marçot i múrgola.
- **Mapa de calor continu** retallat a Catalunya (graella de 10 km o 5 km).
- **Línia de temps**: 14 dies enrere + 7 de previsió, amb reproducció animada.
- **Fitxa de zona**: índex, factors, pluja, temperatura, gràfic d'evolució i millor finestra prevista.
- **Capes**: índex, pluja 7 dies, temperatura, altitud, bosc (aprox.) i sòl (aprox.).
- **Coneixement expert** de l'*Atles del Boletaire* (Osona, Berguedà, Cerdanya, Garrotxa, Ripollès, Selva, Pla de l'Estany, Gironès). Vegeu [`docs/analisi-atles.md`](docs/analisi-atles.md).
- Cerca de municipis, geolocalització, mapes base ICGC / OpenTopoMap / OSM, versió mòbil.

## El model

Índex = 100 × temporada × pluja × temperatura × altitud × bosc × gelades × substrat × bonus Atles

| Factor | Com es calcula |
|---|---|
| Temporada | Pes mensual per espècie, interpolat per dia |
| Pluja | Màxim de pluja acumulada en 3 dies dins la finestra de latència de l'espècie (p. ex. 8–16 dies) + reserva d'aigua del sòl (pluja − ET0) |
| Temperatura | Mitjana dels últims 7 dies dins el rang òptim de l'espècie |
| Gelades | Penalització si la mínima dels últims 4 dies baixa del llindar |
| Altitud | Rang d'altitud de l'espècie |
| Bosc | Aproximació pel relleu (pendent de la capa forestal real) |
| Substrat | Afinitat silici/calcari |
| Atles | Fins a +35 % a les zones citades al llibre |

## Publicar-ho a GitHub Pages

1. Crea un repositori nou a GitHub (p. ex. `bolets`) i puja-hi el contingut d'aquesta carpeta (no la carpeta en si).
2. A **Settings → Pages**, tria *Deploy from a branch*, branca `main`, carpeta `/ (root)`.
3. En un parell de minuts serà a `https://EL-TEU-USUARI.github.io/bolets/`.
4. **Recomanat**: a **Settings → Actions → General → Workflow permissions**, activa *Read and write*. Després, a la pestanya **Actions**, llança *Actualitza meteo* a mà un cop. A partir d'aquí s'executarà cada dia i els visitants carregaran un sol fitxer en comptes de fer centenars de peticions a Open-Meteo.

Sense l'Action també funciona: el navegador descarrega la meteo directament d'Open-Meteo i la guarda 3 hores.

## Provar-ho al teu ordinador

Cal un servidor local (els mòduls JS no funcionen obrint l'`index.html` directament):

```bash
cd bolets
python3 -m http.server 8000
# obre http://localhost:8000
```

## Estructura

```
index.html            pàgina
css/app.css           estils
js/app.js             mapa, interfície i estat
js/scoring.js         model d'idoneïtat
js/coneixement.js     substrat + zones de l'Atles
js/heatmap.js         render del mapa de calor
js/weather.js         Open-Meteo (navegador i Action)
data/species.json     paràmetres de cada espècie
data/atles.json       zones citades a l'Atles del Boletaire
data/sols.json        substrat aproximat
data/grid-*.json      graelles de 5 i 10 km
data/municipis.json   947 municipis (cerca i noms)
scripts/              generació de dades
.github/workflows/    actualització diària de la meteo
```

## Properes fases

1. **Capa forestal real** (Mapa Forestal / Mapa de Cobertes del Sòl del CREAF): tipus d'arbre per cel·la.
2. **Mapa geològic de l'ICGC** per substituir el substrat aproximat.
3. **Orientació i pendent** amb el model d'elevacions de l'ICGC (obac a principi de temporada, solell al final).
4. **Pluja de primavera** (Open-Meteo Archive) per a la previsió de ceps.
5. Més capítols de l'Atles i observacions dels usuaris.

Model orientatiu. Respecteu la regulació de cada espai natural i la propietat privada, i no culliu cap bolet que no conegueu amb seguretat.
