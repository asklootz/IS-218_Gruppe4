# Map Layers Viewer

This is a minimal example web app that shows an OpenStreetMap base map (via MapLibre GL JS) and loads geometry layers from a PostGIS database (seeded on startup).

Services are run with Docker Compose:

Services:
- `db`: PostGIS database (postgis/postgis)
- `backend`: Node/Express API that exposes `/layers` and `/layers/:name` returning GeoJSON
- `frontend`: static site served by nginx with MapLibre map and layer controls

Quick start:

1. Build and start:

```bash
docker-compose up --build
```

2. Open the frontend at http://localhost:8080

Notes:
- The backend connects to the DB using env vars in `docker-compose.yml`.
- The DB init SQL creates a sample `parks` table with a polygon in it.
# IS-218_Gruppe4