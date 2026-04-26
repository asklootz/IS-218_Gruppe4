import React, { useState, useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import axios from 'axios'
import proj4 from 'proj4'
import { v4 as uuidv4 } from 'uuid'

const API_BASE = (() => {
  const configured = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '')
  if (!configured) return ''

  // Avoid mixed-content/network issues when app runs on HTTPS from another device.
  if (window.location.protocol === 'https:' && configured.startsWith('http://')) {
    return ''
  }

  return configured
})()
const OSM_RASTER_STYLE = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
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

const MOCK_USER_STORAGE_KEY = 'simulateMockUserIds'

function readStoredMockUserIds() {
  try {
    const value = JSON.parse(localStorage.getItem(MOCK_USER_STORAGE_KEY) || '[]')
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []
  } catch (error) {
    return []
  }
}

function writeStoredMockUserIds(ids) {
  localStorage.setItem(MOCK_USER_STORAGE_KEY, JSON.stringify(ids))
}

function createMockUserPositions(lon, lat, count) {
  const metersPerDegreeLat = 111320
  const metersPerDegreeLon = Math.max(111320 * Math.cos((lat * Math.PI) / 180), 1)

  return Array.from({ length: count }, (_, index) => {
    const distanceMeters = 10 + (index % 8) * 7 + Math.random() * 12
    const angle = Math.random() * Math.PI * 2

    return {
      lon: lon + (Math.cos(angle) * distanceMeters) / metersPerDegreeLon,
      lat: lat + (Math.sin(angle) * distanceMeters) / metersPerDegreeLat,
    }
  })
}

const DEFAULT_LOGISTICS_SETTINGS = {
  foodUnitsPerPerson: 1,
  waterUnitsPerPerson: 2,
  foodTruckCapacity: 120,
  waterTruckCapacity: 200,
  routeMode: 'car'
}

function toFiniteNumber(value, fallback = 0) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : fallback
}

function getPointCoordinate(feature) {
  const coordinates = feature?.geometry?.coordinates
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null
  const lon = Number(coordinates[0])
  const lat = Number(coordinates[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  return { lon, lat }
}

function haversineMeters(lon1, lat1, lon2, lat2) {
  const earthRadius = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function interpolatePointAlongLine(coordinates, progress) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null
  if (coordinates.length === 1) return coordinates[0]

  const clampedProgress = Math.min(1, Math.max(0, progress))
  const segmentLengths = []
  let totalLength = 0

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index]
    const end = coordinates[index + 1]
    const segmentLength = haversineMeters(start[0], start[1], end[0], end[1])
    segmentLengths.push(segmentLength)
    totalLength += segmentLength
  }

  if (totalLength <= 0) return coordinates[0]

  const targetDistance = totalLength * clampedProgress
  let traversed = 0

  for (let index = 0; index < segmentLengths.length; index += 1) {
    const start = coordinates[index]
    const end = coordinates[index + 1]
    const segmentLength = segmentLengths[index]

    if (traversed + segmentLength >= targetDistance) {
      const segmentProgress = segmentLength === 0 ? 0 : (targetDistance - traversed) / segmentLength
      return [
        start[0] + (end[0] - start[0]) * segmentProgress,
        start[1] + (end[1] - start[1]) * segmentProgress
      ]
    }

    traversed += segmentLength
  }

  return coordinates[coordinates.length - 1]
}

function trimLineByProgress(coordinates, progress) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return []
  if (coordinates.length === 1) return [coordinates[0]]

  const clampedProgress = Math.min(1, Math.max(0, progress))
  if (clampedProgress <= 0) return coordinates
  if (clampedProgress >= 1) return [coordinates[coordinates.length - 1]]

  const segmentLengths = []
  let totalLength = 0

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index]
    const end = coordinates[index + 1]
    const segmentLength = haversineMeters(start[0], start[1], end[0], end[1])
    segmentLengths.push(segmentLength)
    totalLength += segmentLength
  }

  if (totalLength <= 0) return [coordinates[coordinates.length - 1]]

  const targetDistance = totalLength * clampedProgress
  let traversed = 0

  for (let index = 0; index < segmentLengths.length; index += 1) {
    const start = coordinates[index]
    const end = coordinates[index + 1]
    const segmentLength = segmentLengths[index]

    if (traversed + segmentLength >= targetDistance) {
      const segmentProgress = segmentLength === 0 ? 0 : (targetDistance - traversed) / segmentLength
      const currentPoint = [
        start[0] + (end[0] - start[0]) * segmentProgress,
        start[1] + (end[1] - start[1]) * segmentProgress
      ]

      return [currentPoint, ...coordinates.slice(index + 1)]
    }

    traversed += segmentLength
  }

  return [coordinates[coordinates.length - 1]]
}

function buildGreedyTruckJobs({ sinks, sources, resourceType, unitsPerPerson, truckCapacity }) {
  const validSinks = (sinks || [])
    .map((sink) => ({ ...sink, live_users_count: toFiniteNumber(sink.live_users_count, 0) }))
    .filter((sink) => sink.live_users_count > 0)
    .sort((a, b) => b.live_users_count - a.live_users_count)

  const validSources = (sources || [])
    .map((source) => {
      const coordinate = getPointCoordinate(source)
      return coordinate ? { ...source, lon: coordinate.lon, lat: coordinate.lat } : null
    })
    .filter(Boolean)

  const sourceLoadCounts = new Map()
  const jobs = []

  for (const sink of validSinks) {
    const totalDemand = Math.max(0, Math.round(sink.live_users_count * unitsPerPerson))
    let remainingDemand = totalDemand

    while (remainingDemand > 0 && validSources.length > 0) {
      const loadAmount = Math.min(truckCapacity, remainingDemand)
      let selectedSource = null
      let selectedScore = Number.POSITIVE_INFINITY

      for (const source of validSources) {
        const sourceKey = String(source.id ?? source.name ?? `${source.lon},${source.lat}`)
        const assignedLoads = sourceLoadCounts.get(sourceKey) || 0
        const distanceMeters = haversineMeters(source.lon, source.lat, sink.lon, sink.lat)
        const score = distanceMeters + assignedLoads * 15000

        if (score < selectedScore) {
          selectedScore = score
          selectedSource = source
        }
      }

      if (!selectedSource) break

      const sourceKey = String(selectedSource.id ?? selectedSource.name ?? `${selectedSource.lon},${selectedSource.lat}`)
      sourceLoadCounts.set(sourceKey, (sourceLoadCounts.get(sourceKey) || 0) + 1)

      jobs.push({
        id: uuidv4(),
        resourceType,
        source: {
          id: selectedSource.id,
          name: selectedSource.name,
          lon: selectedSource.lon,
          lat: selectedSource.lat
        },
        target: {
          id: sink.id,
          name: sink.name,
          lon: sink.lon,
          lat: sink.lat,
          kind: sink.kind,
          live_users_count: sink.live_users_count
        },
        amount: loadAmount,
        truckCapacity,
        demand: totalDemand,
        unitsPerPerson,
        sourceScore: Math.round(selectedScore),
        status: 'planned',
        progress: 0,
        startedAt: null,
        completedAt: null,
        route: null,
        currentPosition: [selectedSource.lon, selectedSource.lat]
      })

      remainingDemand -= loadAmount
    }
  }

  return jobs
}

function createLogisticsGeoJson(jobs) {
  return {
    type: 'FeatureCollection',
    features: (jobs || []).flatMap((job) => {
      const routeFeature = job.route?.geometry?.coordinates?.length
        ? {
            type: 'Feature',
            geometry: job.route.geometry,
            properties: {
              truckId: job.id,
              resourceType: job.resourceType,
              amount: job.amount,
              status: job.status,
              sourceName: job.source?.name,
              targetName: job.target?.name,
              etaMinutes: job.etaMinutes || null
            }
          }
        : null

      const positionFeature = job.currentPosition
        ? {
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: job.currentPosition
            },
            properties: {
              truckId: job.id,
              resourceType: job.resourceType,
              amount: job.amount,
              status: job.status,
              sourceName: job.source?.name,
              targetName: job.target?.name,
              etaMinutes: job.etaMinutes || null,
              progress: Math.round((job.progress || 0) * 100)
            }
          }
        : null

      return [routeFeature, positionFeature].filter(Boolean)
    })
  }
}


function pageFromPath(pathname) {
  if (pathname === '/admin') return 'admin'
  if (pathname === '/simulate') return 'simulate'
  if (pathname === '/bruker') return 'user'
  return 'home'
}

function App() {
  const [page, setPage] = useState(pageFromPath(window.location.pathname))
  const [userId] = useState(localStorage.getItem('userId') || uuidv4())

  const navigate = (targetPage) => {
    const path = targetPage === 'admin'
      ? '/admin'
      : targetPage === 'user'
        ? '/bruker'
        : targetPage === 'simulate'
          ? '/simulate'
          : '/'
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
  if (page === 'simulate') {
    return <SimulatePage onBack={() => navigate('home')} />
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
          <button className="btn btn-simulate" onClick={() => navigate('simulate')}>
            🧪 Simuleringsvisning
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
  const liveUsersInterval = useRef(null)
  const markerLiveCountInterval = useRef(null)
  const sheltersGeoJsonRef = useRef({ type: 'FeatureCollection', features: [] })
  const safeAreasGeoJsonRef = useRef({ type: 'FeatureCollection', features: [] })
  const truckRoutesGeoJsonRef = useRef({ type: 'FeatureCollection', features: [] })
  const truckPositionsGeoJsonRef = useRef({ type: 'FeatureCollection', features: [] })
  const logisticsAnimationInterval = useRef(null)
  const logisticsRefreshInterval = useRef(null)
  const logisticsLayersLoaded = useRef(false)
  const truckIconsLoaded = useRef(false)
  const truckJobsRef = useRef([])
  const selectedTruckIdRef = useRef(null)
  const previewRouteRequestsRef = useRef(new Set())
  const [radius, setRadius] = useState(1000)
  const [coverage, setCoverage] = useState(null)
  const [loading, setLoading] = useState(false)
  const [logisticsLoading, setLogisticsLoading] = useState(false)
  const [logisticsStatus, setLogisticsStatus] = useState('Planer mock-truckruter fra gårder og vannkilder.')
  const [logisticsError, setLogisticsError] = useState('')
  const [logisticsSettings, setLogisticsSettings] = useState(DEFAULT_LOGISTICS_SETTINGS)
  const [truckJobs, setTruckJobs] = useState([])
  const [selectedTruckId, setSelectedTruckId] = useState(null)
  const [visibleLayers, setVisibleLayers] = useState({
    shelters: true,
    population: false,
    counties: false,
    municipalities: false,
    fire_stations: true,
    farms: true,
    water_sources: true,
    doctors: true,
    hospitals: true,
    safe_areas: true,
    live_users: true,
    logistics_food_routes: true,
    logistics_water_routes: true,
    radius: false
  })

  useEffect(() => {
    truckJobsRef.current = truckJobs
  }, [truckJobs])

  useEffect(() => {
    selectedTruckIdRef.current = selectedTruckId
  }, [selectedTruckId])

  useEffect(() => {
    if (!selectedTruckId) return
    ensurePreviewRouteForTruck(selectedTruckId)
  }, [selectedTruckId])

  const clearLogisticsAnimation = () => {
    if (logisticsAnimationInterval.current) {
      clearInterval(logisticsAnimationInterval.current)
      logisticsAnimationInterval.current = null
    }
  }

  const updateTruckMapSources = (jobs) => {
    if (!map.current) return

    const routeFeatures = []
    const positionFeatures = []

    for (const job of jobs || []) {
      const routeCoordinates = job.route?.geometry?.coordinates
      if (Array.isArray(routeCoordinates) && routeCoordinates.length > 0 && job.status !== 'arrived') {
        const visibleCoordinates = job.status === 'moving'
          ? trimLineByProgress(routeCoordinates, toFiniteNumber(job.progress, 0))
          : routeCoordinates

        if (visibleCoordinates.length >= 2) {
        routeFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: visibleCoordinates,
          },
          properties: {
            truckId: job.id,
            resourceType: job.resourceType,
            amount: job.amount,
            status: job.status,
            sourceName: job.source?.name,
            targetName: job.target?.name,
            etaMinutes: job.etaMinutes || null,
            selected: job.id === selectedTruckIdRef.current
          }
        })
        }
      }

      const currentPosition = job.currentPosition || [job.source?.lon, job.source?.lat]
      if (Array.isArray(currentPosition) && currentPosition.length >= 2) {
        positionFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: currentPosition
          },
          properties: {
            truckId: job.id,
            resourceType: job.resourceType,
            amount: job.amount,
            status: job.status,
            sourceName: job.source?.name,
            targetName: job.target?.name,
            etaMinutes: job.etaMinutes || null,
            progress: Math.round((job.progress || 0) * 100),
            selected: job.id === selectedTruckIdRef.current
          }
        })
      }
    }

    const nextRoutes = { type: 'FeatureCollection', features: routeFeatures }
    const nextPositions = { type: 'FeatureCollection', features: positionFeatures }

    truckRoutesGeoJsonRef.current = nextRoutes
    truckPositionsGeoJsonRef.current = nextPositions

    if (map.current.getSource('logistics-routes')) {
      map.current.getSource('logistics-routes').setData(nextRoutes)
    }
    if (map.current.getSource('logistics-trucks')) {
      map.current.getSource('logistics-trucks').setData(nextPositions)
    }
  }

  const ensurePreviewRouteForTruck = async (truckId) => {
    if (!truckId) return null

    const currentJob = truckJobsRef.current.find((job) => job.id === truckId)
    if (!currentJob) return null

    const hasPreviewGeometry = Array.isArray(currentJob.route?.geometry?.coordinates)
      && currentJob.route.geometry.coordinates.length >= 2

    if (hasPreviewGeometry) {
      return currentJob
    }

    if (previewRouteRequestsRef.current.has(truckId)) {
      return currentJob
    }

    previewRouteRequestsRef.current.add(truckId)
    try {
      const res = await axios.post(`${API_BASE}/api/admin/logistics/trucks/${truckId}/preview-route`)
      const nextJobs = Array.isArray(res.data?.jobs) ? res.data.jobs : []
      if (nextJobs.length > 0) {
        truckJobsRef.current = nextJobs
        setTruckJobs(nextJobs)
        updateTruckMapSources(nextJobs)
        return nextJobs.find((job) => job.id === truckId) || null
      }
      return currentJob
    } catch (error) {
      console.warn('Failed to preview truck route:', error.message)
      return currentJob
    } finally {
      previewRouteRequestsRef.current.delete(truckId)
    }
  }

  const syncTruckProgressToBackend = async (jobs) => {
    const movableJobs = (jobs || []).filter((job) => ['moving', 'arrived'].includes(job.status))
    if (movableJobs.length === 0) return

    try {
      const responses = await Promise.all(movableJobs.map((job) => axios.patch(
        `${API_BASE}/api/admin/logistics/trucks/${job.id}`,
        {
          status: job.status,
          leg: job.leg || 'outbound',
          startedAt: job.startedAt || null,
          completedAt: job.completedAt || null,
          progress: job.progress || 0,
          currentPosition: job.currentPosition || [job.source?.lon, job.source?.lat]
        }
      )))

      const latestPlan = responses.at(-1)?.data
      const latestJobs = Array.isArray(latestPlan?.jobs) ? latestPlan.jobs : null
      if (latestJobs) {
        truckJobsRef.current = latestJobs
        setTruckJobs(latestJobs)
        updateTruckMapSources(latestJobs)
      }
    } catch (error) {
      console.warn('Failed to sync truck progress:', error.message)
    }
  }

  const loadPersistedLogisticsPlan = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/admin/logistics/plan`)
      const jobs = Array.isArray(res.data?.jobs) ? res.data.jobs : []
      truckJobsRef.current = jobs
      setTruckJobs(jobs)
      setSelectedTruckId((currentSelected) => currentSelected || jobs[0]?.id || null)
      setLogisticsStatus(jobs.length > 0 ? `Laster lagret plan med ${jobs.length} ruter.` : 'Ingen lagret forsyningsplan ennå.')
      updateTruckMapSources(jobs)

      if (jobs.some((job) => job.status === 'moving')) {
        startLogisticsAnimation()
      }
    } catch (error) {
      console.warn('Failed to load persisted logistics plan:', error.message)
    }
  }

  const ensureTruckIcons = async () => {
    if (!map.current || truckIconsLoaded.current) return

    const svgToDataUri = (svg) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
    const loadSvgImage = (id, svg) => new Promise((resolve, reject) => {
      if (map.current.hasImage(id)) {
        resolve()
        return
      }

      const image = new Image()
      image.onload = () => {
        if (!map.current.hasImage(id)) {
          map.current.addImage(id, image)
        }
        resolve()
      }
      image.onerror = reject
      image.src = svgToDataUri(svg)
    })

    await Promise.all([
      loadSvgImage(
        'food-truck-icon',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><path d="M14 26c0-6 4.9-11 11-11h14c6.1 0 11 5 11 11v15H14V26z" fill="#8b5e34"/><rect x="12" y="34" width="40" height="14" rx="4" fill="#a8733f"/><circle cx="22" cy="50" r="6" fill="#111827"/><circle cx="22" cy="50" r="3" fill="#d1d5db"/><circle cx="44" cy="50" r="6" fill="#111827"/><circle cx="44" cy="50" r="3" fill="#d1d5db"/></svg>`
      ),
      loadSvgImage(
        'water-truck-icon',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><path d="M32 8c-7.5 9.3-15 17.4-15 27.1C17 44.4 24.2 52 32 52s15-7.6 15-16.9C47 25.4 39.5 17.3 32 8z" fill="#0ea5e9" stroke="#075985" stroke-width="2"/><rect x="18" y="34" width="28" height="10" rx="3" fill="#38bdf8" opacity="0.85"/></svg>`
      )
    ])

    truckIconsLoaded.current = true
  }

  const ensureLogisticsLayers = async () => {
    if (!map.current || logisticsLayersLoaded.current) return

    await ensureTruckIcons()

    if (!map.current.getSource('logistics-routes')) {
      map.current.addSource('logistics-routes', {
        type: 'geojson',
        data: truckRoutesGeoJsonRef.current
      })
      map.current.addLayer({
        id: 'logistics-routes-food-layer',
        type: 'line',
        source: 'logistics-routes',
        filter: ['==', ['get', 'resourceType'], 'food'],
        paint: {
          'line-color': '#8b5e34',
          'line-width': [
            'case',
            ['==', ['get', 'selected'], true],
            6,
            ['==', ['get', 'status'], 'moving'],
            5,
            3
          ],
          'line-opacity': [
            'case',
            ['==', ['get', 'selected'], true],
            0.95,
            ['==', ['get', 'status'], 'arrived'],
            0.35,
            0.7
          ]
        }
      })

      map.current.addLayer({
        id: 'logistics-routes-water-layer',
        type: 'line',
        source: 'logistics-routes',
        filter: ['==', ['get', 'resourceType'], 'water'],
        paint: {
          'line-color': '#0ea5e9',
          'line-width': [
            'case',
            ['==', ['get', 'selected'], true],
            6,
            ['==', ['get', 'status'], 'moving'],
            5,
            3
          ],
          'line-opacity': [
            'case',
            ['==', ['get', 'selected'], true],
            0.95,
            ['==', ['get', 'status'], 'arrived'],
            0.35,
            0.7
          ]
        }
      })
    }

    if (!map.current.getSource('logistics-trucks')) {
      map.current.addSource('logistics-trucks', {
        type: 'geojson',
        data: truckPositionsGeoJsonRef.current
      })
      map.current.addLayer({
        id: 'logistics-trucks-layer',
        type: 'symbol',
        source: 'logistics-trucks',
        layout: {
          'icon-image': [
            'case',
            ['==', ['get', 'resourceType'], 'water'],
            'water-truck-icon',
            'food-truck-icon'
          ],
          'icon-size': 0.45,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'text-field': ['to-string', ['get', 'amount']],
          'text-size': 10,
          'text-offset': [0, 1.35],
          'text-allow-overlap': true,
          'text-ignore-placement': true
        },
        paint: {
          'text-color': '#111827',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.2,
          'icon-opacity': [
            'case',
            ['==', ['get', 'status'], 'arrived'],
            0.45,
            1
          ]
        }
      })
    }

    const handleRouteLayerClick = async (e) => {
      const f = e.features?.[0]
      if (!f) return
      const truckId = f.properties?.truckId
      const job = truckJobsRef.current.find((entry) => entry.id === truckId)
      if (!job) return
      setSelectedTruckId(job.id)
      const previewedJob = await ensurePreviewRouteForTruck(job.id)
      showTruckRoutePopup(previewedJob || job, e.lngLat)
    }

    map.current.on('click', 'logistics-routes-food-layer', handleRouteLayerClick)
    map.current.on('click', 'logistics-routes-water-layer', handleRouteLayerClick)

    map.current.on('click', 'logistics-trucks-layer', async (e) => {
      const f = e.features?.[0]
      if (!f) return
      const truckId = f.properties?.truckId
      const job = truckJobsRef.current.find((entry) => entry.id === truckId)
      if (!job) return
      setSelectedTruckId(job.id)
      const previewedJob = await ensurePreviewRouteForTruck(job.id)
      showTruckRoutePopup(previewedJob || job, e.lngLat)
    })

    map.current.on('mouseenter', 'logistics-routes-food-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
    map.current.on('mouseleave', 'logistics-routes-food-layer', () => { map.current.getCanvas().style.cursor = '' })
    map.current.on('mouseenter', 'logistics-routes-water-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
    map.current.on('mouseleave', 'logistics-routes-water-layer', () => { map.current.getCanvas().style.cursor = '' })
    map.current.on('mouseenter', 'logistics-trucks-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
    map.current.on('mouseleave', 'logistics-trucks-layer', () => { map.current.getCanvas().style.cursor = '' })

    logisticsLayersLoaded.current = true
  }

  const showTruckRoutePopup = (job, lngLat) => {
    if (!job) return
    const isMoving = job.status === 'moving'
    const isArrived = job.status === 'arrived'
    const isReturning = isMoving && job.leg === 'return'
    const destinationLabel = isReturning ? (job.source?.name || 'Unknown source') : (job.target?.name || 'Unknown destination')
    const statusLabel = isArrived ? 'Arrived' : isReturning ? 'Returning' : isMoving ? 'Moving' : 'Planned'
    const html = `
      <div style="font-size:12px;line-height:1.45;min-width:240px;">
        <strong>${job.resourceType === 'water' ? '💧 Water truck' : '🍞 Food truck'}</strong><br/>
        Fra: ${job.source?.name || 'Unknown source'}<br/>
        Til: ${destinationLabel}<br/>
        Mengde: ${job.amount} units<br/>
        ETA: ${job.etaMinutes ? `${job.etaMinutes} min` : 'Calculating...'}<br/>
        Status: ${statusLabel}<br/>
        <button id="dispatch-selected-truck" style="margin-top:8px;padding:6px 8px;background:${isMoving || isArrived ? '#9ca3af' : '#0ea5e9'};color:white;border:none;border-radius:4px;cursor:${isMoving || isArrived ? 'not-allowed' : 'pointer'};font-size:11px;width:100%;" ${isMoving || isArrived ? 'disabled' : ''}>${isMoving ? 'On route' : isArrived ? 'Completed' : 'Send truck'}</button>
      </div>
    `
    const popup = new maplibregl.Popup({ closeButton: true })
      .setLngLat(lngLat || [job.target?.lon || job.source?.lon, job.target?.lat || job.source?.lat])
      .setHTML(html)
      .addTo(map.current)

    const dispatchButton = popup.getElement()?.querySelector('#dispatch-selected-truck')
    if (dispatchButton && !isMoving && !isArrived) {
      dispatchButton.addEventListener('click', async () => {
        popup.remove()
        await dispatchTruck(job.id)
      })
    }
  }

  const startLogisticsAnimation = () => {
    if (logisticsAnimationInterval.current) return

    logisticsAnimationInterval.current = setInterval(() => {
      const now = Date.now()
      const currentJobs = truckJobsRef.current
      const nextJobs = currentJobs.map((job) => {
        if (job.status !== 'moving' || !job.route?.geometry?.coordinates?.length || !job.startedAt) {
          return job
        }

        const durationMs = Math.max(1000, Number(job.route.duration_s || 0) * 1000)
        const progress = Math.min(1, (now - job.startedAt) / durationMs)
        const currentPosition = interpolatePointAlongLine(job.route.geometry.coordinates, progress)

        if (progress >= 1) {
          return {
            ...job,
            progress: 1,
            currentPosition,
            status: 'arrived',
            completedAt: now
          }
        }

        return {
          ...job,
          progress,
          currentPosition
        }
      })

      truckJobsRef.current = nextJobs
      setTruckJobs(nextJobs)
      updateTruckMapSources(nextJobs)
      syncTruckProgressToBackend(nextJobs)

      if (!nextJobs.some((job) => job.status === 'moving')) {
        clearLogisticsAnimation()
      }
    }, 1000)
  }

  const fetchRouteForTruck = async (job) => {
    const response = await axios.get(`${API_BASE}/api/routing/route`, {
      params: {
        originLon: job.source.lon,
        originLat: job.source.lat,
        destLon: job.target.lon,
        destLat: job.target.lat,
        mode: logisticsSettings.routeMode
      }
    })

    const route = response.data || {}
    const etaMinutes = Math.max(1, Math.round(Number(route.duration_s || 0) / 60))

    return {
      ...job,
      route,
      etaMinutes,
      etaLabel: `${etaMinutes} min`,
      distanceKm: (Number(route.distance_m || 0) / 1000).toFixed(2),
      currentPosition: [job.source.lon, job.source.lat]
    }
  }

  const loadLogisticsInputs = async () => {
    const [sheltersRes, shelterCountsRes, safeAreasRes, safeAreaCountsRes, farmsRes, waterRes] = await Promise.all([
      axios.get(`${API_BASE}/api/layers/shelters`),
      axios.get(`${API_BASE}/api/admin/shelters/live-users?radius=150`),
      axios.get(`${API_BASE}/api/layers/safe-areas`),
      axios.get(`${API_BASE}/api/admin/safe-areas/live-users?radius=150`),
      axios.get(`${API_BASE}/api/layers/farms`),
      axios.get(`${API_BASE}/api/layers/water_sources`)
    ])

    const shelterCountMap = new Map((shelterCountsRes.data?.counts || []).map((row) => [Number(row.id), Number(row.live_users_count || 0)]))
    const safeAreaCountMap = new Map((safeAreaCountsRes.data?.counts || []).map((row) => [Number(row.id), Number(row.live_users_count || 0)]))

    const shelters = (sheltersRes.data?.features || [])
      .map((feature) => {
        const coordinate = getPointCoordinate(feature)
        if (!coordinate) return null
        return {
          id: Number(feature.properties?.id),
          name: feature.properties?.name || `Shelter ${feature.properties?.id}`,
          lon: coordinate.lon,
          lat: coordinate.lat,
          live_users_count: shelterCountMap.get(Number(feature.properties?.id)) || 0,
          kind: 'shelter'
        }
      })
      .filter(Boolean)

    const safeAreas = (safeAreasRes.data?.features || [])
      .map((feature) => {
        const coordinate = getPointCoordinate(feature)
        if (!coordinate) return null
        return {
          id: Number(feature.properties?.id),
          name: feature.properties?.name || `Safe area ${feature.properties?.id}`,
          lon: coordinate.lon,
          lat: coordinate.lat,
          live_users_count: safeAreaCountMap.get(Number(feature.properties?.id)) || 0,
          kind: 'safe_area'
        }
      })
      .filter(Boolean)

    const foodSources = (farmsRes.data?.features || [])
      .map((feature) => {
        const coordinate = getPointCoordinate(feature)
        if (!coordinate) return null
        return {
          id: Number(feature.properties?.id),
          name: feature.properties?.name || `Farm ${feature.properties?.id}`,
          lon: coordinate.lon,
          lat: coordinate.lat,
          kind: 'farm'
        }
      })
      .filter(Boolean)

    const waterSources = (waterRes.data?.features || [])
      .map((feature) => {
        const coordinate = getPointCoordinate(feature)
        if (!coordinate) return null
        return {
          id: Number(feature.properties?.id),
          name: feature.properties?.name || `Water source ${feature.properties?.id}`,
          lon: coordinate.lon,
          lat: coordinate.lat,
          kind: 'water_source'
        }
      })
      .filter(Boolean)

    return {
      sinks: [...shelters, ...safeAreas],
      foodSources,
      waterSources
    }
  }

  const buildLogisticsPlan = async () => {
    setLogisticsLoading(true)
    setLogisticsError('')
    setLogisticsStatus('Beregner truckruter og fordeler last...')

    try {
      const res = await axios.post(`${API_BASE}/api/admin/logistics/plan`, {
        settings: logisticsSettings
      })
      const plannedJobs = Array.isArray(res.data?.jobs) ? res.data.jobs : []

      setTruckJobs(plannedJobs)
      truckJobsRef.current = plannedJobs
      setSelectedTruckId(plannedJobs[0]?.id || null)
      updateTruckMapSources(plannedJobs)
      setLogisticsStatus(
        plannedJobs.length > 0
          ? `Plan ferdig: ${plannedJobs.length} mock-trucker klare.`
          : 'Ingen mock-trucker kunne planlegges. Legg mock-brukere nær en tilfluktsrom eller tryggsone, eller prøv å beregne på nytt etter at det finnes behov.'
      )
      if (plannedJobs[0]?.route?.geometry?.coordinates?.length) {
        const bounds = new maplibregl.LngLatBounds()
        plannedJobs[0].route.geometry.coordinates.forEach(([lon, lat]) => bounds.extend([lon, lat]))
        map.current?.fitBounds(bounds, { padding: 80, duration: 600 })
      }
    } catch (error) {
      console.error('Error building logistics plan:', error)
      setLogisticsError('Kunne ikke bygge forsyningsplanen. Se konsollen for detaljer.')
      setLogisticsStatus('Planlegging feilet.')
    } finally {
      setLogisticsLoading(false)
    }
  }

  const dispatchTruck = async (truckId) => {
    try {
      const res = await axios.post(`${API_BASE}/api/admin/logistics/trucks/${truckId}/dispatch`)
      const nextJobs = Array.isArray(res.data?.jobs) ? res.data.jobs : []
      const currentJob = nextJobs.find((job) => job.id === truckId)

      truckJobsRef.current = nextJobs
      setTruckJobs(nextJobs)
      updateTruckMapSources(nextJobs)
      setSelectedTruckId(truckId)
      setLogisticsStatus(currentJob ? `Truck ${currentJob.id} er sendt.` : 'Truck er sendt.')
      if (nextJobs.some((job) => job.status === 'moving')) {
        startLogisticsAnimation()
      }
    } catch (error) {
      console.error('Error dispatching logistics truck:', error)
      setLogisticsError('Kunne ikke sende trucken.')
    }
  }

  const dispatchAllTrucks = async () => {
    if (truckJobsRef.current.length === 0) return

    try {
      const res = await axios.post(`${API_BASE}/api/admin/logistics/dispatch-all`)
      const nextJobs = Array.isArray(res.data?.jobs) ? res.data.jobs : []

      truckJobsRef.current = nextJobs
      setTruckJobs(nextJobs)
      updateTruckMapSources(nextJobs)
      setLogisticsStatus('Alle mock-trucker er sendt.')
      if (nextJobs.some((job) => job.status === 'moving')) {
        startLogisticsAnimation()
      }
    } catch (error) {
      console.error('Error dispatching all logistics trucks:', error)
      setLogisticsError('Kunne ikke sende alle truckene.')
    }
  }

  const clearLogisticsPlan = () => {
    ;(async () => {
      try {
        await axios.delete(`${API_BASE}/api/admin/logistics/plan`)
        clearLogisticsAnimation()
        truckJobsRef.current = []
        setTruckJobs([])
        truckRoutesGeoJsonRef.current = { type: 'FeatureCollection', features: [] }
        truckPositionsGeoJsonRef.current = { type: 'FeatureCollection', features: [] }
        setSelectedTruckId(null)
        setLogisticsStatus('Forsyningsplan fjernet.')
        if (map.current?.getSource('logistics-routes')) {
          map.current.getSource('logistics-routes').setData(truckRoutesGeoJsonRef.current)
        }
        if (map.current?.getSource('logistics-trucks')) {
          map.current.getSource('logistics-trucks').setData(truckPositionsGeoJsonRef.current)
        }
      } catch (error) {
        console.error('Error clearing logistics plan:', error)
        setLogisticsError('Kunne ikke tømme planen.')
      }
    })()
  }

  const focusTruckRoute = async (job) => {
    if (!job) return
    setSelectedTruckId(job.id)

    const previewedJob = await ensurePreviewRouteForTruck(job.id)
    const routeJob = previewedJob || job

    if (map.current && routeJob.route?.geometry?.coordinates?.length) {
      const bounds = new maplibregl.LngLatBounds()
      routeJob.route.geometry.coordinates.forEach(([lon, lat]) => bounds.extend([lon, lat]))
      map.current.fitBounds(bounds, { padding: 80, duration: 600, maxZoom: 15 })
    }
  }

  const selectedTruckJob = selectedTruckId ? truckJobs.find((job) => job.id === selectedTruckId) : null

  useEffect(() => {
    if (!mapContainer.current) return

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: OSM_RASTER_STYLE,
      center: [8.0000, 58.1467],
      zoom: 10
    })

    map.current.on('load', () => initializeAdminMap())

    return () => {
      if (liveUsersInterval.current) {
        clearInterval(liveUsersInterval.current)
        liveUsersInterval.current = null
      }
      if (markerLiveCountInterval.current) {
        clearInterval(markerLiveCountInterval.current)
        markerLiveCountInterval.current = null
      }
      if (logisticsAnimationInterval.current) {
        clearInterval(logisticsAnimationInterval.current)
        logisticsAnimationInterval.current = null
      }
      if (logisticsRefreshInterval.current) {
        clearInterval(logisticsRefreshInterval.current)
        logisticsRefreshInterval.current = null
      }
      map.current?.remove()
    }
  }, [])

  const clearMarkerLiveCountInterval = () => {
    if (markerLiveCountInterval.current) {
      clearInterval(markerLiveCountInterval.current)
      markerLiveCountInterval.current = null
    }
  }

  const bindLiveUserCountToPopup = ({ popup, endpoint, updateMs = 10000 }) => {
    const popupElement = popup.getElement()
    const countEl = popupElement?.querySelector('.live-users-count')
    if (!countEl) return

    clearMarkerLiveCountInterval()

    const refreshCount = async () => {
      try {
        const res = await axios.get(endpoint)
        const count = Number(res.data?.live_users_count || 0)
        countEl.textContent = String(count)
      } catch (error) {
        countEl.textContent = '0'
      }
    }

    refreshCount()
    markerLiveCountInterval.current = setInterval(refreshCount, updateMs)
    popup.on('close', clearMarkerLiveCountInterval)
  }

  const applyLiveCountsToSource = (sourceId, geojsonRef, counts = []) => {
    if (!map.current || !map.current.getSource(sourceId)) return
    const current = geojsonRef.current
    if (!current || !Array.isArray(current.features)) return

    const countMap = new Map(
      (counts || []).map((row) => [Number(row.id), Number(row.live_users_count || 0)])
    )

    const updated = {
      ...current,
      features: current.features.map((feature) => {
        const featureId = Number(feature?.properties?.id)
        const count = Number.isFinite(featureId) ? (countMap.get(featureId) || 0) : 0
        return {
          ...feature,
          properties: {
            ...(feature.properties || {}),
            live_users_count: count,
          },
        }
      }),
    }

    geojsonRef.current = updated
    map.current.getSource(sourceId).setData(updated)
  }

  const refreshMarkerLiveCounts = async () => {
    if (!map.current) return
    try {
      const [shelterRes, safeAreasRes] = await Promise.all([
        axios.get(`${API_BASE}/api/admin/shelters/live-users?radius=150`),
        axios.get(`${API_BASE}/api/admin/safe-areas/live-users?radius=150`)
      ])

      applyLiveCountsToSource('shelters', sheltersGeoJsonRef, shelterRes.data?.counts || [])
      applyLiveCountsToSource('safe-areas', safeAreasGeoJsonRef, safeAreasRes.data?.counts || [])
    } catch (error) {
      console.warn('Failed to refresh marker live counts:', error.message)
    }
  }

  const applyAdminLayerVisibility = () => {
    if (!map.current) return
    const setVisibility = (layerId, visible) => {
      if (map.current.getLayer(layerId)) {
        map.current.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
      }
    }
    setVisibility('shelters-layer', visibleLayers.shelters)
    setVisibility('shelters-live-count-layer', visibleLayers.shelters)
    setVisibility('population-layer', visibleLayers.population)
    setVisibility('counties-fill', visibleLayers.counties)
    setVisibility('counties-line', visibleLayers.counties)
    setVisibility('municipalities-line', visibleLayers.municipalities)
    setVisibility('fire_stations-layer', visibleLayers.fire_stations)
    setVisibility('farms-layer', visibleLayers.farms)
    setVisibility('water_sources-layer', visibleLayers.water_sources)
    setVisibility('doctors-layer', visibleLayers.doctors)
    setVisibility('hospitals-layer', visibleLayers.hospitals)
    setVisibility('safe-areas-layer', visibleLayers.safe_areas)
    setVisibility('safe-areas-live-count-layer', visibleLayers.safe_areas)
    setVisibility('live-users-layer', visibleLayers.live_users)
    setVisibility('logistics-routes-food-layer', visibleLayers.logistics_food_routes)
    setVisibility('logistics-routes-water-layer', visibleLayers.logistics_water_routes)
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
        sheltersGeoJsonRef.current = sheltersRes.data
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
          map.current.addLayer({
            id: 'shelters-live-count-layer',
            type: 'symbol',
            source: 'shelters',
            layout: {
              'text-field': ['to-string', ['coalesce', ['get', 'live_users_count'], 0]],
              'text-size': 11,
              'text-offset': [0, -1.6],
              'text-allow-overlap': true,
              'text-ignore-placement': true
            },
            paint: {
              'text-color': '#111827',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.2
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
              'fill-color': '#00000000',
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

      // Load safe areas
      try {
        const safeAreasRes = await axios.get(`${API_BASE}/api/layers/safe-areas`)
        safeAreasGeoJsonRef.current = safeAreasRes.data || { type: 'FeatureCollection', features: [] }
        if (!map.current.getSource('safe-areas')) {
          map.current.addSource('safe-areas', { type: 'geojson', data: safeAreasRes.data || { type: 'FeatureCollection', features: [] } })
          map.current.addLayer({
            id: 'safe-areas-layer',
            type: 'circle',
            source: 'safe-areas',
            paint: {
              'circle-radius': 6,
              'circle-color': '#8b5cf6',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fff'
            }
          })
          map.current.addLayer({
            id: 'safe-areas-live-count-layer',
            type: 'symbol',
            source: 'safe-areas',
            layout: {
              'text-field': ['to-string', ['coalesce', ['get', 'live_users_count'], 0]],
              'text-size': 11,
              'text-offset': [0, -1.6],
              'text-allow-overlap': true,
              'text-ignore-placement': true
            },
            paint: {
              'text-color': '#111827',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.2
            }
          })
          console.log('Added layer: safe-areas-layer')
        } else {
          map.current.getSource('safe-areas').setData(safeAreasRes.data || { type: 'FeatureCollection', features: [] })
        }
      } catch (error) {
        console.warn('Failed to load safe areas:', error.message)
        // Create empty layer anyway so click handler works
        if (!map.current.getSource('safe-areas')) {
          const emptySafeAreas = { type: 'FeatureCollection', features: [] }
          safeAreasGeoJsonRef.current = emptySafeAreas
          map.current.addSource('safe-areas', { type: 'geojson', data: emptySafeAreas })
          map.current.addLayer({
            id: 'safe-areas-layer',
            type: 'circle',
            source: 'safe-areas',
            paint: {
              'circle-radius': 6,
              'circle-color': '#8b5cf6',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fff'
            }
          })
          map.current.addLayer({
            id: 'safe-areas-live-count-layer',
            type: 'symbol',
            source: 'safe-areas',
            layout: {
              'text-field': ['to-string', ['coalesce', ['get', 'live_users_count'], 0]],
              'text-size': 11,
              'text-offset': [0, -1.6],
              'text-allow-overlap': true,
              'text-ignore-placement': true
            },
            paint: {
              'text-color': '#111827',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.2
            }
          })
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
      sheltersGeoJsonRef.current = shelterFc
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

  const loadLiveUsers = async () => {
    if (!map.current) return
    try {
      const res = await axios.get(`${API_BASE}/api/admin/live-users`)
      const fc = res.data?.type === 'FeatureCollection'
        ? res.data
        : { type: 'FeatureCollection', features: [] }

      if (!map.current.getSource('live-users')) {
        map.current.addSource('live-users', { type: 'geojson', data: fc })
        map.current.addLayer({
          id: 'live-users-layer',
          type: 'circle',
          source: 'live-users',
          paint: {
            'circle-radius': 7,
            'circle-color': '#0ea5e9',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
          }
        })
      } else {
        map.current.getSource('live-users').setData(fc)
      }

      await refreshMarkerLiveCounts()

      applyAdminLayerVisibility()
    } catch (error) {
      console.warn('Failed to load live users:', error.message)
    }
  }

  const initializeAdminMap = async () => {
    await loadStaticLayers()
    await loadCoverageAndRadius(radius)
    await loadLiveUsers()
    await ensureLogisticsLayers()
    await loadPersistedLogisticsPlan()

    if (!liveUsersInterval.current) {
      liveUsersInterval.current = setInterval(() => {
        loadLiveUsers()
      }, 10000)
    }

    if (!logisticsRefreshInterval.current) {
      logisticsRefreshInterval.current = setInterval(() => {
        loadPersistedLogisticsPlan()
      }, 10000)
    }

    if (!adminPopupBound.current && map.current) {
      map.current.on('click', 'shelters-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const shelterId = Number(p.id)
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>${p.name || 'Tilfluktsrom'}</strong><br/>
            Kapasitet: ${p.capacity ?? 0}<br/>
            Område: #${p.cluster_id ?? '-'}<br/>
            Befolkning i område: ${p.cluster_population ?? 0}<br/>
            Ledige plasser i område: ${p.cluster_free_spaces ?? 0}<br/>
            Manglende kapasitet: ${p.missing_capacity ?? 0}<br/>
            Aktive brukere innen 150m: <strong class="live-users-count">Laster...</strong>
          </div>
        `
        const popup = new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)

        if (Number.isFinite(shelterId)) {
          bindLiveUserCountToPopup({
            popup,
            endpoint: `${API_BASE}/api/admin/shelters/${shelterId}/live-users?radius=150`
          })
        } else {
          const countEl = popup.getElement()?.querySelector('.live-users-count')
          if (countEl) countEl.textContent = '0'
        }
      })
      map.current.on('mouseenter', 'shelters-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'shelters-layer', () => { map.current.getCanvas().style.cursor = '' })

      // Add popup handlers for fire stations
      map.current.on('click', 'fire_stations-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>🚒 Brannstasjon</strong><br/>
            ${p.name ? `<strong>${p.name}</strong><br/>` : ''}
            ${p.website ? `<a href="${p.website}" target="_blank">Besøk nettside</a><br/>` : ''}
            ${p.phone ? `Telefon: ${p.phone}<br/>` : ''}
          </div>
        `
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)
      })
      map.current.on('mouseenter', 'fire_stations-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'fire_stations-layer', () => { map.current.getCanvas().style.cursor = '' })

      // Add popup handlers for farms
      map.current.on('click', 'farms-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>🌾 Gård</strong><br/>
            ${p.name ? `<strong>${p.name}</strong><br/>` : ''}
          </div>
        `
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)
      })
      map.current.on('mouseenter', 'farms-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'farms-layer', () => { map.current.getCanvas().style.cursor = '' })

      // Add popup handlers for water sources
      map.current.on('click', 'water_sources-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>💧 Vannkilde</strong><br/>
            ${p.name ? `<strong>${p.name}</strong><br/>` : ''}
          </div>
        `
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)
      })
      map.current.on('mouseenter', 'water_sources-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'water_sources-layer', () => { map.current.getCanvas().style.cursor = '' })

      // Add popup handlers for doctors
      map.current.on('click', 'doctors-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>👨‍⚕️ Lege</strong><br/>
            ${p.name ? `<strong>${p.name}</strong><br/>` : ''}
            ${p.website ? `<a href="${p.website}" target="_blank">Besøk nettside</a><br/>` : ''}
            ${p.phone ? `Telefon: ${p.phone}<br/>` : ''}
          </div>
        `
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)
      })
      map.current.on('mouseenter', 'doctors-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'doctors-layer', () => { map.current.getCanvas().style.cursor = '' })

      // Add popup handlers for hospitals
      map.current.on('click', 'hospitals-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>🏥 Sykehus</strong><br/>
            ${p.name ? `<strong>${p.name}</strong><br/>` : ''}
            ${p.website ? `<a href="${p.website}" target="_blank">Besøk nettside</a><br/>` : ''}
            ${p.phone ? `Telefon: ${p.phone}<br/>` : ''}
          </div>
        `
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)
      })
      map.current.on('mouseenter', 'hospitals-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'hospitals-layer', () => { map.current.getCanvas().style.cursor = '' })

      // Add popup handlers for safe areas
      map.current.on('click', 'safe-areas-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const safeAreaId = p.id
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>🛡️ Trygt område</strong><br/>
            <strong>${p.name}</strong><br/>
            Kapasitet: ${p.capacity ?? 0}<br/>
            Aktive brukere innen 150m: <strong class="live-users-count">Laster...</strong><br/>
            <button id="deleteSafeAreaBtn" class="delete-btn" style="margin-top:8px;padding:4px 8px;background:#ef4444;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;width:100%;">Slett</button>
          </div>
        `
        const popup = new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)

        if (Number.isFinite(Number(safeAreaId))) {
          bindLiveUserCountToPopup({
            popup,
            endpoint: `${API_BASE}/api/admin/safe-areas/${safeAreaId}/live-users?radius=150`
          })
        } else {
          const countEl = popup.getElement()?.querySelector('.live-users-count')
          if (countEl) countEl.textContent = '0'
        }
        
        const popupElement = popup.getElement()
        const deleteBtn = popupElement?.querySelector('#deleteSafeAreaBtn')
        if (deleteBtn) {
          deleteBtn.addEventListener('click', async () => {
            try {
              await axios.delete(`${API_BASE}/api/admin/safe-areas/${safeAreaId}`)
              popup.remove()
              const res = await axios.get(`${API_BASE}/api/layers/safe-areas`)
              safeAreasGeoJsonRef.current = res.data || { type: 'FeatureCollection', features: [] }
              if (map.current.getSource('safe-areas')) {
                map.current.getSource('safe-areas').setData(res.data)
              }
              await refreshMarkerLiveCounts()
            } catch (error) {
              console.error('Error deleting safe area:', error)
              alert('Feil ved sletting av område')
            }
          })
        }
      })
      map.current.on('mouseenter', 'safe-areas-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'safe-areas-layer', () => { map.current.getCanvas().style.cursor = '' })

      map.current.on('click', 'live-users-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>📍 Aktiv bruker</strong><br/>
            ID: ${p.user_id || '-'}<br/>
            Sist oppdatert: ${p.last_seen ? new Date(p.last_seen).toLocaleString() : '-'}
          </div>
        `
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)
      })
      map.current.on('mouseenter', 'live-users-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'live-users-layer', () => { map.current.getCanvas().style.cursor = '' })

      // Add click handler to map for creating new safe areas
      map.current.on('click', (e) => {
        const candidateLayers = [
          'shelters-layer',
          'logistics-routes-food-layer',
          'logistics-routes-water-layer',
          'logistics-trucks-layer',
          'fire_stations-layer',
          'farms-layer',
          'water_sources-layer',
          'doctors-layer',
          'hospitals-layer',
          'live-users-layer',
          'safe-areas-layer'
        ]
        const layersToQuery = candidateLayers.filter((layerId) => map.current.getLayer(layerId))
        
        const features = layersToQuery.length > 0
          ? map.current.queryRenderedFeatures(e.point, { layers: layersToQuery })
          : []
        if (features.length === 0) {
          const { lng: lon, lat } = e.lngLat
          const html = `
            <div style="font-size:12px;line-height:1.4;">
              <input type="text" id="newSafeName" placeholder="Navn på område" style="width:100%;padding:4px;margin-bottom:4px;border:1px solid #ddd;border-radius:4px;"/>
              <input type="number" id="newSafeCapacity" placeholder="Kapasitet" style="width:100%;padding:4px;margin-bottom:4px;border:1px solid #ddd;border-radius:4px;"/>
              <button id="createSafeAreaBtn" style="width:100%;padding:6px;background:#22c55e;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;">Lag trygt område</button>
            </div>
          `
          const popup = new maplibregl.Popup({ closeButton: true })
            .setLngLat([lon, lat])
            .setHTML(html)
            .addTo(map.current)
          
          const popupElement = popup.getElement()
          const btn = popupElement?.querySelector('#createSafeAreaBtn')
          const nameInput = popupElement?.querySelector('#newSafeName')
          const capacityInput = popupElement?.querySelector('#newSafeCapacity')
          if (btn && nameInput && capacityInput) {
            btn.addEventListener('click', async () => {
              const name = nameInput.value.trim()
              const capacity = parseInt(capacityInput.value) || 0
              if (!name) {
                alert('Vennligst skriv inn navn på område')
                return
              }
              try {
                await axios.post(`${API_BASE}/api/admin/safe-areas`, { name, lon, lat, capacity })
                popup.remove()
                const res = await axios.get(`${API_BASE}/api/layers/safe-areas`)
                safeAreasGeoJsonRef.current = res.data || { type: 'FeatureCollection', features: [] }
                if (map.current.getSource('safe-areas')) {
                  map.current.getSource('safe-areas').setData(res.data)
                }
                await refreshMarkerLiveCounts()
              } catch (error) {
                console.error('Error creating safe area:', error)
                alert('Feil ved opprettelse av område')
              }
            })
          }
        }
      })

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

  useEffect(() => {
    if (map.current?.isStyleLoaded() && logisticsLayersLoaded.current) {
      updateTruckMapSources(truckJobs)
    }
  }, [truckJobs, selectedTruckId])

  useEffect(() => {
    if (!map.current?.isStyleLoaded()) return

    const timer = setTimeout(() => {
      buildLogisticsPlan()
    }, 600)

    return () => clearTimeout(timer)
  }, [
    logisticsSettings.foodUnitsPerPerson,
    logisticsSettings.waterUnitsPerPerson,
    logisticsSettings.foodTruckCapacity,
    logisticsSettings.waterTruckCapacity,
    logisticsSettings.routeMode,
  ])

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
          <h3>Forsyningslogistikk</h3>
          <div className="logistics-grid">
            <div className="form-group">
              <label>Mat per person</label>
              <input
                type="number"
                min="1"
                step="1"
                value={logisticsSettings.foodUnitsPerPerson}
                onChange={(e) => setLogisticsSettings({ ...logisticsSettings, foodUnitsPerPerson: Number(e.target.value) || 1 })}
              />
            </div>
            <div className="form-group">
              <label>Vann per person</label>
              <input
                type="number"
                min="1"
                step="1"
                value={logisticsSettings.waterUnitsPerPerson}
                onChange={(e) => setLogisticsSettings({ ...logisticsSettings, waterUnitsPerPerson: Number(e.target.value) || 1 })}
              />
            </div>
            <div className="form-group">
              <label>Mattruck kapasitet</label>
              <input
                type="number"
                min="1"
                step="1"
                value={logisticsSettings.foodTruckCapacity}
                onChange={(e) => setLogisticsSettings({ ...logisticsSettings, foodTruckCapacity: Number(e.target.value) || 1 })}
              />
            </div>
            <div className="form-group">
              <label>Vanntank kapasitet</label>
              <input
                type="number"
                min="1"
                step="1"
                value={logisticsSettings.waterTruckCapacity}
                onChange={(e) => setLogisticsSettings({ ...logisticsSettings, waterTruckCapacity: Number(e.target.value) || 1 })}
              />
            </div>
          </div>

          <p className="location-info">{logisticsStatus}</p>
          {logisticsError && <p className="logistics-error">{logisticsError}</p>}

          <div className="button-group logistics-actions">
            <button className="btn btn-secondary" onClick={dispatchAllTrucks} disabled={truckJobs.length === 0}>
              Send alle
            </button>
            <button className="btn btn-secondary" onClick={clearLogisticsPlan} disabled={truckJobs.length === 0}>
              Tøm plan
            </button>
          </div>

          <p className="logistics-help">
            Planen beregnes automatisk og fordeler mat fra nærmeste gårder og vann fra nærmeste vannkilder basert på
            antall personer ved tilfluktsrom og trygge soner.
          </p>
        </div>

        {selectedTruckJob && (
          <div className="panel-section">
            <h3>Valgt rute</h3>
            <div className="truck-detail-card">
              {(() => {
                const isSelectedMoving = selectedTruckJob.status === 'moving'
                const isSelectedReturning = isSelectedMoving && selectedTruckJob.leg === 'return'
                const selectedDestinationLabel = isSelectedReturning
                  ? (selectedTruckJob.source?.name || '-')
                  : (selectedTruckJob.target?.name || '-')
                const selectedStatusLabel = selectedTruckJob.status === 'arrived'
                  ? 'Ankommet'
                  : isSelectedReturning
                    ? 'På vei tilbake'
                    : isSelectedMoving
                      ? 'På vei'
                      : 'Klar til sending'

                return (
                  <>
              <div className="truck-detail-title">
                {selectedTruckJob.resourceType === 'water' ? '💧 Water truck' : '🍞 Food truck'}
              </div>
              <div className="truck-detail-row">Fra: {selectedTruckJob.source?.name || '-'}</div>
              <div className="truck-detail-row">Til: {selectedDestinationLabel}</div>
              <div className="truck-detail-row">Mengde: {selectedTruckJob.amount} units</div>
              <div className="truck-detail-row">ETA: {selectedTruckJob.etaLabel || '—'}</div>
              <div className="truck-detail-row">
                Status: {selectedStatusLabel}
              </div>
              <div className="truck-progress">
                <div className="truck-progress-bar" style={{ width: `${Math.round((selectedTruckJob.progress || 0) * 100)}%` }} />
              </div>
              <div className="truck-detail-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => dispatchTruck(selectedTruckJob.id)}
                  disabled={selectedTruckJob.status === 'moving' || selectedTruckJob.status === 'arrived'}
                >
                  {selectedTruckJob.status === 'moving' ? 'På vei' : selectedTruckJob.status === 'arrived' ? 'Fullført' : 'Send denne trucken'}
                </button>
              </div>
                  </>
                )
              })()}
            </div>
          </div>
        )}

        {truckJobs.length > 0 && (
          <div className="panel-section">
            <h3>Truckruter</h3>
            <div className="truck-route-list">
              {truckJobs.map((job) => {
                const isSelected = job.id === selectedTruckId
                const isMoving = job.status === 'moving'
                const isArrived = job.status === 'arrived'
                const isReturning = isMoving && job.leg === 'return'
                const destinationLabel = isReturning ? (job.source?.name || '-') : (job.target?.name || '-')
                const statusLabel = isArrived ? 'Ankommet' : isReturning ? 'På vei tilbake' : isMoving ? 'På vei' : 'Klar'

                return (
                  <div
                    key={job.id}
                    className={`truck-route-card ${isSelected ? 'active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => focusTruckRoute(job)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        focusTruckRoute(job)
                      }
                    }}
                  >
                    <div className="truck-route-header">
                      <span>{job.resourceType === 'water' ? '💧 Water' : '🍞 Food'}</span>
                      <span>{job.etaLabel || '—'}</span>
                    </div>
                    <div className="truck-route-body">
                      <div>Fra: {job.source?.name || '-'}</div>
                      <div>Til: {destinationLabel}</div>
                      <div>Mengde: {job.amount} units</div>
                      <div>Status: {statusLabel}</div>
                    </div>
                    <div className="truck-progress small">
                      <div className="truck-progress-bar" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
                    </div>
                    <div className="truck-route-actions">
                      <span className="truck-route-distance">{job.distanceKm || '—'} km</span>
                      <button
                        className="btn btn-secondary"
                        onClick={(event) => {
                          event.stopPropagation()
                          dispatchTruck(job.id)
                        }}
                        disabled={isMoving || isArrived}
                      >
                        {isMoving ? 'Tracking' : isArrived ? 'Done' : 'Send'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

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
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.safe_areas}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, safe_areas: e.target.checked })}
            />
            Trygge områder
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.live_users}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, live_users: e.target.checked })}
            />
            Live brukere
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.logistics_food_routes}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, logistics_food_routes: e.target.checked })}
            />
            Mattruter
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.logistics_water_routes}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, logistics_water_routes: e.target.checked })}
            />
            Vannruter
          </label>
        </div>
      </div>

      <div className="map-container" ref={mapContainer} />
    </div>
  )
}

function SimulatePage({ onBack }) {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const liveUsersInterval = useRef(null)
  const markerLiveCountInterval = useRef(null)
  const simulatePopupBound = useRef(false)
  const sheltersGeoJsonRef = useRef({ type: 'FeatureCollection', features: [] })
  const safeAreasGeoJsonRef = useRef({ type: 'FeatureCollection', features: [] })
  const [mockUserIds, setMockUserIds] = useState(() => readStoredMockUserIds())
  const [statusMessage, setStatusMessage] = useState('Klikk på kartet for å spawn mock-brukere.')
  const [visibleLayers, setVisibleLayers] = useState({
    shelters: true,
    safe_areas: true,
    live_users: true,
    fire_stations: true,
    farms: true,
    water_sources: true,
    doctors: true,
    hospitals: true,
  })

  useEffect(() => {
    if (!mapContainer.current) return

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: OSM_RASTER_STYLE,
      center: [8.0000, 58.1467],
      zoom: 10,
    })

    map.current.on('load', () => initializeSimulationMap())

    return () => {
      if (liveUsersInterval.current) {
        clearInterval(liveUsersInterval.current)
        liveUsersInterval.current = null
      }
      if (markerLiveCountInterval.current) {
        clearInterval(markerLiveCountInterval.current)
        markerLiveCountInterval.current = null
      }
      map.current?.remove()
    }
  }, [])

  const clearMarkerLiveCountInterval = () => {
    if (markerLiveCountInterval.current) {
      clearInterval(markerLiveCountInterval.current)
      markerLiveCountInterval.current = null
    }
  }

  const bindLiveUserCountToPopup = ({ popup, endpoint, updateMs = 10000 }) => {
    const popupElement = popup.getElement()
    const countEl = popupElement?.querySelector('.live-users-count')
    if (!countEl) return

    clearMarkerLiveCountInterval()

    const refreshCount = async () => {
      try {
        const res = await axios.get(endpoint)
        const count = Number(res.data?.live_users_count || 0)
        countEl.textContent = String(count)
      } catch (error) {
        countEl.textContent = '0'
      }
    }

    refreshCount()
    markerLiveCountInterval.current = setInterval(refreshCount, updateMs)
    popup.on('close', clearMarkerLiveCountInterval)
  }

  const applyLiveCountsToSource = (sourceId, geojsonRef, counts = []) => {
    if (!map.current || !map.current.getSource(sourceId)) return
    const current = geojsonRef.current
    if (!current || !Array.isArray(current.features)) return

    const countMap = new Map(
      (counts || []).map((row) => [Number(row.id), Number(row.live_users_count || 0)])
    )

    const updated = {
      ...current,
      features: current.features.map((feature) => {
        const featureId = Number(feature?.properties?.id)
        const count = Number.isFinite(featureId) ? (countMap.get(featureId) || 0) : 0
        return {
          ...feature,
          properties: {
            ...(feature.properties || {}),
            live_users_count: count,
          },
        }
      }),
    }

    geojsonRef.current = updated
    map.current.getSource(sourceId).setData(updated)
  }

  const refreshMarkerLiveCounts = async () => {
    if (!map.current) return
    try {
      const [shelterRes, safeAreasRes] = await Promise.all([
        axios.get(`${API_BASE}/api/admin/shelters/live-users?radius=150`),
        axios.get(`${API_BASE}/api/admin/safe-areas/live-users?radius=150`),
      ])

      applyLiveCountsToSource('shelters', sheltersGeoJsonRef, shelterRes.data?.counts || [])
      applyLiveCountsToSource('safe-areas', safeAreasGeoJsonRef, safeAreasRes.data?.counts || [])
    } catch (error) {
      console.warn('Failed to refresh marker live counts:', error.message)
    }
  }

  const applySimulationLayerVisibility = () => {
    if (!map.current) return
    const setVisibility = (layerId, visible) => {
      if (map.current.getLayer(layerId)) {
        map.current.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
      }
    }

    setVisibility('shelters-layer', visibleLayers.shelters)
    setVisibility('shelters-live-count-layer', visibleLayers.shelters)
    setVisibility('safe-areas-layer', visibleLayers.safe_areas)
    setVisibility('safe-areas-live-count-layer', visibleLayers.safe_areas)
    setVisibility('live-users-layer', visibleLayers.live_users)
    setVisibility('fire_stations-layer', visibleLayers.fire_stations)
    setVisibility('farms-layer', visibleLayers.farms)
    setVisibility('water_sources-layer', visibleLayers.water_sources)
    setVisibility('doctors-layer', visibleLayers.doctors)
    setVisibility('hospitals-layer', visibleLayers.hospitals)
  }

  const loadShelters = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/layers/shelters`)
      const sheltersData = res.data?.features
        ? res.data
        : { type: 'FeatureCollection', features: [] }

      sheltersGeoJsonRef.current = sheltersData

      if (!map.current.getSource('shelters')) {
        map.current.addSource('shelters', { type: 'geojson', data: sheltersData })
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
              '#ef4444',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
          },
        })
        map.current.addLayer({
          id: 'shelters-live-count-layer',
          type: 'symbol',
          source: 'shelters',
          layout: {
            'text-field': ['to-string', ['coalesce', ['get', 'live_users_count'], 0]],
            'text-size': 11,
            'text-offset': [0, -1.6],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#111827',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.2,
          },
        })
      } else {
        map.current.getSource('shelters').setData(sheltersData)
      }
    } catch (error) {
      console.error('Error loading shelters for simulation:', error)
    }
  }

  const loadSafeAreas = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/layers/safe-areas`)
      const safeAreasData = res.data?.features
        ? res.data
        : { type: 'FeatureCollection', features: [] }

      safeAreasGeoJsonRef.current = safeAreasData

      if (!map.current.getSource('safe-areas')) {
        map.current.addSource('safe-areas', { type: 'geojson', data: safeAreasData })
        map.current.addLayer({
          id: 'safe-areas-layer',
          type: 'circle',
          source: 'safe-areas',
          paint: {
            'circle-radius': 6,
            'circle-color': '#8b5cf6',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
          },
        })
        map.current.addLayer({
          id: 'safe-areas-live-count-layer',
          type: 'symbol',
          source: 'safe-areas',
          layout: {
            'text-field': ['to-string', ['coalesce', ['get', 'live_users_count'], 0]],
            'text-size': 11,
            'text-offset': [0, -1.6],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#111827',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.2,
          },
        })
      } else {
        map.current.getSource('safe-areas').setData(safeAreasData)
      }
    } catch (error) {
      console.warn('Failed to load safe areas for simulation:', error.message)
      if (!map.current.getSource('safe-areas')) {
        const emptySafeAreas = { type: 'FeatureCollection', features: [] }
        safeAreasGeoJsonRef.current = emptySafeAreas
        map.current.addSource('safe-areas', { type: 'geojson', data: emptySafeAreas })
        map.current.addLayer({
          id: 'safe-areas-layer',
          type: 'circle',
          source: 'safe-areas',
          paint: {
            'circle-radius': 6,
            'circle-color': '#8b5cf6',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
          },
        })
        map.current.addLayer({
          id: 'safe-areas-live-count-layer',
          type: 'symbol',
          source: 'safe-areas',
          layout: {
            'text-field': ['to-string', ['coalesce', ['get', 'live_users_count'], 0]],
            'text-size': 11,
            'text-offset': [0, -1.6],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#111827',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.2,
          },
        })
      }
    }
  }

  const loadPointLayer = async ({ name, color }) => {
    try {
      const res = await axios.get(`${API_BASE}/api/layers/${name}`)
      if (!res.data?.features || res.data.features.length === 0) return

      if (!map.current.getSource(name)) {
        map.current.addSource(name, { type: 'geojson', data: res.data })
        map.current.addLayer({
          id: `${name}-layer`,
          type: 'circle',
          source: name,
          paint: {
            'circle-radius': 5,
            'circle-color': color,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
          },
        })
      } else {
        map.current.getSource(name).setData(res.data)
      }
    } catch (error) {
      console.warn(`Failed to load ${name} for simulation:`, error.message)
    }
  }

  const loadLiveUsers = async () => {
    if (!map.current) return
    try {
      const res = await axios.get(`${API_BASE}/api/admin/live-users`)
      const fc = res.data?.type === 'FeatureCollection'
        ? res.data
        : { type: 'FeatureCollection', features: [] }

      if (!map.current.getSource('live-users')) {
        map.current.addSource('live-users', { type: 'geojson', data: fc })
        map.current.addLayer({
          id: 'live-users-layer',
          type: 'circle',
          source: 'live-users',
          paint: {
            'circle-radius': 7,
            'circle-color': '#0ea5e9',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        })
      } else {
        map.current.getSource('live-users').setData(fc)
      }

      await refreshMarkerLiveCounts()
      applySimulationLayerVisibility()
    } catch (error) {
      console.warn('Failed to load live users for simulation:', error.message)
    }
  }

  const initializeSimulationMap = async () => {
    await loadShelters()
    await loadSafeAreas()

    const pointLayers = [
      { name: 'fire_stations', color: '#ff6b6b' },
      { name: 'farms', color: '#84cc16' },
      { name: 'water_sources', color: '#06b6d4' },
      { name: 'doctors', color: '#f97316' },
      { name: 'hospitals', color: '#d946ef' },
    ]

    for (const layerConfig of pointLayers) {
      await loadPointLayer(layerConfig)
    }

    await loadLiveUsers()

    if (!liveUsersInterval.current) {
      liveUsersInterval.current = setInterval(() => {
        loadLiveUsers()
      }, 10000)
    }

    if (!simulatePopupBound.current && map.current) {
      map.current.on('click', 'shelters-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const shelterId = Number(p.id)
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>${p.name || 'Tilfluktsrom'}</strong><br/>
            Kapasitet: ${p.capacity ?? 0}<br/>
            Aktive brukere innen 150m: <strong class="live-users-count">Laster...</strong>
          </div>
        `
        const popup = new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)

        if (Number.isFinite(shelterId)) {
          bindLiveUserCountToPopup({
            popup,
            endpoint: `${API_BASE}/api/admin/shelters/${shelterId}/live-users?radius=150`,
          })
        } else {
          const countEl = popup.getElement()?.querySelector('.live-users-count')
          if (countEl) countEl.textContent = '0'
        }
      })
      map.current.on('mouseenter', 'shelters-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'shelters-layer', () => { map.current.getCanvas().style.cursor = '' })

      map.current.on('click', 'safe-areas-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const safeAreaId = Number(p.id)
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>🛡️ Trygt område</strong><br/>
            <strong>${p.name || 'Trygt område'}</strong><br/>
            Kapasitet: ${p.capacity ?? 0}<br/>
            Aktive brukere innen 150m: <strong class="live-users-count">Laster...</strong>
          </div>
        `
        const popup = new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)

        if (Number.isFinite(safeAreaId)) {
          bindLiveUserCountToPopup({
            popup,
            endpoint: `${API_BASE}/api/admin/safe-areas/${safeAreaId}/live-users?radius=150`,
          })
        } else {
          const countEl = popup.getElement()?.querySelector('.live-users-count')
          if (countEl) countEl.textContent = '0'
        }
      })
      map.current.on('mouseenter', 'safe-areas-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'safe-areas-layer', () => { map.current.getCanvas().style.cursor = '' })

      pointLayers.forEach(({ name }) => {
        map.current.on('click', `${name}-layer`, (e) => {
          const f = e.features?.[0]
          if (!f) return
          const p = f.properties || {}
          const label = {
            fire_stations: '🚒 Brannstasjon',
            farms: '🌾 Gård',
            water_sources: '💧 Vannkilde',
            doctors: '👨‍⚕️ Lege',
            hospitals: '🏥 Sykehus',
          }[name] || name
          const html = `
            <div style="font-size:12px;line-height:1.4;">
              <strong>${label}</strong><br/>
              ${p.name ? `<strong>${p.name}</strong><br/>` : ''}
              ${p.website ? `<a href="${p.website}" target="_blank" rel="noreferrer">Besøk nettside</a><br/>` : ''}
              ${p.phone ? `Telefon: ${p.phone}<br/>` : ''}
            </div>
          `
          new maplibregl.Popup({ closeButton: true })
            .setLngLat(e.lngLat)
            .setHTML(html)
            .addTo(map.current)
        })
        map.current.on('mouseenter', `${name}-layer`, () => { map.current.getCanvas().style.cursor = 'pointer' })
        map.current.on('mouseleave', `${name}-layer`, () => { map.current.getCanvas().style.cursor = '' })
      })

      map.current.on('click', 'live-users-layer', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties || {}
        const html = `
          <div style="font-size:12px;line-height:1.4;">
            <strong>📍 Aktiv bruker</strong><br/>
            ID: ${p.user_id || '-'}<br/>
            Sist oppdatert: ${p.last_seen ? new Date(p.last_seen).toLocaleString() : '-'}
          </div>
        `
        new maplibregl.Popup({ closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map.current)
      })
      map.current.on('mouseenter', 'live-users-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
      map.current.on('mouseleave', 'live-users-layer', () => { map.current.getCanvas().style.cursor = '' })

      map.current.on('click', (e) => {
        const candidateLayers = [
          'shelters-layer',
          'safe-areas-layer',
          'fire_stations-layer',
          'farms-layer',
          'water_sources-layer',
          'doctors-layer',
          'hospitals-layer',
          'live-users-layer',
        ]
        const layersToQuery = candidateLayers.filter((layerId) => map.current.getLayer(layerId))
        const features = layersToQuery.length > 0
          ? map.current.queryRenderedFeatures(e.point, { layers: layersToQuery })
          : []

        if (features.length > 0) return

        const { lng: lon, lat } = e.lngLat
        const html = `
          <div class="simulate-popup">
            <strong>Spawn mock users</strong>
            <label for="mock-user-count">Antall brukere</label>
            <input id="mock-user-count" type="number" min="1" max="250" value="10" />
            <button id="spawn-mock-users-btn">Spawn users</button>
            <p>Klikk på kartet for å legge brukerne rundt dette punktet.</p>
          </div>
        `
        const popup = new maplibregl.Popup({ closeButton: true })
          .setLngLat([lon, lat])
          .setHTML(html)
          .addTo(map.current)

        const popupElement = popup.getElement()
        const countInput = popupElement?.querySelector('#mock-user-count')
        const spawnButton = popupElement?.querySelector('#spawn-mock-users-btn')

        const spawnUsers = async () => {
          const count = Math.min(250, Math.max(1, Number.parseInt(countInput?.value || '1', 10) || 1))
          popup.remove()
          await spawnMockUsers({ lon, lat, count })
        }

        if (spawnButton) {
          spawnButton.addEventListener('click', spawnUsers)
        }
        if (countInput) {
          countInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              spawnUsers()
            }
          })
          countInput.focus()
          countInput.select()
        }
      })

      simulatePopupBound.current = true
    }

    applySimulationLayerVisibility()
  }

  const spawnMockUsers = async ({ lon, lat, count }) => {
    const mockIds = Array.from({ length: count }, () => uuidv4())
    const positions = createMockUserPositions(lon, lat, count)

    setStatusMessage(`Spawning ${count} mock users...`)

    try {
      await Promise.all(
        mockIds.map((mockId, index) =>
          axios.post(`${API_BASE}/api/users/${mockId}/location`, {
            lon: positions[index].lon,
            lat: positions[index].lat,
          })
        )
      )

      setMockUserIds((currentIds) => {
        const nextIds = [...currentIds, ...mockIds]
        writeStoredMockUserIds(nextIds)
        return nextIds
      })

      setStatusMessage(`Spawned ${count} mock users at the clicked location.`)
      await loadLiveUsers()
    } catch (error) {
      console.error('Error spawning mock users:', error)
      setStatusMessage('Failed to spawn mock users.')
    }
  }

  const clearMockUsers = async () => {
    if (mockUserIds.length === 0) {
      setStatusMessage('No mock users to clear.')
      return
    }

    try {
      await axios.delete(`${API_BASE}/api/admin/mock-users`, {
        data: { userIds: mockUserIds },
      })

      setMockUserIds([])
      writeStoredMockUserIds([])
      setStatusMessage('Cleared all mock users.')
      await loadLiveUsers()
    } catch (error) {
      console.error('Error clearing mock users:', error)
      setStatusMessage('Failed to clear mock users.')
    }
  }

  useEffect(() => {
    if (map.current?.isStyleLoaded()) {
      applySimulationLayerVisibility()
    }
  }, [visibleLayers])

  return (
    <div className="simulate-container">
      <div className="simulate-panel">
        <div className="panel-header">
          <h2>Simuleringsvisning</h2>
          <button className="btn-close" onClick={onBack}>←</button>
        </div>

        <div className="panel-section">
          <h3>Mock-brukere</h3>
          <p className="location-info">{statusMessage}</p>
          <div className="simulate-stats">
            <div className="stat-card">
              <div className="stat-value">{mockUserIds.length}</div>
              <div className="stat-label">Mock brukere lagret</div>
            </div>
          </div>
          <div className="button-group" style={{ marginTop: '12px' }}>
            <button className="btn btn-secondary" onClick={clearMockUsers} disabled={mockUserIds.length === 0}>
              Tøm mock-brukere
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
              checked={visibleLayers.safe_areas}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, safe_areas: e.target.checked })}
            />
            Trygge områder
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.live_users}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, live_users: e.target.checked })}
            />
            Live brukere
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
            Gårder
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.water_sources}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, water_sources: e.target.checked })}
            />
            Vannkilder
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.doctors}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, doctors: e.target.checked })}
            />
            Leger
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={visibleLayers.hospitals}
              onChange={(e) => setVisibleLayers({ ...visibleLayers, hospitals: e.target.checked })}
            />
            Sykehus
          </label>
        </div>

        <div className="panel-section">
          <h3>Hvordan bruke</h3>
          <p className="simulate-help">
            Klikk et tomt punkt på kartet, velg antall brukere i popup-vinduet og spawn dem rundt klikket.
            Bruk <strong>Tøm mock-brukere</strong> når du vil starte på nytt.
          </p>
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
  const layerRefreshInterval = useRef(null)
  const routeModeRef = useRef('walk')
  const userLocationRef = useRef(null)
  const [userLocation, setUserLocation] = useState(null)
  const [following, setFollowing] = useState(false)
  const [routeMode, setRouteMode] = useState('walk')
  const [routeStrategy, setRouteStrategy] = useState('nearest')
  const [routes, setRoutes] = useState(null)
  const [activeRoute, setActiveRoute] = useState(null)
  const [tracking, setTracking] = useState(false)
  const [visibleLayers, setVisibleLayers] = useState({
    shelters: true,
    safe_areas: true,
    counties: false,
    municipalities: false,
    roads: true
  })

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
      (error) => {
        console.error('Geolocation error:', error)
        console.error('Error code:', error.code)
        // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
        if (error.code === 1) {
          console.warn('Geolocation permission denied')
        } else if (error.code === 3) {
          console.warn('Geolocation timeout - retrying with lower accuracy')
          // Retry with lower accuracy requirements
          navigator.geolocation.watchPosition(
            (position) => {
              const { latitude: lat, longitude: lon } = position.coords
              setUserLocation({ lat, lon })
            },
            (err) => console.error('Fallback geolocation also failed:', err),
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 5000 }
          )
        }
      },
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
    )
  }

  // Start tracking immediately on component mount
  useEffect(() => {
    startTracking()
  }, [])

  // Automatically enable follow mode once user location is obtained
  useEffect(() => {
    if (userLocation && map.current && !following) {
      setFollowing(true)
      map.current.flyTo({
        center: [userLocation.lon, userLocation.lat],
        zoom: 14
      })
    }
  }, [userLocation])

  useEffect(() => {
    routeModeRef.current = routeMode
  }, [routeMode])

  useEffect(() => {
    userLocationRef.current = userLocation
  }, [userLocation])

  useEffect(() => {
    if (!mapContainer.current) return

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: OSM_RASTER_STYLE,
      center: [8.2707, 58.1456],
      zoom: 11
    })

    map.current.on('load', () => {
      loadShelters()
      loadUserLayers()
      loadSafeAreas()

      // Backend startup can be delayed; keep retrying layer loads.
      if (!layerRefreshInterval.current) {
        layerRefreshInterval.current = setInterval(() => {
          loadShelters()
          loadUserLayers()
          loadSafeAreas()
        }, 15000)
      }
    })

    return () => {
      if (layerRefreshInterval.current) {
        clearInterval(layerRefreshInterval.current)
        layerRefreshInterval.current = null
      }
      map.current?.remove()
    }
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
                Status: ${(p.enough_capacity === true || p.enough_capacity === 'true') ? 'Nok plass' : 'Ikke nok plass'}<br/>
                <button class="route-to-marker-btn" style="margin-top:8px;padding:6px 8px;background:#0ea5e9;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;width:100%;">Få veibeskrivelse hit</button>
              </div>
            `
            const popup = new maplibregl.Popup({ closeButton: true })
              .setLngLat(e.lngLat)
              .setHTML(html)
              .addTo(map.current)

            const popupElement = popup.getElement()
            const routeBtn = popupElement?.querySelector('.route-to-marker-btn')
            if (routeBtn) {
              routeBtn.addEventListener('click', async () => {
                const coordinates = f.geometry?.coordinates || []
                const destLon = Number(coordinates[0])
                const destLat = Number(coordinates[1])
                if (Number.isFinite(destLon) && Number.isFinite(destLat)) {
                  await routeToSpecificMarker({
                    lon: destLon,
                    lat: destLat,
                    name: p.name || 'Tilfluktsrom'
                  })
                  popup.remove()
                }
              })
            }
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

  const loadSafeAreas = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/layers/safe-areas`)
      if (map.current && res.data.features && res.data.features.length > 0) {
        if (!map.current.getSource('safe-areas-user')) {
          map.current.addSource('safe-areas-user', { type: 'geojson', data: res.data })
          map.current.addLayer({
            id: 'safe-areas-user-layer',
            type: 'circle',
            source: 'safe-areas-user',
            paint: {
              'circle-radius': 8,
              'circle-color': '#8b5cf6',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fff'
            }
          })

          map.current.on('click', 'safe-areas-user-layer', (e) => {
            const f = e.features?.[0]
            if (!f) return
            const p = f.properties || {}
            const html = `
              <div style="font-size:12px;line-height:1.4;">
                <strong>🛡️ Trygt område</strong><br/>
                <strong>${p.name}</strong><br/>
                  Kapasitet: ${p.capacity ?? 0}<br/>
                  <button class="route-to-marker-btn" style="margin-top:8px;padding:6px 8px;background:#0ea5e9;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;width:100%;">Få veibeskrivelse hit</button>
              </div>
            `
              const popup = new maplibregl.Popup({ closeButton: true })
              .setLngLat(e.lngLat)
              .setHTML(html)
              .addTo(map.current)

              const popupElement = popup.getElement()
              const routeBtn = popupElement?.querySelector('.route-to-marker-btn')
              if (routeBtn) {
                routeBtn.addEventListener('click', async () => {
                  const coordinates = f.geometry?.coordinates || []
                  const destLon = Number(coordinates[0])
                  const destLat = Number(coordinates[1])
                  if (Number.isFinite(destLon) && Number.isFinite(destLat)) {
                    await routeToSpecificMarker({
                      lon: destLon,
                      lat: destLat,
                      name: p.name || 'Trygt område'
                    })
                    popup.remove()
                  }
                })
              }
          })
          map.current.on('mouseenter', 'safe-areas-user-layer', () => { map.current.getCanvas().style.cursor = 'pointer' })
          map.current.on('mouseleave', 'safe-areas-user-layer', () => { map.current.getCanvas().style.cursor = '' })
        } else {
          map.current.getSource('safe-areas-user').setData(res.data)
        }
      }
    } catch (error) {
      console.error('Error loading safe areas:', error)
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
    setVisibility('safe-areas-user-layer', visibleLayers.safe_areas)
    setVisibility('counties-user-line', visibleLayers.counties)
    setVisibility('municipalities-user-line', visibleLayers.municipalities)
    setVisibility('osm-base', visibleLayers.roads)

    if (map.current.getLayer('municipalities-user-line') && map.current.getLayer('counties-user-line')) {
      map.current.moveLayer('municipalities-user-line', 'counties-user-line')
    }
  }, [visibleLayers])

  const routeToSpecificMarker = async ({ lon, lat, name }) => {
    const origin = userLocationRef.current
    if (!origin) {
      alert('Venligst tillat geolokalisering først')
      return
    }

    try {
      const routeRes = await axios.get(`${API_BASE}/api/routing/route`, {
        params: {
          originLon: origin.lon,
          originLat: origin.lat,
          destLon: lon,
          destLat: lat,
          mode: routeModeRef.current
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
        shelter: { name },
        distanceKm: (Number(routeRes.data.distance_m || 0) / 1000).toFixed(2),
        durationMin: Math.max(1, Math.round(Number(routeRes.data.duration_s || 0) / 60)),
        source: routeRes.data.source,
        steps: routeRes.data.steps || []
      })
    } catch (error) {
      console.error('Routing error:', error)
    }
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
            <input type="checkbox" checked={visibleLayers.safe_areas} onChange={(e) => setVisibleLayers({ ...visibleLayers, safe_areas: e.target.checked })} />
            Trygge områder
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
                  <button
                    className="btn btn-secondary"
                    style={{ marginTop: '8px', width: '100%' }}
                    onClick={async () => {
                      await routeToSpecificMarker({
                        lon: Number(route.lon),
                        lat: Number(route.lat),
                        name: route.name || 'Tilfluktsrom'
                      })
                    }}
                  >
                    Få veibeskrivelse hit
                  </button>
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
