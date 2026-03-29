import React, { useState, useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import axios from 'axios'
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
  const [radius, setRadius] = useState(1000)
  const [coverage, setCoverage] = useState(null)
  const [loading, setLoading] = useState(false)
  const [visibleLayers, setVisibleLayers] = useState({
    shelters: true,
    population: true,
    counties: true,
    municipalities: false,
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

    map.current.on('load', () => {
      loadData()
    })

    return () => map.current?.remove()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      // Get coverage data
      const covRes = await axios.get(`${API_BASE}/api/admin/coverage?radius=${radius}`)
      setCoverage(covRes.data)

      // Load shelters layer
      const sheltersRes = await axios.get(`${API_BASE}/api/layers/shelters`)
      if (map.current && sheltersRes.data.features) {
        if (!map.current.getSource('shelters')) {
          map.current.addSource('shelters', { type: 'geojson', data: sheltersRes.data })
          map.current.addLayer({
            id: 'shelters-layer',
            type: 'circle',
            source: 'shelters',
            paint: {
              'circle-radius': 6,
              'circle-color': '#22c55e',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fff'
            }
          })
        } else {
          map.current.getSource('shelters').setData(sheltersRes.data)
        }
      }

      // Load population layer
      const popRes = await axios.get(`${API_BASE}/api/layers/population`)
      if (map.current && popRes.data.features) {
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
      if (map.current && countiesRes.data.features) {
        if (!map.current.getSource('counties')) {
          map.current.addSource('counties', { type: 'geojson', data: countiesRes.data })
          map.current.addLayer({
            id: 'counties-fill',
            type: 'fill',
            source: 'counties',
            paint: {
              'fill-color': '#0ea5e9',
              'fill-opacity': 0.08
            }
          })
          map.current.addLayer({
            id: 'counties-line',
            type: 'line',
            source: 'counties',
            paint: {
              'line-color': '#0284c7',
              'line-width': 1.2
            }
          })
        } else {
          map.current.getSource('counties').setData(countiesRes.data)
        }
      }

      const municipalitiesRes = await axios.get(`${API_BASE}/api/layers/municipalities`)
      if (map.current && municipalitiesRes.data.features) {
        if (!map.current.getSource('municipalities')) {
          map.current.addSource('municipalities', { type: 'geojson', data: municipalitiesRes.data })
          map.current.addLayer({
            id: 'municipalities-line',
            type: 'line',
            source: 'municipalities',
            paint: {
              'line-color': '#64748b',
              'line-width': 0.6,
              'line-opacity': 0.55
            }
          })
        } else {
          map.current.getSource('municipalities').setData(municipalitiesRes.data)
        }
      }

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
    } catch (error) {
      console.error('Error loading data:', error)
    }
    setLoading(false)
  }

  useEffect(() => {
    if (map.current?.isStyleLoaded()) {
      loadData()
    }
  }, [radius, visibleLayers])

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
                  <div className="stat-value">{coverage.summary.total_population_within_radius}</div>
                  <div className="stat-label">Befolkning i radius</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{coverage.summary.total_capacity}</div>
                  <div className="stat-label">Total kapasitet</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{coverage.summary.adequate_shelters}</div>
                  <div className="stat-label">Tilstrekkelig dekning</div>
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
                      <th>Befolkning</th>
                      <th>Status</th>
                      <th>Mangler</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.shelters.map((s, i) => (
                      <tr key={i} className={s.enough_capacity ? 'adequate' : 'inadequate'}>
                        <td>{s.name}</td>
                        <td>{s.capacity}</td>
                        <td>{s.population_sum}</td>
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
        </div>
      </div>

      <div className="map-container" ref={mapContainer} />
    </div>
  )
}

function UserPage({ userId, onBack }) {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const [userLocation, setUserLocation] = useState(null)
  const [following, setFollowing] = useState(false)
  const [routeMode, setRouteMode] = useState('walk')
  const [routeStrategy, setRouteStrategy] = useState('nearest')
  const [routes, setRoutes] = useState(null)
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
      const res = await axios.get(`${API_BASE}/api/layers/shelters`)
      if (map.current && res.data.features) {
        if (!map.current.getSource('shelters')) {
          map.current.addSource('shelters', { type: 'geojson', data: res.data })
          map.current.addLayer({
            id: 'shelters-layer',
            type: 'circle',
            source: 'shelters',
            paint: {
              'circle-radius': 8,
              'circle-color': '#ef4444',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fff'
            }
          })
        }
      }
    } catch (error) {
      console.error('Error loading shelters:', error)
    }
  }

  const loadUserLayers = async () => {
    try {
      const countiesRes = await axios.get(`${API_BASE}/api/layers/counties`)
      if (map.current && countiesRes.data.features && !map.current.getSource('counties-user')) {
        map.current.addSource('counties-user', { type: 'geojson', data: countiesRes.data })
        map.current.addLayer({
          id: 'counties-user-line',
          type: 'line',
          source: 'counties-user',
          paint: { 'line-color': '#2563eb', 'line-width': 1.2 }
        })
      }

      const municipalitiesRes = await axios.get(`${API_BASE}/api/layers/municipalities`)
      if (map.current && municipalitiesRes.data.features && !map.current.getSource('municipalities-user')) {
        map.current.addSource('municipalities-user', { type: 'geojson', data: municipalitiesRes.data })
        map.current.addLayer({
          id: 'municipalities-user-line',
          type: 'line',
          source: 'municipalities-user',
          paint: { 'line-color': '#94a3b8', 'line-width': 0.6, 'line-opacity': 0.55 }
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

        if (map.current && following) {
          map.current.flyTo({ center: [lon, lat], zoom: 14 })
        }

        // Update user location in backend
        if (tracking) {
          axios.post(`${API_BASE}/api/users/${userId}/location`, { lon, lat }).catch(() => {})
        }
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

      // Draw route lines on map
      if (map.current && res.data.shelters.length > 0) {
        const shelf = res.data.shelters[0]
        const coordinates = [
          [userLocation.lon, userLocation.lat],
          [shelf.lon, shelf.lat]
        ]

        if (map.current.getSource('route-line')) {
          map.current.removeLayer('route-layer')
          map.current.removeSource('route-line')
        }

        map.current.addSource('route-line', {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates
            }
          }
        })

        map.current.addLayer({
          id: 'route-layer',
          type: 'line',
          source: 'route-line',
          paint: {
            'line-color': '#3b82f6',
            'line-width': 3,
            'line-dasharray': [5, 5]
          }
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
