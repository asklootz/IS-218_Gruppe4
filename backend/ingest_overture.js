#!/usr/bin/env node
/**
 * Analyze and ingest Overture GeoJSON data for Agder
 */
const fs = require('fs');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  user: 'postgres',
  password: 'password',
  host: 'postgres',
  port: 5432,
  database: 'gis'
});

async function ingestOverture() {
  try {
    const geoJsonFile = '/app/places_agder.geojson';
    
    if (!fs.existsSync(geoJsonFile)) {
      console.error('GeoJSON file not found');
      process.exit(1);
    }
    
    const data = JSON.parse(fs.readFileSync(geoJsonFile, 'utf8'));
    console.log(`\nLoaded ${data.features.length} features from GeoJSON\n`);
    
    // Analyze categories
    const categories = {};
    for (const feature of data.features) {
      const cat = feature.properties?.categories?.primary || 'unknown';
      categories[cat] = (categories[cat] || 0) + 1;
    }
    
    const sorted = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);
    
    console.log('Top 50 categories:');
    sorted.forEach(([cat, count]) => {
      console.log(`  ${count.toString().padStart(5)}: ${cat}`);
    });
    
    // Categorize and ingest
    const typeMap = {
      farms: [],
      water_sources: [],
      doctors: [],
      hospitals: [],
      other: []
    };
    
    for (const feature of data.features) {
      const props = feature.properties || {};
      const geometry = feature.geometry;
      if (!geometry || geometry.type !== 'Point') continue;
      
      const id = props.id || uuidv4();
      const name = props.name || props.names?.primary || 'Unknown Place';
      const lon = geometry.coordinates[0];
      const lat = geometry.coordinates[1];
      const categories = props.categories || {};
      const categoryPrimary = (categories.primary || '').toLowerCase();
      
      let category = 'other';
      if (categoryPrimary.includes('farm') || categoryPrimary.includes('agricultural') || categoryPrimary.includes('livestock')) {
        category = 'farms';
      } else if (categoryPrimary.includes('water') || categoryPrimary.includes('lake') || categoryPrimary.includes('river')) {
        category = 'water_sources';
      } else if (categoryPrimary.includes('doctor') || categoryPrimary.includes('clinic') || categoryPrimary.includes('urgent') || categoryPrimary.includes('hospital') || categoryPrimary.includes('medical') || categoryPrimary.includes('health') || categoryPrimary.includes('dental') || categoryPrimary.includes('counseling') || categoryPrimary.includes('veterinarian')) {
        if (categoryPrimary.includes('hospital')) {
          category = 'hospitals';
        } else {
          category = 'doctors';
        }
      }
      
      if (category !== 'other') {
        typeMap[category].push({ id, name, lon, lat, props });
      }
    }
    
    console.log('\nIngest distribution:');
    let total = 0;
    for (const [table, places] of Object.entries(typeMap)) {
      if (table !== 'other') {
        console.log(`  ${table}: ${places.length}`);
        total += places.length;
      }
    }
    console.log(`  Total to ingest: ${total}\n`);
    
    // Ingest into database
    for (const [table, places] of Object.entries(typeMap)) {
      if (table === 'other' || places.length === 0) continue;
      
      let ingested = 0;
      for (const place of places) {
        try {
          await pool.query(`
            INSERT INTO overture.${table} (id, name, location, raw_properties)
            VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              location = EXCLUDED.location,
              raw_properties = EXCLUDED.raw_properties
          `, [place.id, place.name, place.lon, place.lat, JSON.stringify(place.props)]);
          ingested++;
        } catch (error) {
          console.error(`Error ingesting into ${table}:`, error.message);
        }
      }
      console.log(`✓ Ingested ${ingested} places into ${table}`);
    }
    
    console.log('\n✓ Ingestion complete\n');
    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

ingestOverture();
