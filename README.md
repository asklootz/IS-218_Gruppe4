# Map Layers Viewer

This is a minimal example web app that shows an OpenStreetMap base map (via MapLibre GL JS) and loads geometry layers from a PostGIS database.

Services are run with Docker Compose. The backend connects to a database via environment variables (recommended: `DATABASE_URL`).

Services:
- `backend`: Node/Express API that exposes `/layers` and `/layers/:name` returning GeoJSON
- `frontend`: static site served by nginx with MapLibre map and layer controls

Quick start (secure env setup):

1. Create your local env file from template:

```powershell
Copy-Item .env.example .env
```

2. Edit `.env` and set your real values (`DATABASE_URL`, and optionally `DB_SSL`).

3. Start services:

```powershell
docker-compose up --build
```

4. Open frontend: http://localhost:8080

Notes:
<<<<<<< HEAD
- The backend will use `DATABASE_URL` when present. If your provider requires SSL (Supabase typically does), set `DB_SSL=true` so the connection uses TLS.
- If you want to run a local PostGIS for development, you can re-add a DB service in `docker-compose.yml` or run PostGIS separately.
# IS-218_Gruppe4
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


=======
- Do not commit real database credentials.
- `.env` is ignored by git in this repo.
- If your provider requires TLS (Supabase typically does), keep `DB_SSL=true`.

# IS-218_Gruppe4
>>>>>>> 401e529 (resolve duplicate map rendering and move secrets to .env)
