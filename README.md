# IS-218_Gruppe4

## Teknisk stack

- MapLibre GL JS (via CDN)
- JavaScript (ES6)
- HTML / CSS
- GeoJSON (lokale filer)
- OGC API / WFS (GeoNorge)
- OpenStreetMap (bakgrunnskart)

## Datakatalog

| Datasett | Kilde | Format | Bearbeiding |
|--------|------|--------|------------|
| Grøntområder | QGIS | GeoJSON | Klippet og eksportert |
| Kommunegrenser | GeoNorge | WFS | Hentet direkte via API |

## Arkitekturskisse

Kartløsningen er bygget med MapLibre GL JS. GeoJSON-filer lastes lokalt
inn som sources i MapLibre, mens eksterne datasett hentes via OGC API (WFS).
Dataene visualiseres som layers i kartet og gjøres interaktive med klikkbare
popups og datadrevet styling.

## Refleksjon

- Kartløsningen kan skaleres bedre ved bruk av vector tiles
- Brukergrensesnittet kan forbedres med tydeligere kontroller
- Mer avansert romlig filtrering kan gi bedre analyse
- Avhengighet av eksterne API-er kan påvirke stabilitet


