# Gruppe 4 "Beredskapskart"
## TLDR

Dette er et minimalt web-eksempel som viser et OpenStreetMap kartbase (via MapLibre GL JS) og henter geometri lag fra en PostGIS database.

Tjenestene kjøres med Docker Compose. Som standard starter ikke dette prosjektet en lokal PostGIS-container – i stedet kobler backend-systemet seg til en database levert via `DATABASE_URL` (nyttig for Supabase eller andre Postgres-instanser i skyen).

Tjenester:
- `backend`: Node/Express API that exposes `/layers` and `/layers/:name` returning GeoJSON
- `frontend`: statisk nettsted betjent av nginx med MapLibre-kart og lagkontroller

## Quick start with a Supabase (or remote Postgres) database:

1. Set your connection string in the environment, for example (PowerShell):

```powershell
$env:DATABASE_URL = "postgresql://postgres:yourpassword@dbhost:5432/yourdb"
$env:DB_SSL = "true"   # set to "false" if SSL is not required
docker-compose up --build
```

2. Open the frontend at http://localhost:8080

Notes:
- The backend will use `DATABASE_URL` when present. If your provider requires SSL (Supabase typically does), set `DB_SSL=true` so the connection uses TLS.
- If you want to run a local PostGIS for development, you can re-add a DB service in `docker-compose.yml` or run PostGIS separately.

### Demo av system

(GIF)

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




