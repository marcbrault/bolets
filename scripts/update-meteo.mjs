// Descarrega la meteo de les graelles i la desa a data/meteo-<km>km.json.
// L'executa cada dia la GitHub Action (.github/workflows/meteo.yml).
// Així els visitants carreguen un sol fitxer en lloc de fer centenars de peticions a Open-Meteo.
import { readFileSync, writeFileSync } from 'node:fs';
import { descarregaMeteo } from '../js/weather.js';

for (const km of [10, 5]) {
  const grid = JSON.parse(readFileSync(new URL(`../data/grid-${km}km.json`, import.meta.url)));
  const meteo = await descarregaMeteo(grid, { onProgress: p => process.stdout.write(`\r${km} km: ${Math.round(p * 100)}%`) });
  writeFileSync(new URL(`../data/meteo-${km}km.json`, import.meta.url), JSON.stringify(meteo));
  console.log(`\n${km} km: ${grid.cells.length} cel·les, ${meteo.nd} dies (${meteo.dates[0]} → ${meteo.dates.at(-1)})`);
}
