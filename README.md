# IS-218_Gruppe4
## Map Layers Viewer

This is a minimal example web app that shows an OpenStreetMap base map (via MapLibre GL JS) and loads geometry layers from a PostGIS database (seeded on startup).


Services are run with Docker Compose. By default this project no longer starts a local PostGIS container — instead the backend connects to a database provided via `DATABASE_URL` (useful for Supabase or other cloud Postgres instances).

Services:
- `backend`: Node/Express API that exposes `/layers` and `/layers/:name` returning GeoJSON
- `frontend`: static site served by nginx with MapLibre map and layer controls

Quick start with a Supabase (or remote Postgres) database:

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
