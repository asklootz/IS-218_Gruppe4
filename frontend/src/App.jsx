import React, { useState, useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import axios from 'axios'
import proj4 from 'proj4'
import { v4 as uuidv4 } from 'uuid'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000'
const OSM_RASTER_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors'
    }
  },
  layers: [
    {
      id: 'osm-base',
      type: 'raster',
      source: 'osm'
    }
  ]
}

proj4.defs('EPSG:25833', '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs')

function firstCoordinateFromGeometry(geometry) {
  if (!geometry || !geometry.coordinates) return null
  let coords = geometry.coordinates
  while (Array.isArray(coords) && Array.isArray(coords[0])) {
    coords = coords[0]
  }
  if (Array.isArray(coords) && coords.length >= 2 && Number.isFinite(Number(coords[0])) && Number.isFinite(Number(coords[1]))) {
    return [Number(coords[0]), Number(coords[1])]
  }
  return null
}

function isProjectedBoundaryGeoJson(geojson) {
  const crsName = String(geojson?.crs?.properties?.name || '').toUpperCase()
  if (crsName.includes('25833')) return true

  const feature = (geojson?.features || []).find((f) => firstCoordinateFromGeometry(f?.geometry))
  const coord = firstCoordinateFromGeometry(feature?.geometry)
  if (!coord) return false
  const [x, y] = coord
  return x < -180 || x > 180 || y < -90 || y > 90
}

function transformCoords25833To4326(coords) {
  if (!Array.isArray(coords)) return coords
  if (coords.length >= 2 && Number.isFinite(Number(coords[0])) && Number.isFinite(Number(coords[1]))) {
    return proj4('EPSG:25833', 'EPSG:4326', [Number(coords[0]), Number(coords[1])])
  }
  return coords.map(transformCoords25833To4326)
}

function normalizeBoundaryGeoJson(rawGeojson) {
  if (!rawGeojson || !Array.isArray(rawGeojson.features)) {
    return { type: 'FeatureCollection', features: [] }
  }
  if (!isProjectedBoundaryGeoJson(rawGeojson)) return rawGeojson

  return {
    ...rawGeojson,
    crs: undefined,
    features: rawGeojson.features.map((feature) => ({
      ...feature,
      geometry: feature.geometry
        ? {
            ...feature.geometry,
            coordinates: transformCoords25833To4326(feature.geometry.coordinates)
          }
        : feature.geometry
    }))
  }
}

function sheltersToFeatureCollection(shelters = []) {
  return {
    type: 'FeatureCollection',
    features: shelters
      .filter((s) => Number.isFinite(Number(s.lon)) && Number.isFinite(Number(s.lat)))
      .map((s) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [Number(s.lon), Number(s.lat)]
        },
        properties: {
          id: s.id,
          shelter_id: s.shelter_id,
          name: s.name,
          capacity: Number(s.capacity || 0),
          enough_capacity: Boolean(s.enough_capacity),
          cluster_population: Number(s.cluster_population || 0),
          cluster_free_spaces: Number(s.cluster_free_spaces || 0),
          missing_capacity: Number(s.missing_capacity || 0),
          cluster_id: Number(s.cluster_id || 0)
        }
      }))
  }
}

function pageFromPath(pathname) {
  if (pathname === '/admin') return 'admin'
  if (pathname === '/bruker') return 'user'
  return 'home'
}

function App() {
  const [page, setPage] = useState(pageFromPath(window.location.pathname))
  const [userId] = useState(localStorage.getItem('userId') || uuidv4())

  const navigate = (targetPage) => {
    const path = targetPage === 'admin' ? '/admin' : targetPage === 'user' ? '/bruker' : '/'
    window.history.pushState({}, '', path)
    setPage(targetPage)
  }

  useEffect(() => {
    localStorage.setItem('userId', userId)
  }, [userId])

  useEffect(() => {
    const onPopState = () => setPage(pageFromPath(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  if (page === 'admin') {
    return <AdminPage onBack={() => navigate('home')} />
  }
  if (page === 'user') {
    return <UserPage userId={userId} onBack={() => navigate('home')} />
  }

  return (
    <div className="home-container">
      <div className="home-content">
        <h1>🗺️ Beredskapskart</h1>
        <p>Evakueringsstøtte og tilfluktsromsplanlegging</p>
        <div className="home-buttons">
          <button className="btn btn-admin" onClick={() => navigate('admin')}>
            👨‍💼 Administratorvisning
          </button>
          <button className="btn btn-user" onClick={() => navigate('user')}>
            👤 Brukervisning
          </button>
        </div>
      </div>
    </div>
  )
}

function AdminPage({ onBack }) {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const staticLayersLoaded = useRef(false)
  const adminPopupBound = useRef(false)
  const [radius, setRadius] = useState(1000)
  const [coverage, setCoverage] = useState(null)
  const [loading, setLoading] = useState(false)
  const [visibleLayers, setVisibleLayers] = useState({
    shelters: true,
    population: true,
    counties: true,
    municipalities: false,
    fire_stations: true,
    farms: true,
    water_sources: true,
    doctors: true,
    hospitals: true,
    radius: true
  })

  useEffect(() => {
    if (!mapContainer.current) return

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: OSM_RASTER_STYLE,
      center: [10.75, 59.91],
      zoom: 10
    })

    map.current.on('load', () => initializeAdminMap())

    return () => map.current?.remove()
  }, [])

  const applyAdminLayerVisibility = () => {
    if (!map.current) return
    const setVisibility = (layerId, visible) => {
      if (map.current.getLayer(layerId)) {
        map.current.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
      }
    }
    setVisibility('shelters-layer', visibleLayers.shelters)
    setVisibility('population-layer', visibleLayers.population)
    setVisibility('counties-fill', visibleLayers.counties)
    setVisibility('counties-line', visibleLayers.counties)
    setVisibility('municipalities-line', visibleLayers.municipalities)
    setVisibility('fire_stations-layer', visibleLayers.fire_stations)
    setVisibility('farms-layer', visibleLayers.farms)
    setVisibility('water_sources-layer', visibleLayers.water_sources)
    setVisibility('doctors-layer', visibleLayers.doctors)
    setVisibility('hospitals-layer', visibleLayers.hospitals)
    setVisibility('radius-fill', visibleLayers.radius)
    setVisibility('radius-line', visibleLayers.radius)

    if (map.current.getLayer('counties-line') && map.current.getLayer('radius-line')) {
      map.current.moveLayer('counties-line', 'radius-line')
    }
    if (map.current.getLayer('counties-fill') && map.current.getLayer('counties-line')) {
      map.current.moveLayer('counties-fill', 'counties-line')
    }
    if (map.current.getLayer('municipalities-line') && map.current.getLayer('radius-line')) {
      map.current.moveLayer('municipalities-line', 'radius-line')
    }
  }

  const loadStaticLayers = async () => {
    if (!map.current || staticLayersLoaded.current) return

    try {
      const sheltersRes = await axios.get(`${API_BASE}/api/layers/shelters`)
      if (sheltersRes.data.features) {
        if (!map.current.getSource('shelters')) {
          map.current.addSource('shelters', { type: 'geojson', data: sheltersRes.data })
          map.current.addLayer({
            id: 'shelters-layer',
            type: 'circle',
            source: 'shelters',
            paint: {
              'circle-radius': 6,
              'circle-color': [
                'case',
                ['==', ['get', 'enough_capacity'], true],
                '#22c55e',
                '#ef4444'
              ],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fff'
            }
          })
        } else {
          map.current.getSource('shelters').setData(sheltersRes.data)
        }
      }

      const popRes = await axios.get(`${API_BASE}/api/layers/population`)
      if (popRes.data.features) {
        if (!map.current.getSource('population')) {
          map.current.addSource('population', { type: 'geojson', data: popRes.data })
          map.current.addLayer({
            id: 'population-layer',
            type: 'circle',
            source: 'population',
            paint: {
              'circle-radius': 3,
              'circle-color': '#3b82f6',
              'circle-opacity': 0.6
            }
          })
        }
      }

      const countiesRes = await axios.get(`${API_BASE}/api/layers/counties`)
      const countiesData = normalizeBoundaryGeoJson(countiesRes.data)
      if (countiesData.features) {
        if (!map.current.getSource('counties')) {
          map.current.addSource('counties', { type: 'geojson', data: countiesData })
          map.current.addLayer({
            id: 'counties-fill',
            type: 'fill',
            source: 'counties',
            paint: {
              'fill-color': '#0ea5e9',
              'fill-opacity': 0.18
            }
          })
          map.current.addLayer({
            id: 'counties-line',
            type: 'line',
            source: 'counties',
            paint: {
              'line-color': '#075985',
              'line-width': 2,
              'line-opacity': 0.95
            }
          })
        } else {
          map.current.getSource('counties').setData(countiesData)
        }
      }

      const municipalitiesRes = await axios.get(`${API_BASE}/api/layers/municipalities`)
      const municipalitiesData = normalizeBoundaryGeoJson(municipalitiesRes.data)
      if (municipalitiesData.features) {
        if (!map.current.getSource('municipalities')) {
          map.current.addSource('municipalities', { type: 'geojson', data: municipalitiesData })
          map.current.addLayer({
            id: 'municipalities-line',
            type: 'line',
            source: 'municipalities',
            paint: {
              'line-color': '#0afcd3',
              'line-width': 1.2,
              'line-opacity': 0.9
            }
          })
        } else {
          map.current.getSource('municipalities').setData(municipalitiesData)
        }
      }

      // Load fire stations
      const fireRes = await axios.get(`${API_BASE}/api/layers/fire_stations`)
      if (fireRes.data.features) {
        if (!map.current.getSource('fire_stations')) {
          map.current.addSource('fire_stations', { type: 'geojson', data: fireRes.data })
          map.current.addLayer({
            id: 'fire_stations-layer',
            type: 'circle',
            source: 'fire_stations',
            paint: {
              'circle-radius': 5,
              'circle-color': '#ff6b6b',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fff'
            }
          })
        } else {
          map.current.getSource('fire_stations').setData(fireRes.data)
        }
      }

      // Load Overture layers
      const layersConfig = [
        { name: 'farms', color: '#84cc16', label: 'Farms' },
        { name: 'water_sources', color: '#06b6d4', label: 'Water Sources' },
        { name: 'doctors', color: '#f97316', label: 'Doctors' },
        { name: 'hospitals', color: '#d946ef', label: 'Hospitals' }
      ]

      for (const layerConfig of layersConfig) {
        try {
          const res = await axios.get(`${API_BASE}/api/layers/${layerConfig.name}`)
          console.log(`Loaded ${layerConfig.name}:`, res.data.features?.length, 'features')
          if (res.data.features && res.data.features.length > 0) {
            if (!map.current.getSource(layerConfig.name)) {
              map.current.addSource(layerConfig.name, { type: 'geojson', data: res.data })
              map.current.addLayer({
                id: `${layerConfig.name}-layer`,
                type: 'circle',
                source: layerConfig.name,
                paint: {
                  'circle-radius': 4,
                  'circle-color': layerConfig.color,
                  'circle-stroke-width': 1,
                  'circle-stroke-color': '#fff'
                }
              })
              console.log(`Added layer: ${layerConfig.name}-layer`)
            } else {
              map.current.getSource(layerConfig.name).setData(res.data)
            }
          }
        } catch (error) {
          console.warn(`Failed to load ${layerConfig.name}:`, error.message)
        }
      }

      staticLayersLoaded.current = true
    } catch (error) {
      console.error('Error loading static layers:', error)
    }
  }

  const loadCoverageAndRadius = async (nextRadius) => {
    if (!map.current) return
    setLoading(true)
    try {
      const [covRes, radiusRes] = await Promise.all([
        axios.get(`${API_BASE}/api/admin/coverage?radius=${nextRadius}`),
        axios.get(`${API_BASE}/api/admin/radius-layer?radius=${nextRadius}`)
      ])

      setCoverage(covRes.data)

      const shelterFc = sheltersToFeatureCollection(covRes.data?.shelters || [])
      if (map.current.getSource('shelters')) {
        map.current.getSource('shelters').setData(shelterFc)
      }

      if (!map.current.getSource('radius-buffers')) {
        map.current.addSource('radius-buffers', { type: 'geojson', data: radiusRes.data })
        map.current.addLayer({
          id: 'radius-fill',
          type: 'fill',
          source: 'radius-buffers',
          paint: {
            'fill-color': '#f59e0b',
            'fill-opacity': 0.12
          }
        })
        map.current.addLayer({
          id: 'radius-line',
          type: 'line',
          source: 'radius-buffers',
          paint: {
            'line-color': '#f59e0b',
            'line-width': 1,
            'line-opacity': 0.7
          }
        })
      } else {
        map.current.getSource('radius-buffers').setData(radiusRes.data)
      }

      applyAdminLayerVisibility()
    } catch (error) {
      console.error('Error loading coverage/radius:', error)
    }
    setLoading(false)
  }

  const initializeAdminMap = async () => {
    await loadStaticLayers()
    await loadCoverageAndRadius(radius)

    if (!adminPopupBound.current && map.current) {
      map.current.on('click', 'shelters-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>${p.name || 'Tilfluktsrom'}</strong><br/>
            Kapasitet: ${p.capacity ?? 0}<br/>
            Område: #${p.cluster_id ?? '-'}<br/>
            Befolkning i område: ${p.cluster_population ?? 0}<br/>
            Ledige plasser i område: ${p.cluster_free_spaces ?? 0}<br/>
            Manglende kapasitet: ${p.missing_capacity ?? 0}
          </div>
        `
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)
      })
      map.current.on('mouseenter', 'shelters-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'shelters-layer', () => { map.current.getCanvas().style.cursor = '' })
      adminPopupBound.current = true
    }

    applyAdminLayerVisibility()
  }

  useEffect(() => {
    if (map.current?.isStyleLoaded()) {
      loadCoverageAndRadius(radius)
    }
  }, [radius])

  useEffect(() => {
    if (map.current?.isStyleLoaded()) {
      applyAdminLayerVisibility()
    }
  }, [visibleLayers])

  const handleExportCSV = async () => {
    try {
      window.location.href = `${API_BASE}/api/admin/export/csv?radius=${radius}`
    } catch (error) {
      console.error('Export error:', error)
    }
  }

  const handleExportXLSX = async () => {
    try {
      window.location.href = `${API_BASE}/api/admin/export/xlsx?radius=${radius}`
    } catch (error) {
      console.error('Export error:', error)
    }
  }

  return (
    <div className="admin-container">
      <div className="admin-panel">
        <div className="panel-header">
          <h2>Administratorpanel</h2>
          <button className="btn-close" onClick={onBack}>←</button>
        </div>

        <div className="panel-section">
          <h3>Radiusanalyse</h3>
          <div className="slider-group">
            <label>Radius: {(radius / 1000).toFixed(1)} km</label>
            <input
              type="range"
              min="250"
              max="5000"
              step="250"
              value={radius}
              onChange={(e) => setRadius(parseInt(e.target.value))}
              className="slider"
            />
          </div>
        </div>

        {coverage && (
          <>
            <div className="panel-section">
              <h3>Dekkingsstatistikk</h3>
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-value">{coverage.summary.total_shelters}</div>
                  <div className="stat-label">Samlet tilfluktsrom</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{coverage.summary.total_clusters}</div>
                  <div className="stat-label">Sammenslåtte radiusområder</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{coverage.summary.total_population_within_radius}</div>
                  <div className="stat-label">Befolkning i samlet radius</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{coverage.summary.total_capacity}</div>
                  <div className="stat-label">Total kapasitet</div>
                </div>
              </div>
            </div>

            <div className="panel-section">
              <h3>Tilfluktsrom</h3>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Navn</th>
                      <th>Kapasitet</th>
                      <th>Befolkning (område)</th>
                      <th>Område</th>
                      <th>Status</th>
                      <th>Mangler</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.shelters.map((s, i) => (
                      <tr key={i} className={s.enough_capacity ? 'adequate' : 'inadequate'}>
                        <td>{s.name}</td>
                        <td>{s.capacity}</td>
                        <td>{s.cluster_population}</td>
                        <td>#{s.cluster_id}</td>
                        <td>{s.enough_capacity ? '✓' : '✗'}</td>
                        <td>{s.missing_capacity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        <div className="panel-section">
          <h3>Eksporter</h3>
          <div className="button-group">
            <button className="btn btn-secondary" onClick={handleExportCSV}>
              📊 CSV
            </button>
            <button className="btn btn-secondary" onClick={handleExportXLSX}>
              📈 Excel
            </button>
          </div>
        </div>

        <div className="panel-section">
          <h3>Lag</h3>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.shelters}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, shelters: e.target.checked })}
            />
            Tilfluktsrom
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.population}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, population: e.target.checked })}
            />
            Befolkning
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.radius}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, radius: e.target.checked })}
            />
            Radius per tilfluktsrom
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.counties}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, counties: e.target.checked })}
            />
            Fylker
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.municipalities}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, municipalities: e.target.checked })}
            />
            Kommuner
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.fire_stations}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, fire_stations: e.target.checked })}
            />
            Brannstasjoner
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.farms}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, farms: e.target.checked })}
            />
            Farms
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.water_sources}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, water_sources: e.target.checked })}
            />
            Water Sources
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.doctors}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, doctors: e.target.checked })}
            />
            Doctors
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.hospitals}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, hospitals: e.target.checked })}
            />
            Hospitals
          </label>
        </div>
      </div>

      <div className="map-container" ref={mapContainer} />
    </div>
  )
}

function UserPage({ userId, onBack }) {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const userPopupBound = useRef(false)
  const [userLocation, setUserLocation] = useState(null)
  const [following, setFollowing] = useState(false)
  const [routeMode, setRouteMode] = useState('walk')
  const [routeStrategy, setRouteStrategy] = useState('nearest')
  const [routes, setRoutes] = useState(null)
  const [activeRoute, setActiveRoute] = useState(null)
  const [tracking, setTracking] = useState(false)
  const [visibleLayers, setVisibleLayers] = useState({
    shelters: true,
    counties: true,
    municipalities: false,
    roads: true
  })

  useEffect(() => {
    if (!mapContainer.current) return

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: OSM_RASTER_STYLE,
      center: [10.75, 59.91],
      zoom: 10
    })

    map.current.on('load', () => {
      loadShelters()
      loadUserLayers()
      startTracking()
    })

    return () => map.current?.remove()
  }, [])

  const loadShelters = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/admin/coverage?radius=1000`)
      const shelterFc = sheltersToFeatureCollection(res.data?.shelters || [])
      if (map.current && shelterFc.features.length > 0) {
        if (!map.current.getSource('shelters')) {
          map.current.addSource('shelters', { type: 'geojson', data: shelterFc })
          map.current.addLayer({
            id: 'shelters-layer',
            type: 'circle',
            source: 'shelters',
            paint: {
              'circle-radius': 8,
              'circle-color': [
                'case',
                ['==', ['get', 'enough_capacity'], true],
                '#22c55e',
                '#ef4444'
              ],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fff'
            }
          })
        } else {
          map.current.getSource('shelters').setData(shelterFc)
        }

        if (!userPopupBound.current) {
          map.current.on('click', 'shelters-layer', (e) => {
            const f = e.features?.[0]
            if (!f) return
            const p = f.properties || {}
            const html = `
              <div style="font-size:12px;line-height:1.4;">
                <strong>${p.name || 'Tilfluktsrom'}</strong><br/>
                Kapasitet: ${p.capacity ?? 0}<br/>
                Befolkning i område: ${p.cluster_population ?? 0}<br/>
                Ledige plasser i område: ${p.cluster_free_spaces ?? 0}<br/>
                Status: ${(p.enough_capacity === true || p.enough_capacity === 'true') ? 'Nok plass' : 'Ikke nok plass'}
              </div>
            `
            new maplibregl.Popup({ closeButton: true })
              .setLngLat(e.lngLat)
              .setHTML(html)
              .addTo(map.current)
          })
          map.current.on('mouseenter', 'shelters-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
          map.current.on('mouseleave', 'shelters-layer', () => { map.current.getCanvas().style.cursor = '' })
          userPopupBound.current = true
        }
      }
    } catch (error) {
      console.error('Error loading shelters:', error)
    }
  }

  const loadUserLayers = async () => {
    try {
      const countiesRes = await axios.get(`${API_BASE}/api/layers/counties`)
      const countiesData = normalizeBoundaryGeoJson(countiesRes.data)
      if (map.current && countiesData.features && !map.current.getSource('counties-user')) {
        map.current.addSource('counties-user', { type: 'geojson', data: countiesData })
        map.current.addLayer({
          id: 'counties-user-line',
          type: 'line',
          source: 'counties-user',
          paint: { 'line-color': '#1d4ed8', 'line-width': 2, 'line-opacity': 0.95 }
        })
      }

      const municipalitiesRes = await axios.get(`${API_BASE}/api/layers/municipalities`)
      const municipalitiesData = normalizeBoundaryGeoJson(municipalitiesRes.data)
      if (map.current && municipalitiesData.features && !map.current.getSource('municipalities-user')) {
        map.current.addSource('municipalities-user', { type: 'geojson', data: municipalitiesData })
        map.current.addLayer({
          id: 'municipalities-user-line',
          type: 'line',
          source: 'municipalities-user',
          paint: { 'line-color': '#0afcd3', 'line-width': 2, 'line-opacity': 0.9 }
        })
      }
    } catch (error) {
      console.error('User layer load error:', error)
    }
  }

  useEffect(() => {
    if (!map.current) return
    const setVisibility = (layerId, visible) => {
      if (map.current.getLayer(layerId)) {
        map.current.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
      }
    }
    setVisibility('shelters-layer', visibleLayers.shelters)
    setVisibility('counties-user-line', visibleLayers.counties)
    setVisibility('municipalities-user-line', visibleLayers.municipalities)
    setVisibility('osm-base', visibleLayers.roads)

    if (map.current.getLayer('municipalities-user-line') && map.current.getLayer('counties-user-line')) {
      map.current.moveLayer('municipalities-user-line', 'counties-user-line')
    }
  }, [visibleLayers])

  const startTracking = () => {
    if (!navigator.geolocation) {
      alert('Geolocation not supported')
      return
    }

    setTracking(true)

    navigator.geolocation.watchPosition(
      (position) => {
        const { latitude: lat, longitude: lon } = position.coords
        setUserLocation({ lat, lon })

        const userFeature = {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { label: 'Du er her' }
          }]
        }

        if (map.current) {
          if (!map.current.getSource('user-location')) {
            map.current.addSource('user-location', { type: 'geojson', data: userFeature })
            map.current.addLayer({
              id: 'user-location-dot',
              type: 'circle',
              source: 'user-location',
              paint: {
                'circle-radius': 6,
                'circle-color': '#0ea5e9',
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2
              }
            })
          } else {
            map.current.getSource('user-location').setData(userFeature)
          }
        }

        if (map.current && following) {
          map.current.flyTo({ center: [lon, lat], zoom: 14 })
        }

        axios.post(`${API_BASE}/api/users/${userId}/location`, { lon, lat }).catch(() => {})
      },
      (error) => console.error('Geolocation error:', error),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    )
  }

  const handleComputeRoute = async () => {
    if (!userLocation) {
      alert('Venligst tillat geolokalisering først')
      return
    }

    try {
      const res = await axios.get(`${API_BASE}/api/routing/nearest-shelters`, {
        params: {
          lon: userLocation.lon,
          lat: userLocation.lat,
          mode: routeMode,
          strategy: routeStrategy
        }
      })

      setRoutes(res.data.shelters)

      if (map.current && res.data.shelters.length > 0) {
        const shelter = res.data.shelters[0]
        const routeRes = await axios.get(`${API_BASE}/api/routing/route`, {
          params: {
            originLon: userLocation.lon,
            originLat: userLocation.lat,
            destLon: shelter.lon,
            destLat: shelter.lat,
            mode: routeMode
          }
        })

        const routeFeature = {
          type: 'Feature',
          geometry: routeRes.data.geometry,
          properties: {
            source: routeRes.data.source
          }
        }

        if (map.current.getSource('route-line')) {
          map.current.getSource('route-line').setData(routeFeature)
        } else {
          map.current.addSource('route-line', {
            type: 'geojson',
            data: routeFeature
          })

          map.current.addLayer({
            id: 'route-layer',
            type: 'line',
            source: 'route-line',
            paint: {
              'line-color': '#3b82f6',
              'line-width': 4,
              'line-opacity': 0.9
            }
          })
        }

        setActiveRoute({
          shelter,
          distanceKm: (Number(routeRes.data.distance_m || 0) / 1000).toFixed(2),
          durationMin: Math.max(1, Math.round(Number(routeRes.data.duration_s || 0) / 60)),
          source: routeRes.data.source,
          steps: routeRes.data.steps || []
        })
      }
    } catch (error) {
      console.error('Routing error:', error)
    }
  }

  const handleFollowUser = () => {
    setFollowing(!following)
    if (!following && userLocation && map.current) {
      map.current.flyTo({
        center: [userLocation.lon, userLocation.lat],
        zoom: 14
      })
    }
  }

  return (
    <div className="user-container">
      <div className="user-panel">
        <div className="panel-header">
          <h2>Brukervisning</h2>
          <button className="btn-close" onClick={onBack}>←</button>
        </div>

        {userLocation && (
          <div className="panel-section">
            <p className="location-info">
              📍 {userLocation.lat.toFixed(4)}, {userLocation.lon.toFixed(4)}
            </p>
          </div>
        )}

        <div className="panel-section">
          <h3>Rutingsomvalg</h3>
          <div className="form-group">
            <label>Transportmiddel:</label>
            <select value={routeMode} onChange={(e) => setRouteMode(e.target.value)}>
              <option value="walk">🚶 Til fots</option>
              <option value="bike">🚴 Sykkel</option>
              <option value="car">🚗 Bil</option>
            </select>
          </div>

          <div className="form-group">
            <label>Strategi:</label>
            <select value={routeStrategy} onChange={(e) => setRouteStrategy(e.target.value)}>
              <option value="nearest">Nærmeste</option>
              <option value="hasSpace">Med ledig plass</option>
            </select>
          </div>

          <button className="btn btn-primary" onClick={handleComputeRoute}>
            🎯 Finn rute
          </button>
        </div>

        <div className="panel-section">
          <button
            className={`btn ${following ? 'btn-primary' : 'btn-secondary'}`}
            onClick={handleFollowUser}
          >
            {following ? '📍 Følg bruker (på)' : '📍 Følg bruker (av)'}
          </button>
        </div>

        <div className="panel-section">
          <h3>Lagvalg</h3>
          <label className="checkbox-label">
            <input type="checkbox" checked={visibleLayers.shelters} onChange={(e) => setVisibleLayers({ ...visibleLayers, shelters: e.target.checked })} />
            Tilfluktsrom
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={visibleLayers.counties} onChange={(e) => setVisibleLayers({ ...visibleLayers, counties: e.target.checked })} />
            Fylker
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={visibleLayers.municipalities} onChange={(e) => setVisibleLayers({ ...visibleLayers, municipalities: e.target.checked })} />
            Kommuner
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={visibleLayers.roads} onChange={(e) => setVisibleLayers({ ...visibleLayers, roads: e.target.checked })} />
            Vegnett (OSM baselag)
          </label>
        </div>

        {activeRoute && (
          <div className="panel-section">
            <h3>Anbefalt rute</h3>
            <p className="location-info">Til: {activeRoute.shelter.name}</p>
            <div className="route-info" style={{ marginTop: '8px' }}>
              <span>📏 {activeRoute.distanceKm} km</span>
              <span>⏱ {activeRoute.durationMin} min</span>
              <span>Kilde: {activeRoute.source === 'osrm' ? 'Vei-rute' : 'Direkte linje'}</span>
            </div>
            {activeRoute.steps.length > 0 && (
              <div style={{ marginTop: '10px', fontSize: '0.85rem' }}>
                <strong>Neste steg:</strong>
                <ol style={{ margin: '6px 0 0 18px' }}>
                  {activeRoute.steps.slice(0, 5).map((step, idx) => (
                    <li key={idx}>{step.instruction} ({Math.round(step.distance_m)} m)</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        {routes && (
          <div className="panel-section">
            <h3>Nærmeste tilfluktsrom</h3>
            <div className="routes-list">
              {routes.slice(0, 6).map((route, i) => (
                <div key={i} className="route-card">
                  <div className="route-name">{route.name}</div>
                  <div className="route-info">
                    <span>📏 {route.distance_km} km</span>
                    <span>⏱ {route.travel_time_minutes} min</span>
                  </div>
                  <div className="route-capacity">
                    Kapasitet: {route.free_spots > 0 ? '✓' : '✗'} ({route.free_spots} fri)
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="map-container" ref={mapContainer} />
    </div>
  )
}

export default App
