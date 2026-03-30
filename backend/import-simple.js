const https = require('https');
const { Pool } = require('pg');
const unzipper = require('unzipper');
const stream = require('stream');

const pool = new Pool({
  host: 'postgres', port: 5432, user: 'postgres', password: 'postgres', database: 'beredskapskart'
});

async function downloadZip(url) {
  console.log('📥 Downloading...');
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function extractGeoJSON(zipBuffer) {
  console.log('📦 Extracting...');
  return new Promise((resolve, reject) => {
    let json = null;
    const readable = stream.Readable.from(zipBuffer);
    readable.pipe(unzipper.Parse())
      .on('entry', (entry) => {
        if (entry.path.toLowerCase().endsWith('.geojson')) {
          let content = '';
          entry.on('data', chunk => content += chunk.toString());
          entry.on('end', () => { if (content) json = content; });
        } else {
          entry.autodrain();
        }
      })
      .on('end', () => {
        if (json) {
          try { resolve(JSON.parse(json)); } catch (e) { reject(new Error('Invalid JSON ' + e.message)); }
        } else {
          reject(new Error('No GeoJSON found'));
        }
      })
      .on('error', reject);
  });
}

async function main() {
  console.log('\n🚀 Importing Geonorge data...\n');
  try {
    await pool.query('SELECT 1');
    console.log('✓ DB connected\n');

    console.log('--- SHELTERS ---');
    await pool.query('CREATE TABLE IF NOT EXISTS shelters (id SERIAL PRIMARY KEY, name TEXT, capacity INT, lon NUMERIC, lat NUMERIC, props JSONB)');
    const sz = await downloadZip('https://nedlasting.geonorge.no/geonorge/Samfunnssikkerhet/TilfluktsromOffentlige/GeoJSON/Samfunnssikkerhet_0000_Norge_25833_TilfluktsromOffentlige_GeoJSON.zip');
    const sg = await extractGeoJSON(sz);
    let count = 0;
    for (const f of sg.features || []) {
      try {
        const p = f.properties || {};
        const c = f.geometry.coordinates;
        await pool.query('INSERT INTO shelters (name, capacity, lon, lat, props) VALUES (\, \, \, \, \)',
          [p.navn || 'Shelter', p.kapasitet || 100, c[0], c[1], JSON.stringify(p)]);
        count++;
      } catch (e) {}
    }
    console.log('✓ ' + count + ' shelters imported\n');

    console.log('--- COUNTIES ---');
    await pool.query('CREATE TABLE IF NOT EXISTS counties (id SERIAL PRIMARY KEY, name TEXT, props JSONB)');
    const cz = await downloadZip('https://nedlasting.geonorge.no/geonorge/Basisdata/Fylker/GeoJSON/Basisdata_0000_Norge_25833_Fylker_GeoJSON.zip');
    const cg = await extractGeoJSON(cz);
    count = 0;
    for (const f of cg.features || []) {
      try {
        await pool.query('INSERT INTO counties (name, props) VALUES (\, \)',
          [f.properties?.navn || 'County', JSON.stringify(f.properties || {})]);
        count++;
      } catch (e) {}
    }
    console.log('✓ ' + count + ' counties imported\n');

    console.log('--- MUNICIPALITIES ---');
    await pool.query('CREATE TABLE IF NOT EXISTS municipalities (id SERIAL PRIMARY KEY, name TEXT, props JSONB)');
    const mz = await downloadZip('https://nedlasting.geonorge.no/geonorge/Basisdata/Kommuner/GeoJSON/Basisdata_0000_Norge_25833_Kommuner_GeoJSON.zip');
    const mg = await extractGeoJSON(mz);
    count = 0;
    for (const f of mg.features || []) {
      try {
        await pool.query('INSERT INTO municipalities (name, props) VALUES (\, \)',
          [f.properties?.navn || 'Municipality', JSON.stringify(f.properties || {})]);
        count++;
      } catch (e) {}
    }
    console.log('✓ ' + count + ' municipalities imported\n');

    const sr = await pool.query('SELECT COUNT(*) c FROM shelters');
    const cr = await pool.query('SELECT COUNT(*) c FROM counties');
    const mr = await pool.query('SELECT COUNT(*) c FROM municipalities');
    console.log('\n✅ Summary: ' + sr.rows[0].c + ' shelters, ' + cr.rows[0].c + ' counties, ' + mr.rows[0].c + ' municipalities');
  } catch (err) {
    console.error('\n❌ Error: ' + err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
