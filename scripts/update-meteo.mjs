// Descarrega la meteo de les graelles i la desa a data/meteo-<km>km.json.
// L'executa cada dia la GitHub Action (.github/workflows/meteo.yml).
// Així els visitants carreguen un sol fitxer en lloc de fer centenars de peticions a Open-Meteo.
import { readFileSync, writeFileSync } from 'node:fs';
import { descarregaMeteo } from '../js/weather.js';

let fets = 0;
for (const km of [10, 5]) {
  const grid = JSON.parse(readFileSync(new URL(`../data/grid-${km}km.json`, import.meta.url)));
  console.log(`${km} km: ${grid.cells.length} cel·les…`);
  try {
    const meteo = await descarregaMeteo(grid, {
      pesPerMinut: 450, // per sota del límit de 600/minut d'Open-Meteo
      log: m => console.log('  ' + m),
      onProgress: p => { if (Math.round(p * 100) % 25 === 0) console.log(`  ${Math.round(p * 100)} %`); },
    });
    writeFileSync(new URL(`../data/meteo-${km}km.json`, import.meta.url), JSON.stringify(meteo));
    console.log(`${km} km: fet (${meteo.dates[0]} → ${meteo.dates.at(-1)})`);
    fets++;
  } catch (err) {
    console.error(`${km} km: ERROR — ${err.message}`);
  }
}
if (!fets) process.exit(1);
