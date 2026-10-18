# Com acotar més el Mapa Boletaire

Llista prioritzada (impacte ÷ esforç). ✅ = fet, 🔄 = en curs.

## A. Calibrar amb dades reals (el que més precisió dona)
1. ✅ **Registres de GBIF** (FungaCAT, iNaturalist, SIM, herbaris): 3.895 troballes georeferenciades de les 19 espècies.
2. ✅ **Ajust de paràmetres amb els registres** (scripts/calibra.py): hàbitat (arbres hostes), altitud, substrat, temporada corregida per l'esforç de mostreig, latència i llindar de pluja, rang de temperatura.
3. **Model estadístic en lloc de paràmetres a mà**: regressió logística o MaxEnt per espècie, amb fons «target-group» (tots els registres de fongs) per compensar on busca la gent. Factors estàtics: hàbitat, sòl, altitud, orientació, pendent, densitat del bosc.
4. **Factor meteo per «case-crossover»**: per a cada troballa amb data, comparar la meteo dels dies abans amb la del mateix lloc en altres anys/dates. Dona la latència i el llindar de pluja reals de cada espècie.
5. **Validació honesta**: separar anys (p. ex. entrenar ≤2019, validar 2020–2025) i mostrar la fiabilitat de cada espècie a l'app.
6. **Les teves sortides, també les negatives**: un registre senzill (data, lloc, espècies trobades, *i què no has trobat*). Les absències són el que més falta a GBIF.

## B. Més resolució
7. ✅ **Capes estàtiques a 500 m (tot Catalunya) i 100 m (trossos en fer zoom)** (hàbitat, sòl, orientació) combinades amb la meteo de 5 km: el mapa passa de «comarca» a «vessant» sense més peticions de meteo.
8. **Microrelleu**: fondalades i obagues humides (índex topogràfic d'humitat i posició topogràfica a partir del MET de l'ICGC), distància a torrents.
9. **Meteo més fina**: models d'alta resolució d'Open-Meteo (AROME de Météo-France, 1,3 km) en lloc del model global per defecte; la pluja de muntanya millora molt.
10. **Pluja observada**: estacions XEMA del Meteocat (cal clau) i acumulats de radar, per corregir el model on ha plogut de veritat.

## C. Millor caracterització del bosc
11. **Estructura del bosc (CREAF, 20 m)**: recobriment, alçada, àrea basal i diàmetre. El cep i el rossinyol volen bosc adult; el rovelló i el pinetell, pinedes joves i clares. Ja és al mateix servidor WMS.
12. **Cobertes recents (ICGC 2023, 1 m) i perímetres d'incendis**: descarta tallades i cremats recents (i marca els cremats d'1–2 anys per a les múrgoles).
13. **Humitat del sòl real**: Open-Meteo (ERA5-Land / ICON) o satèl·lit (Copernicus, 1 km) en lloc del balanç simplificat.
14. **Neu**: gruix i data de fusió per al marçot, que surt quan es fon la neu.

## D. Senyals en directe
15. ✅ **Troballes recents d'iNaturalist** (últims 14 dies) com a punts al mapa: confirmen que la saó ha arribat.
16. **Separar espècies agrupades**: cep d'estiu (*B. aereus*, *B. reticulatus*) vs cep de tardor (*B. edulis*, *B. pinophilus*); cadascun té hostes i temporada diferents.

## E. Ús pràctic
17. ✅ **Espais naturals protegits** com a capa del mapa; afegir **forests públics** (on l'accés és més clar) i les zones amb permís.
18. **Accessibilitat i pressió**: distància a pistes i aparcaments (OpenStreetMap) per destacar zones bones però poc trepitjades.
