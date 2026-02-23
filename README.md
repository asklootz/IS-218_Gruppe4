# Gruppe 4 "Beredskapskart"
## TLDR

Dette er et minimalt web-eksempel som viser et OpenStreetMap kartbase (via MapLibre GL JS) og henter geometri lag fra en PostGIS database.
Web applikasjonen viser brannstasjoner i valgte fylker og tilgjeneglighet på plasser i tilfluktsrom.

Tjenestene kjøres med Docker Compose. Som standard starter ikke dette prosjektet en lokal PostGIS-container – i stedet kobler backend-systemet seg til en database levert via `DATABASE_URL` (nyttig for Supabase eller andre Postgres-instanser i skyen).

Tjenester:
- `backend`: Node/Express API that exposes `/layers` and `/layers/:name` returning GeoJSON
- `frontend`: statisk nettsted betjent av nginx med MapLibre-kart og lagkontroller

## Quick start with a Supabase (or remote Postgres) database:

1. Oppstart av appen i Docker-miljø (PowerShell):

```powershell
docker compose up --build -d
```

2. Åpne frontend på: http://localhost:8080

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
| Tilfluktsrom | GeoNorge | PostGIS | Hentet via Supabase |
| Brannstasjoner | GeoNorge | PostGIS | Hentet via Supabase |
| Administrative enheter | GeoNorge | PostGIS | Hentet via Supabase |

## Arkitekturskisse

Kartløsningen er bygget med MapLibre GL JS. GeoJSON-filer lastes lokalt
inn som sources i MapLibre, mens eksterne datasett hentes via OGC API (WFS).
Dataene visualiseres som layers i kartet og gjøres interaktive med klikkbare
popups og datadrevet styling.

<img width="571" height="242" alt="diagram" src="https://github.com/user-attachments/assets/cd79ab0e-498b-4884-b368-9add472ad8c2" />


## Refleksjon

- Kartløsningen kan skaleres bedre ved bruk av vector tiles
- Brukergrensesnittet kan forbedres med tydeligere kontroller
- Mer avansert romlig filtrering kan gi bedre analyse
- Avhengighet av eksterne API-er kan påvirke stabilitet




