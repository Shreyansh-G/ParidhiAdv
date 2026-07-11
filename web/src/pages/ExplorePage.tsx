import { useCallback, useEffect, useMemo, useState, useRef, lazy, Suspense } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion, type PanInfo, AnimatePresence } from 'framer-motion'
import { MapContainer, Marker, Popup, TileLayer, Polyline, Rectangle, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import Supercluster from 'supercluster'
import 'leaflet/dist/leaflet.css'
import { requestPushToken } from '../lib/firebase'
import { enhancedProjects, getProjectById, calculateDistance } from '../data/projectsEnhanced'
import { categoryEmoji } from '../data/projects'
import { usePermissions } from '../context/PermissionsContext'
import { useExploration } from '../context/ExplorationContext'
import { useAuth } from '../context/AuthContext'
import { useModal } from '../context/ModalContext'
import type { EnhancedProject } from '../data/projectsEnhanced'
import { MapPin, CheckCircle, Bell, MapPinIcon, Users, Lightbulb, Plus, X, Camera, ChevronUp, Radar, Footprints, Grid3X3, Box, Sparkles, HelpCircle } from 'lucide-react'
import { enhanceProjectDescription, getProjectInsight, type ProjectInsight } from '../lib/llm'
import { fetchProjectsNear, mergeUniqueProjects } from '../lib/liveProjectsService'
import { planCivicWalk, type WalkPlan } from '../lib/routePlanner'
import { LocationFilter } from '../lib/locationFilter'
import { buildSpatialIndex } from '../lib/spatialIndex'
import {
  computeGapsAround,
  delhiDemandPoints,
  getProjectImpact,
  isInDelhi,
  type GapCell,
} from '../lib/civicImpact'
import { fetchPopulationPoints } from '../lib/populationService'
import { similarProjects, type SemanticHit } from '../lib/semanticSearch'
import { deepScan, type DiscoveredProject } from '../lib/deepScan'

// three.js stays out of the main bundle — loaded only when someone opens 3D
const Project3DViewer = lazy(() => import('../components/Project3DViewer'))
import type { User } from 'firebase/auth'
import { createCommunityPost } from '../lib/community/community'
import { compressImage } from '../lib/imageCompression'

const GEOFENCE_RADIUS_KM = 0.5
const LOCATION_CHECK_INTERVAL = 5000

function markerIconForProject(project: EnhancedProject, isExplored: boolean) {
  const bgColor = isExplored ? '#10b981' : '#f97316'
  const emoji = categoryEmoji[project.category as keyof typeof categoryEmoji] ?? '📍'
  return L.divIcon({
    className: 'emoji-marker',
    html: `<div style="background-color: ${bgColor}; color: white; display: flex; align-items: center; justify-content: center; border-radius: 50%; width: 40px; height: 40px; font-size: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); border: 2px solid white;">${emoji}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  })
}

function clusterIcon(count: number) {
  const size = count >= 50 ? 52 : count >= 15 ? 46 : 40
  return L.divIcon({
    className: 'cluster-marker',
    html: `<div style="background: linear-gradient(135deg, #f97316, #ea580c); color: white; display: flex; align-items: center; justify-content: center; border-radius: 50%; width: ${size}px; height: ${size}px; font-size: 14px; font-weight: 800; box-shadow: 0 2px 10px rgba(234,88,12,0.5); border: 3px solid white;">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// Plain-language explanations for the map tools — shown as a one-time intro
// card on first tap, and any time from the ? help button.
const TOOL_INFO = {
  gaps: {
    emoji: '🟥',
    title: 'Needs Map',
    desc: 'Colors the map red where LOTS of people live but FEW facilities (hospitals, schools, transport…) exist nearby. Darker red = more people underserved. Great for spotting where your area should build next. Works anywhere — it reads census data in Delhi and settlement populations from OpenStreetMap elsewhere.',
    hint: 'Tip: select a project first and it maps the needs for THAT category. Run Scan 🛰️ first for a sharper picture.',
  },
  walk: {
    emoji: '👣',
    title: 'Civic Walk',
    desc: 'Plans a short walking tour through unexplored projects near you — numbered stops, distance, time, and the XP you would earn. Walk the route and each stop gets explored automatically.',
    hint: 'Tip: tap it again to clear, and once more for a brand-new route.',
  },
  scan: {
    emoji: '🛰️',
    title: 'Live Scan',
    desc: 'Searches OpenStreetMap — live, real data — for hospitals, schools, stations and under-construction sites in the area your map is showing, and adds them as new markers. Works anywhere: pan the map to any city and scan.',
    hint: 'Tip: it takes a few seconds — watch the radar spin.',
  },
  deep: {
    emoji: '🔎',
    title: 'Deep Scan (AI)',
    desc: 'The smart version of Scan: an AI pipeline that reads OpenStreetMap AND local news about your area, works out which projects are real, finds their exact location on the map, and adds them. News-found projects show a 📰 badge — tap through to read the article.',
    hint: 'Takes ~20 seconds the first time. Nearby areas you already scanned come back instantly.',
  },
  locate: {
    emoji: '📍',
    title: 'Find Me',
    desc: 'Centers the map back on your current GPS position.',
    hint: '',
  },
} as const

type ToolKey = keyof typeof TOOL_INFO

function walkStopIcon(order: number) {
  return L.divIcon({
    className: 'walk-stop-marker',
    html: `<div style="background-color: #451a03; color: white; display: flex; align-items: center; justify-content: center; border-radius: 50%; width: 30px; height: 30px; font-size: 13px; font-weight: 800; box-shadow: 0 2px 8px rgba(0,0,0,0.4); border: 2px solid #fdba74;">${order}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  })
}

// Marker clustering via supercluster (KD-tree hierarchical greedy clustering).
// Re-clusters on every pan/zoom; clicking a cluster zooms to its expansion level.
function ClusteredMarkers({
  projects,
  isExplored,
  onSelect,
}: {
  projects: EnhancedProject[]
  isExplored: (id: string) => boolean
  onSelect: (id: string) => void
}) {
  const map = useMap()
  const [view, setView] = useState(() => ({ zoom: map.getZoom(), bounds: map.getBounds() }))
  useMapEvents({
    moveend: () => setView({ zoom: map.getZoom(), bounds: map.getBounds() }),
    zoomend: () => setView({ zoom: map.getZoom(), bounds: map.getBounds() }),
  })

  const index = useMemo(() => {
    const sc = new Supercluster<{ project: EnhancedProject }, { cluster: boolean }>({
      radius: 64,
      maxZoom: 16,
    })
    sc.load(
      projects.map((project) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [project.lng, project.lat] },
        properties: { project },
      })),
    )
    return sc
  }, [projects])

  const clusters = useMemo(() => {
    const b = view.bounds
    return index.getClusters(
      [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      Math.round(view.zoom),
    )
  }, [index, view])

  return (
    <>
      {clusters.map((feature) => {
        const [lng, lat] = feature.geometry.coordinates
        const props = feature.properties as { cluster?: boolean; point_count?: number; project?: EnhancedProject }

        if (props.cluster) {
          const clusterId = feature.id as number
          return (
            <Marker
              key={`cluster-${clusterId}`}
              position={[lat, lng]}
              icon={clusterIcon(props.point_count ?? 0)}
              eventHandlers={{
                click: () =>
                  map.flyTo([lat, lng], Math.min(index.getClusterExpansionZoom(clusterId), 17), {
                    animate: true,
                  }),
              }}
            />
          )
        }

        const project = props.project!
        return (
          <Marker
            key={project.id}
            position={[project.lat, project.lng]}
            icon={markerIconForProject(project, isExplored(project.id))}
            eventHandlers={{ click: () => onSelect(project.id) }}
          >
            <Popup>
              <div className="space-y-2 text-sm max-w-xs">
                <p className="font-bold">{project.name}</p>
                <p className="text-xs text-gray-600">{project.location}</p>
                <p className="text-xs capitalize font-semibold text-orange-600">{project.status}</p>
              </div>
            </Popup>
          </Marker>
        )
      })}
    </>
  )
}

export function ExplorePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { isCreatePostOpen, openCreatePost, closeCreatePost, isARModalOpen, openARModal, closeARModal } = useModal()
  const locationState = location.state as { projectId?: string } | null
  const selectedProjectId = locationState?.projectId
  const isFromSearchNav = !!selectedProjectId // Track if came from search vs map tap

  const {
    locationAllowed,
    notificationsAllowed,
    allExplorePermissionsGranted,
    setLocationAllowed,
    setNotificationsAllowed,
  } = usePermissions()
  const { isExplored, markExplored } = useExploration()

  const [statusMessage, setStatusMessage] = useState('')
  const [userPosition, setUserPosition] = useState<[number, number]>([
    Number(import.meta.env.VITE_DEFAULT_LAT || 28.6139),
    Number(import.meta.env.VITE_DEFAULT_LNG || 77.209),
  ])
  // `userPosition` starts at the default coords, so it can't tell us whether a
  // real fix has landed yet. This can.
  const [hasGpsFix, setHasGpsFix] = useState(false)
  const [watchId, setWatchId] = useState<number | null>(null)
  const [showPermissions, setShowPermissions] = useState(!allExplorePermissionsGranted)
  const [enhancedContent, setEnhancedContent] = useState<string>('')
  const [showDescription, setShowDescription] = useState(true)
  const [mapCenter, setMapCenter] = useState<[number, number]>([
    Number(import.meta.env.VITE_DEFAULT_LAT || 28.6139),
    Number(import.meta.env.VITE_DEFAULT_LNG || 77.209),
  ])
  const mapRef = useRef<L.Map | null>(null)
  const firstLoadRef = useRef(true)

  // Live nearby projects (browser → Overpass API, free) merged with the bundled dataset
  const [liveNearby, setLiveNearby] = useState<EnhancedProject[]>([])
  const [scanning, setScanning] = useState(false)
  const [deepScanning, setDeepScanning] = useState(false)
  const lastAutoScanRef = useRef<string | null>(null)

  // Projects the LangGraph Deep Scan found in local news (id → article URL)
  const [newsSources, setNewsSources] = useState<Record<string, string>>({})

  const allProjects = useMemo(
    () => mergeUniqueProjects(enhancedProjects, liveNearby),
    [liveNearby],
  )

  // Grid index over everything on the map — geofence checks touch only the
  // user's 3×3 cell neighborhood instead of scanning the whole dataset.
  const spatialIndex = useMemo(() => buildSpatialIndex(allProjects), [allProjects])

  // GPS conditioning (accuracy gate + EMA smoothing + vehicle detection)
  const locationFilterRef = useRef(new LocationFilter())
  const [isVehicle, setIsVehicle] = useState(false)

  // Civic-walk route (TSP: nearest-neighbor + 2-opt) & civic-gaps overlay
  const [walkPlan, setWalkPlan] = useState<WalkPlan | null>(null)
  const [gapCells, setGapCells] = useState<GapCell[] | null>(null)
  const [gapsLoading, setGapsLoading] = useState(false)

  // First-time tool intros: the first tap on a map tool shows a plain-language
  // card explaining it before running; the ? button reopens the full guide.
  const [toolIntro, setToolIntro] = useState<{ tool: ToolKey; run: () => void } | null>(null)
  const [showToolGuide, setShowToolGuide] = useState(false)

  const withIntro = (tool: ToolKey, run: () => void) => () => {
    try {
      if (!localStorage.getItem(`paridhi-tool-intro-${tool}`)) {
        setToolIntro({ tool, run })
        return
      }
    } catch {
      // storage unavailable — just run
    }
    run()
  }

  const dismissIntro = (runAction: boolean) => {
    if (!toolIntro) return
    try {
      localStorage.setItem(`paridhi-tool-intro-${toolIntro.tool}`, '1')
    } catch {
      // ignore storage errors
    }
    const { run } = toolIntro
    setToolIntro(null)
    if (runAction) run()
  }

  // Resolve the selected project from the merged list so live-scanned
  // markers open their detail card too (falls back to the bundled lookup).
  const selectedProject = selectedProjectId
    ? (allProjects.find((p) => p.id === selectedProjectId) ?? getProjectById(selectedProjectId) ?? null)
    : null

  // Detail-card extras: 3D viewer, vector-DB neighbors, gravity-model impact
  const [show3D, setShow3D] = useState(false)
  const [similar, setSimilar] = useState<SemanticHit[]>([])
  const [similarLoading, setSimilarLoading] = useState(false)
  const [selectedInsight, setSelectedInsight] = useState<ProjectInsight | null>(null)
  const selectedImpact = selectedProject ? getProjectImpact(selectedProject.id) : null

  // Related projects via the vector DB — silent no-op until backend deploys
  useEffect(() => {
    setSimilar([])
    setShow3D(false)
    if (!selectedProjectId) return
    let alive = true
    setSimilarLoading(true)
    similarProjects(selectedProjectId)
      .then((hits) => {
        if (alive && hits) setSimilar(hits.slice(0, 3))
      })
      .finally(() => {
        if (alive) setSimilarLoading(false)
      })
    return () => {
      alive = false
    }
  }, [selectedProjectId])

  // Auto-scan around the user's real location once per ~1 km grid cell
  useEffect(() => {
    if (!locationAllowed) return
    const cell = `${userPosition[0].toFixed(2)},${userPosition[1].toFixed(2)}`
    if (lastAutoScanRef.current === cell) return
    lastAutoScanRef.current = cell

    fetchProjectsNear(userPosition[0], userPosition[1]).then((found) => {
      if (found.length > 0) {
        setLiveNearby((current) => mergeUniqueProjects(current, found))
      }
    })
  }, [locationAllowed, userPosition])

  // "Plan my walk" — TSP route through nearby unexplored projects
  const handlePlanWalk = () => {
    if (walkPlan) {
      setWalkPlan(null)
      setStatusMessage('Walk route cleared')
      return
    }
    const plan = planCivicWalk(
      { lat: userPosition[0], lng: userPosition[1] },
      allProjects,
      isExplored,
    )
    if (!plan) {
      setStatusMessage('🚶 No unexplored projects within 3 km of your position — try Scan 🛰️')
      return
    }
    setWalkPlan(plan)
    const pts: [number, number][] = [userPosition, ...plan.stops.map((s) => [s.lat, s.lng] as [number, number])]
    mapRef.current?.fitBounds?.(pts, { padding: [40, 40] })
    setStatusMessage(
      `🚶 Walking route: ${plan.stops.length} stops · ${plan.totalKm.toFixed(1)} km · ~${plan.etaMinutes} min · earns +${plan.potentialXP} XP. Tap again to clear & replan a new route.`,
    )
  }

  // "Civic gaps" — underserved-area overlay (gravity demand ÷ facility supply).
  // Works anywhere: inside Delhi it uses census districts, elsewhere it reads
  // settlement populations from OpenStreetMap.
  const handleToggleGaps = async () => {
    if (gapCells) {
      setGapCells(null)
      setStatusMessage('Needs overlay off')
      return
    }
    if (gapsLoading) return

    const center = mapRef.current?.getCenter?.()
    const lat = center?.lat ?? mapCenter[0]
    const lng = center?.lng ?? mapCenter[1]
    const category = selectedProject?.category ?? 'Hospitals'

    setGapsLoading(true)
    setStatusMessage('🟥 Working out who is underserved here…')
    try {
      const inDelhi = isInDelhi(lat, lng)
      const demandPoints = inDelhi
        ? delhiDemandPoints()
        : (await fetchPopulationPoints(lat, lng)).map((p) => ({
            population: p.population,
            lat: p.lat,
            lng: p.lng,
          }))

      if (demandPoints.length === 0) {
        setStatusMessage(
          '🟥 No population data mapped around here yet, so needs cannot be calculated. Try a more built-up area.',
        )
        return
      }

      // Facilities = everything we know HERE (bundled + already scanned).
      // "Supply" is meaningless if we know none, so fetch them first — the
      // needs map must compare real demand against real facilities.
      const near = (p: EnhancedProject) => calculateDistance(lat, lng, p.lat, p.lng) <= 30
      let facilities = allProjects.filter((p) => p.category === category && near(p))

      if (facilities.length === 0) {
        setStatusMessage(`🟥 Finding the ${category.toLowerCase()} around here first…`)
        const found = await fetchProjectsNear(lat, lng, 10)
        if (found.length > 0) {
          setLiveNearby((current) => mergeUniqueProjects(current, found))
          facilities = found.filter((p) => p.category === category && near(p))
        }
      }

      setStatusMessage('🟥 Working out who is underserved here…')
      const cells = computeGapsAround({ lat, lng }, demandPoints, facilities)

      if (cells.length === 0) {
        setStatusMessage('🟥 Not enough data around here to find gaps — try Scan 🛰️ first.')
        return
      }

      setGapCells(cells)

      // Frame the analysed area AROUND the map centre, so the user always sees
      // their own surroundings — not just the single worst blob in a far corner.
      const worst = cells.slice(0, 10)
      const lats = [lat, ...worst.flatMap((c) => [c.latMin, c.latMax])]
      const lngs = [lng, ...worst.flatMap((c) => [c.lngMin, c.lngMax])]
      mapRef.current?.fitBounds?.(
        [
          [Math.min(...lats), Math.min(...lngs)],
          [Math.max(...lats), Math.max(...lngs)],
        ],
        { padding: [30, 30] },
      )

      const facilityWord = category.toLowerCase()
      setStatusMessage(
        facilities.length === 0
          ? `🟥 No ${facilityWord} known around here at all — every populated area is red. Run Scan 🛰️ to find the real ones.`
          : `🟥 Red = many residents, few ${facilityWord} nearby. Amber = better served. Based on ${facilities.length} known ${facilityWord} and ${demandPoints.length} settlements${
              inDelhi ? '' : ' (from OpenStreetMap)'
            }.`,
      )
    } finally {
      setGapsLoading(false)
    }
  }

  // Manual "scan this area" — fetch live projects around whatever the map shows
  const handleScanArea = async () => {
    if (scanning) return
    setScanning(true)
    setStatusMessage('🛰️ Scanning this area for live projects…')
    try {
      const center = mapRef.current?.getCenter?.()
      const lat = center?.lat ?? mapCenter[0]
      const lng = center?.lng ?? mapCenter[1]
      const found = await fetchProjectsNear(lat, lng)
      setLiveNearby((current) => mergeUniqueProjects(current, found))
      setStatusMessage(
        found.length > 0
          ? `🛰️ Found ${found.length} real projects here from OpenStreetMap — new markers added to the map`
          : '🛰️ No extra projects found in this area — pan the map elsewhere and scan again',
      )
    } finally {
      setScanning(false)
    }
  }

  // "Deep scan" — LangGraph agent: OSM + local news → extract → geocode → map
  const handleDeepScan = async () => {
    if (deepScanning) return
    if (!user) {
      setStatusMessage('🔎 Sign in to use Deep Scan (it runs the AI pipeline).')
      return
    }
    setDeepScanning(true)
    setStatusMessage('🔎 Deep scan: reading OpenStreetMap + local news…')
    try {
      const center = mapRef.current?.getCenter?.()
      const lat = center?.lat ?? mapCenter[0]
      const lng = center?.lng ?? mapCenter[1]
      const result = await deepScan(lat, lng)

      if (!result) {
        setStatusMessage('🔎 Deep scan is unavailable right now — plain Scan 🛰️ still works.')
        return
      }

      setLiveNearby((current) => mergeUniqueProjects(current, result.projects))
      setNewsSources((current) => {
        const next = { ...current }
        for (const p of result.projects as DiscoveredProject[]) {
          if (p.source === 'news' && p.sourceUrl) next[p.id] = p.sourceUrl
        }
        return next
      })

      const where = result.locality ? ` in ${result.locality}` : ''
      const fromCache = result.cached ? ' (from a recent scan nearby)' : ''
      setStatusMessage(
        result.projects.length > 0
          ? `🔎 Deep scan${where}: ${result.sources.osm} from maps + ${result.sources.news} from news 📰${fromCache}`
          : `🔎 Deep scan${where}: nothing new found here yet`,
      )
    } finally {
      setDeepScanning(false)
    }
  }

  // Any long-running map job — drives the toast spinner and the busy overlay
  const busy = scanning || deepScanning || gapsLoading

  // Buttons report through statusMessage — show it as a toast, then fade it
  // once the work behind it has actually finished.
  useEffect(() => {
    if (!statusMessage || busy) return
    const timer = setTimeout(() => setStatusMessage(''), 6000)
    return () => clearTimeout(timer)
  }, [statusMessage, busy])

  // Auto-hide permission section when both enabled
  useEffect(() => {
    if (locationAllowed && notificationsAllowed) {
      setShowPermissions(false)
    }
  }, [locationAllowed, notificationsAllowed])

  // Show description when new project is selected
  useEffect(() => {
    if (selectedProjectId) {
      setShowDescription(true)
    }
  }, [selectedProjectId])

  // Auto-hide description card and button when AR or Post modals open (like navbar behavior)
  useEffect(() => {
    if (isARModalOpen || isCreatePostOpen) {
      setShowDescription(false)
    }
  }, [isARModalOpen, isCreatePostOpen])

  // Auto-mark projects in geofence
  useEffect(() => {
    if (!locationAllowed || !selectedProject) return

    if (isVehicle) return // anti-cheat: no drive-by exploration

    spatialIndex.queryNearby(userPosition[0], userPosition[1], GEOFENCE_RADIUS_KM).forEach((project) => {
      if (!isExplored(project.id)) {
        markExplored(project.id)
        setStatusMessage(`🎉 Explored: ${project.name}`)
      }
    })
  }, [userPosition, locationAllowed, markExplored, isExplored, selectedProject, spatialIndex, isVehicle])

  // Enhance selected project content — real Claude insight first, heuristic fallback
  useEffect(() => {
    if (!selectedProject) return
    let alive = true

    const enhance = async () => {
      const insight = await getProjectInsight(selectedProject.id)
      if (!alive) return
      if (insight) {
        setEnhancedContent(insight.enhancedDescription)
        setSelectedInsight(insight)
        return
      }
      setSelectedInsight(null)
      const enhanced = await enhanceProjectDescription(selectedProject.description)
      if (alive) setEnhancedContent(enhanced)
    }
    enhance()

    return () => {
      alive = false
    }
  }, [selectedProject])

  const autoEnabledRef = useRef(false)

  // Defined here, above the effect that depends on it: the effect's dependency
  // array is evaluated during render, so a `const` declared further down would
  // be in the temporal dead zone and throw.
  const enableLocation = useCallback(async () => {
    if (!navigator.geolocation) {
      setStatusMessage('Geolocation not supported')
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocationAllowed(true)
        setUserPosition([position.coords.latitude, position.coords.longitude])
        setHasGpsFix(true)
        setStatusMessage('Location enabled ✓')

        const id = navigator.geolocation.watchPosition(
          (pos) => {
            // Condition the raw fix: accuracy gate + EMA smoothing + speed estimate
            const fix = locationFilterRef.current.update(pos)
            if (!fix.accepted) return
            setIsVehicle(fix.isVehicleSpeed)
            setUserPosition([fix.lat, fix.lng])
            setHasGpsFix(true)
          },
          (error) => setStatusMessage(`Location error: ${error.message}`),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: LOCATION_CHECK_INTERVAL }
        )
        setWatchId(id)
      },
      (error) => setStatusMessage(`Location denied: ${error.message}`),
      { enableHighAccuracy: true }
    )
  }, [setLocationAllowed])

  // Auto-enable location tracking when page loads if location permission already granted
  useEffect(() => {
    if (!autoEnabledRef.current && locationAllowed) {
      autoEnabledRef.current = true
      enableLocation()
    }
  }, [locationAllowed, enableLocation])

  // Center the map on the user, once, on first load.
  //
  // This must wait for `hasGpsFix`, not just `locationAllowed`. On a reload with
  // the permission already remembered, `locationAllowed` is true on the very
  // first render while `userPosition` is still the default Delhi coordinates —
  // so centering on it immediately would park the map on the default location,
  // spend the one-shot `firstLoadRef`, and never recenter once the real fix
  // arrived. (On a fresh grant the two updates batch, which is why this only
  // ever misbehaved after a refresh.)
  useEffect(() => {
    if (firstLoadRef.current && locationAllowed && hasGpsFix) {
      firstLoadRef.current = false
      setMapCenter(userPosition)
    }
  }, [locationAllowed, hasGpsFix, userPosition])

  const handleCreatePost = () => {
    if (!user) {
      navigate('/profile')
    } else {
      openCreatePost()
    }
  }

  const closeCard = () => {
    setShowDescription(false)
  }

  const handleARCamera = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' }
      })
      openARModal()
      // Stream will be shown in ARCameraModal
    } catch (error) {
      console.error('❌ Camera access denied:', error)
      setStatusMessage('Camera permission denied')
    }
  }

  function disableLocation() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId)
      setWatchId(null)
    }
    setLocationAllowed(false)
    setStatusMessage('Location disabled')
  }

  function handleLocateMe() {
    if (userPosition && mapRef.current) {
      setMapCenter(userPosition)
      mapRef.current.setView(userPosition, 16, { animate: true })
    }
  }

  async function enableNotifications() {
    if (!('Notification' in window)) {
      setStatusMessage('Notifications not supported')
      return
    }

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      setStatusMessage('Notification permission denied')
      return
    }

    try {
      await requestPushToken().catch(() => null)
      setNotificationsAllowed(true)
      setStatusMessage('Notifications enabled ✓')
    } catch {
      setStatusMessage('Unable to enable notifications')
    }
  }

  // Cleanup
  useEffect(() => {
    return () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId)
      }
    }
  }, [watchId])

  return (
    <section className="relative w-full h-screen bg-stone-50 overflow-hidden">
      {/* HEADER */}
      <header className="absolute top-0 left-0 right-0 z-10 bg-white/80 backdrop-blur-md border-b border-stone-100 px-6 py-4">
        <h1 className="text-xl font-black text-[#451a03] uppercase tracking-tighter">
          Explore
        </h1>
      </header>

      {/* FULL SCREEN MAP - Curved boundaries, 75% height */}
      <div className="absolute top-16 left-4 right-4 z-0 rounded-3xl overflow-hidden shadow-lg" style={{ height: '75vh' }}>
        <MapContainer
          center={mapCenter}
          zoom={selectedProject ? 14 : 13}
          className="w-full h-full"
          zoomControl={true}
          ref={mapRef}
        >
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* User Position - Always visible with pulsing effect */}
          <Marker
            position={userPosition}
            icon={L.divIcon({
              className: 'user-marker',
              html: `<div style="
                background-color: #3b82f6;
                border: 3px solid white;
                box-shadow: 0 0 0 8px rgba(59, 130, 246, 0.2), 0 4px 12px rgba(0,0,0,0.25);
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                width: 40px;
                height: 40px;
                color: white;
                font-size: 18px;
                animation: pulse 2s infinite;
              ">
                📍
              </div>
              <style>
                @keyframes pulse {
                  0%, 100% { transform: scale(1); }
                  50% { transform: scale(1.1); }
                }
              </style>`,
              iconSize: [40, 40],
              iconAnchor: [20, 20],
              popupAnchor: [0, -20],
            })}
          >
            <Popup className="font-bold">📍 Your Current Location</Popup>
          </Marker>

          {/* Project Markers — clustered (supercluster), dataset + live scans */}
          <ClusteredMarkers
            projects={allProjects}
            isExplored={isExplored}
            onSelect={(id) => navigate('/explore', { state: { projectId: id } })}
          />

          {/* Civic-walk route (TSP: nearest-neighbor + 2-opt) */}
          {walkPlan && (
            <>
              <Polyline
                positions={[userPosition, ...walkPlan.stops.map((s) => [s.lat, s.lng] as [number, number])]}
                pathOptions={{ color: '#ea580c', weight: 4, dashArray: '10 8', opacity: 0.85 }}
              />
              {walkPlan.stops.map((stop, i) => (
                <Marker key={`walk-${stop.id}`} position={[stop.lat, stop.lng]} icon={walkStopIcon(i + 1)}>
                  <Popup>
                    <p className="text-xs font-bold">
                      Stop {i + 1}: {stop.name}
                    </p>
                  </Popup>
                </Marker>
              ))}
            </>
          )}

          {/* Civic-gaps heatmap — every inhabited cell in view, shaded by need.
              gapScore is already normalized 0 (best served) → 1 (worst), so the
              colour ramp reads the same in a dense city and a sparse district. */}
          {gapCells?.map((cell, i) => {
            const t = Math.max(0, Math.min(1, cell.gapScore))
            // Well served is a STATEMENT, not an absence: green → amber → red.
            // (A near-transparent "best served" cell made the overlay look
            // broken when zoomed into the user's own well-covered area.)
            const color = t < 0.34 ? '#10b981' : t < 0.67 ? '#f59e0b' : '#dc2626'
            const label = t < 0.34 ? 'Well served' : t < 0.67 ? 'Moderate need' : 'Underserved'
            return (
              <Rectangle
                key={`gap-${i}`}
                bounds={[
                  [cell.latMin, cell.lngMin],
                  [cell.latMax, cell.lngMax],
                ]}
                pathOptions={{
                  color,
                  weight: 1,
                  opacity: 0.35, // cell borders keep the grid legible when zoomed in
                  fillColor: color,
                  fillOpacity: 0.18 + t * 0.37,
                }}
              >
                <Popup>
                  <p className="text-xs font-bold">
                    {label}
                    <span className="block font-normal text-stone-500">
                      Need score {Math.round(t * 100)}/100 for{' '}
                      {(selectedProject?.category ?? 'Hospitals').toLowerCase()}
                    </span>
                  </p>
                </Popup>
              </Rectangle>
            )
          })}
        </MapContainer>

        {/* Deep Scan — LangGraph agent (OSM + local news → geocode → map) */}
        <button
          onClick={withIntro('deep', handleDeepScan)}
          disabled={deepScanning}
          className="absolute bottom-[17rem] right-4 w-14 rounded-xl px-1 py-2 shadow-lg active:scale-95 transition-all z-[999] border flex flex-col items-center gap-0.5 bg-gradient-to-br from-orange-500 to-orange-600 border-orange-600 text-white disabled:opacity-70"
          title="Deep scan: AI reads maps + local news to find projects"
        >
          <Sparkles size={18} className={deepScanning ? 'animate-pulse' : ''} />
          <span className="text-[9px] font-black uppercase leading-none">
            {deepScanning ? '···' : 'Deep'}
          </span>
        </button>

        {/* Civic Gaps - underserved-area overlay (gravity demand ÷ supply) */}
        <button
          onClick={withIntro('gaps', handleToggleGaps)}
          disabled={gapsLoading}
          className={`absolute bottom-[13rem] right-4 w-14 rounded-xl px-1 py-2 shadow-lg active:scale-95 transition-all z-[999] border flex flex-col items-center gap-0.5 disabled:opacity-70 ${
            gapCells ? 'bg-red-600 border-red-700 text-white' : 'bg-white border-stone-200 text-red-600 hover:bg-stone-50'
          }`}
          title="Show areas that need more facilities"
        >
          <Grid3X3 size={18} className={gapsLoading ? 'animate-pulse' : ''} />
          <span className="text-[9px] font-black uppercase leading-none">
            {gapsLoading ? '···' : 'Needs'}
          </span>
        </button>

        {/* Plan My Walk - TSP route through nearby unexplored projects */}
        <button
          onClick={withIntro('walk', handlePlanWalk)}
          className={`absolute bottom-[9rem] right-4 w-14 rounded-xl px-1 py-2 shadow-lg active:scale-95 transition-all z-[999] border flex flex-col items-center gap-0.5 ${
            walkPlan ? 'bg-[#451a03] border-[#451a03] text-white' : 'bg-white border-stone-200 text-[#451a03] hover:bg-stone-50'
          }`}
          title="Plan a walking route through unexplored projects near you"
        >
          <Footprints size={18} />
          <span className="text-[9px] font-black uppercase leading-none">Walk</span>
        </button>

        {/* Live Scan Button - fetch real projects around the visible area (free, OSM) */}
        <button
          onClick={withIntro('scan', handleScanArea)}
          disabled={scanning}
          className="absolute bottom-[5rem] right-4 w-14 bg-white rounded-xl px-1 py-2 shadow-lg hover:bg-stone-50 active:scale-95 transition-all z-[999] border border-stone-200 flex flex-col items-center gap-0.5 disabled:opacity-60"
          title="Find real projects in the area the map is showing"
        >
          <Radar size={18} className={scanning ? 'animate-spin text-orange-400' : 'text-orange-600'} />
          <span className="text-[9px] font-black uppercase leading-none text-orange-600">Scan</span>
        </button>

        {/* Locate Me Button - positioned like zoom controls */}
        <button
          onClick={handleLocateMe}
          className="absolute bottom-4 right-4 w-14 bg-white rounded-xl px-1 py-2 shadow-lg hover:bg-stone-50 active:scale-95 transition-all z-[999] border border-stone-200 flex flex-col items-center gap-0.5"
          title="Center map on your location"
        >
          <MapPin size={18} className="text-blue-600" />
          <span className="text-[9px] font-black uppercase leading-none text-blue-600">Me</span>
        </button>

        {/* Help — explains what every map tool does */}
        <button
          onClick={() => setShowToolGuide(true)}
          aria-label="What do these buttons do?"
          title="What do these buttons do?"
          className="absolute top-3 right-4 z-[999] flex items-center gap-1 rounded-full bg-white/90 border border-stone-200 px-2.5 py-1.5 text-[10px] font-black uppercase text-stone-600 shadow-md backdrop-blur-sm active:scale-95"
        >
          <HelpCircle size={14} className="text-orange-600" /> Help
        </button>

        {/* Status toast — feedback for the map action buttons. While a job is
            running it shows a spinner and stays put until the work finishes. */}
        <AnimatePresence>
          {statusMessage && !showPermissions && (
            <motion.div
              initial={{ y: -16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -16, opacity: 0 }}
              className="absolute top-3 inset-x-3 z-[1000] flex justify-center pointer-events-none"
            >
              <div className="flex items-center gap-2 bg-[#451a03]/90 text-white text-xs font-bold px-4 py-2.5 rounded-2xl shadow-lg backdrop-blur-sm max-w-sm text-center">
                {busy && (
                  <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                )}
                <span>{statusMessage}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Busy veil — the map dims slightly so it's obvious work is happening */}
        {busy && (
          <div className="absolute inset-0 z-[998] bg-white/20 backdrop-blur-[1px] pointer-events-none" />
        )}

        {/* Needs legend — the colours are meaningless without it */}
        {gapCells && gapCells.length > 0 && (
          <div className="absolute bottom-4 left-4 z-[999] rounded-xl bg-white/95 px-3 py-2 shadow-lg border border-stone-200 backdrop-blur-sm">
            <p className="text-[9px] font-black uppercase tracking-wider text-stone-500 mb-1.5">
              Need for {(selectedProject?.category ?? 'Hospitals').toLowerCase()}
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-bold text-emerald-600">Well served</span>
              <span
                className="h-2.5 w-16 rounded-full"
                style={{
                  background:
                    'linear-gradient(to right, rgba(16,185,129,0.55), rgba(245,158,11,0.6), rgba(220,38,38,0.75))',
                }}
              />
              <span className="text-[9px] font-bold text-red-600">Underserved</span>
            </div>
            <p className="mt-1 text-[8px] font-bold text-stone-400">Tap a square for details</p>
          </div>
        )}
      </div>

      {/* FIRST-TAP TOOL INTRO — explains a tool before it runs the first time */}
      <AnimatePresence>
        {toolIntro && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[85] flex items-end justify-center bg-black/40 backdrop-blur-[2px]"
            onClick={() => dismissIntro(false)}
          >
            <motion.div
              initial={{ y: 80 }}
              animate={{ y: 0 }}
              exit={{ y: 80 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-t-[32px] bg-white p-6 pb-8 space-y-4"
            >
              <div className="flex items-center gap-3">
                <span className="text-4xl">{TOOL_INFO[toolIntro.tool].emoji}</span>
                <div>
                  <h3 className="text-xl font-black text-[#451a03]">{TOOL_INFO[toolIntro.tool].title}</h3>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-orange-600">What this button does</p>
                </div>
              </div>
              <p className="text-sm leading-relaxed text-stone-700">{TOOL_INFO[toolIntro.tool].desc}</p>
              {TOOL_INFO[toolIntro.tool].hint && (
                <p className="text-xs text-stone-500 bg-orange-50 rounded-xl px-3 py-2">{TOOL_INFO[toolIntro.tool].hint}</p>
              )}
              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => dismissIntro(false)}
                  className="flex-1 rounded-2xl border-2 border-black/5 px-4 py-3 text-sm font-black text-[#451a03] active:scale-95"
                >
                  Not now
                </button>
                <button
                  onClick={() => dismissIntro(true)}
                  className="flex-1 rounded-2xl bg-orange-500 px-4 py-3 text-sm font-black text-white active:scale-95"
                >
                  Got it — try it!
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FULL TOOL GUIDE — from the ? Help button, lists every map tool */}
      <AnimatePresence>
        {showToolGuide && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[85] flex items-end justify-center bg-black/40 backdrop-blur-[2px]"
            onClick={() => setShowToolGuide(false)}
          >
            <motion.div
              initial={{ y: 80 }}
              animate={{ y: 0 }}
              exit={{ y: 80 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-t-[32px] bg-white p-6 pb-8 space-y-4 max-h-[80vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-black text-[#451a03]">Map Tools Guide</h3>
                <button
                  onClick={() => setShowToolGuide(false)}
                  aria-label="Close guide"
                  className="p-2 rounded-full hover:bg-stone-100 active:scale-95"
                >
                  <X size={18} />
                </button>
              </div>
              {(Object.keys(TOOL_INFO) as ToolKey[]).map((key) => (
                <div key={key} className="flex gap-3 rounded-2xl border border-stone-100 bg-stone-50 p-4">
                  <span className="text-2xl">{TOOL_INFO[key].emoji}</span>
                  <div className="space-y-1">
                    <p className="text-sm font-black text-[#451a03]">{TOOL_INFO[key].title}</p>
                    <p className="text-xs leading-relaxed text-stone-600">{TOOL_INFO[key].desc}</p>
                  </div>
                </div>
              ))}
              <p className="text-center text-[11px] text-stone-400">
                The buttons live on the right edge of the map, top to bottom in this order.
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* PERMISSIONS OVERLAY - shown over map if needed */}
      {showPermissions && !allExplorePermissionsGranted && (
        <div className="absolute inset-0 z-[60] bg-black/30 backdrop-blur-sm flex items-center justify-center px-4">
          <div className="bg-white rounded-3xl p-6 max-w-sm space-y-4">
            <div>
              <h2 className="text-lg font-black text-[#451a03]">Enable Permissions</h2>
              <p className="text-xs text-gray-500 mt-1">To explore projects and get notifications</p>
            </div>

            {/* Location Toggle */}
            <button
              onClick={locationAllowed ? disableLocation : enableLocation}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl border-2 transition-all"
              style={{
                backgroundColor: locationAllowed ? '#dbeafe' : '#fff',
                borderColor: locationAllowed ? '#0ea5e9' : '#e5e7eb',
              }}
            >
              <MapPin size={20} className={locationAllowed ? 'text-blue-600' : 'text-gray-400'} />
              <div className="flex-1 text-left">
                <p className="text-xs font-bold text-gray-900">Location</p>
                <p className="text-[11px] text-gray-500">{locationAllowed ? '✓ Enabled' : 'Tap to enable'}</p>
              </div>
              {locationAllowed && <CheckCircle size={18} className="text-green-600" />}
            </button>

            {/* Notification Toggle */}
            <button
              onClick={enableNotifications}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl border-2 transition-all"
              style={{
                backgroundColor: notificationsAllowed ? '#dbeafe' : '#fff',
                borderColor: notificationsAllowed ? '#0ea5e9' : '#e5e7eb',
              }}
            >
              <Bell size={20} className={notificationsAllowed ? 'text-blue-600' : 'text-gray-400'} />
              <div className="flex-1 text-left">
                <p className="text-xs font-bold text-gray-900">Notifications</p>
                <p className="text-[11px] text-gray-500">{notificationsAllowed ? '✓ Enabled' : 'Tap to enable'}</p>
              </div>
              {notificationsAllowed && <CheckCircle size={18} className="text-green-600" />}
            </button>

            {statusMessage && (
              <div className="text-xs font-semibold text-orange-700 bg-orange-100 rounded-xl px-3 py-2">
                {statusMessage}
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW DESCRIPTION BUTTON - when card is closed (hidden when AR/Post modals open) */}
      <AnimatePresence>
        {selectedProject && !showDescription && !isARModalOpen && !isCreatePostOpen && (
          <motion.div 
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-28 inset-x-0 z-[70] flex justify-center px-4"
          >
            <button
              onClick={() => setShowDescription(true)}
              className="bg-[#451a03] text-white px-8 py-4 rounded-full font-black text-[11px] uppercase tracking-[0.2em] flex items-center gap-3 shadow-[0_15px_35px_rgba(69,26,3,0.4)] border-2 border-white/20 active:scale-95 transition-transform"
            >
              <ChevronUp size={18} className="animate-bounce" />
              View Description
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* DESCRIPTION BOTTOM SHEET MODAL - Instagram style (hidden when AR/Post modals open) */}
      <AnimatePresence>
        {selectedProject && allExplorePermissionsGranted && isFromSearchNav && showDescription && !isARModalOpen && !isCreatePostOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeCard}
              className="fixed inset-0 bg-black/30 backdrop-blur-[2px] z-[80]"
            />

            <div className="fixed inset-x-0 bottom-0 z-[100] flex justify-center px-4 pointer-events-none">
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: '0%' }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                drag="y"
                dragConstraints={{ top: 0 }}
                dragElastic={0.1}
                onDragEnd={(_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
                  if (info.offset.y > 150 || info.velocity.y > 500) {
                    closeCard()
                  }
                }}
                className="w-full max-w-md bg-white rounded-t-[40px] shadow-[0_-12px_40px_rgba(0,0,0,0.15)] border-t border-stone-200 pointer-events-auto touch-none flex flex-col max-h-[85vh]"
              >
                {/* DRAG HANDLE */}
                <div className="flex justify-center pt-4 pb-6">
                  <div className="w-12 h-1.5 bg-stone-300 rounded-full opacity-50" />
                </div>

                <div className="px-6 pb-12 overflow-y-auto custom-scrollbar">
                  {/* Header with close button */}
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-orange-50 rounded-2xl border border-orange-100">
                        <MapPinIcon size={24} className="text-orange-600" />
                      </div>
                      <div>
                        <h2 className="text-xl font-black text-[#451a03] leading-none tracking-tight uppercase">
                          {selectedProject.name}
                        </h2>
                        <p className="text-[11px] text-stone-500 font-bold uppercase tracking-widest mt-1.5">
                          {selectedProject.location}
                        </p>
                        {newsSources[selectedProject.id] && (
                          <a
                            href={newsSources[selectedProject.id]}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 inline-flex items-center gap-1 rounded-lg bg-orange-100 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-orange-700 active:scale-95"
                          >
                            📰 Found in local news — read article
                          </a>
                        )}
                      </div>
                    </div>
                    <button 
                      onClick={closeCard}
                      className="p-2 bg-stone-100 rounded-full text-stone-400"
                    >
                      <X size={20} />
                    </button>
                  </div>

                  {/* Status badge */}
                  <div className="flex gap-2 mb-6">
                    <span className={`text-[10px] font-black px-4 py-2 rounded-xl border uppercase ${
                      selectedProject.status === 'completed' ? 'bg-green-50 text-green-700 border-green-100' :
                      selectedProject.status === 'ongoing' ? 'bg-orange-50 text-orange-700 border-orange-100' :
                      'bg-blue-50 text-blue-700 border-blue-100'
                    }`}>
                      ● {selectedProject.status}
                    </span>
                    {selectedProject.completionPercentage && (
                      <span className="text-[10px] font-black bg-blue-50 text-blue-700 px-4 py-2 rounded-xl border border-blue-100 uppercase">
                        {selectedProject.completionPercentage}% Complete
                      </span>
                    )}
                  </div>

                  {/* Description with enhancement */}
                  <div className="bg-stone-50/80 rounded-[32px] p-6 border border-stone-100 mb-8">
                    <p className="text-sm leading-relaxed text-stone-700 font-medium">
                      {selectedProject.longDescription || selectedProject.description}
                    </p>
                    {enhancedContent && enhancedContent !== selectedProject.description && (
                      <p className="text-sm text-stone-600 italic border-l-4 border-orange-400 pl-3 bg-orange-50 py-2 rounded mt-4">
                        💡 {enhancedContent}
                      </p>
                    )}
                    {selectedInsight?.citizenTip && (
                      <p className="text-xs text-stone-500 mt-3">
                        <span className="font-bold text-stone-600">Tip:</span> {selectedInsight.citizenTip}
                      </p>
                    )}
                  </div>

                  {/* QUICK STATS — reach & impact from the gravity/2SFCA model */}
                  <div className="grid grid-cols-3 gap-3 mb-6">
                    <div className="bg-white border border-stone-100 p-4 rounded-3xl text-center">
                      <MapPinIcon size={18} className="text-orange-600 flex justify-center mx-auto mb-2" />
                      <p className="text-[9px] font-black text-stone-800 uppercase tracking-tighter">{selectedProject.type || 'Project'}</p>
                    </div>
                    <div className="bg-white border border-stone-100 p-4 rounded-3xl text-center">
                      <Users size={18} className="text-blue-600 flex justify-center mx-auto mb-2" />
                      <p className="text-[9px] font-black text-stone-800 uppercase tracking-tighter">
                        {selectedImpact
                          ? `${Math.round(selectedImpact.popServed / 1000)}K reach`
                          : selectedProject.impact || '100K+'}
                      </p>
                    </div>
                    <div className="bg-white border border-stone-100 p-4 rounded-3xl text-center">
                      <Lightbulb size={18} className="text-yellow-600 flex justify-center mx-auto mb-2" />
                      <p className="text-[9px] font-black text-stone-800 uppercase tracking-tighter">
                        {selectedImpact ? `Impact ${selectedImpact.index}/100` : 'KEY'}
                      </p>
                    </div>
                  </div>

                  {/* SIMILAR PROJECTS — vector-DB nearest neighbors */}
                  {similarLoading && similar.length === 0 && (
                    <div className="mb-6 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-stone-400">
                      <span className="h-3 w-3 rounded-full border-2 border-stone-200 border-t-orange-500 animate-spin" />
                      Finding similar projects…
                    </div>
                  )}
                  {similar.length > 0 && (
                    <div className="mb-6">
                      <p className="text-[10px] font-black text-stone-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                        <Sparkles size={12} className="text-orange-500" /> Similar Projects
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {similar.map((hit) => (
                          <button
                            key={hit.id}
                            onClick={() => navigate('/explore', { state: { projectId: hit.id } })}
                            className="max-w-full truncate rounded-full border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-bold text-orange-700 active:scale-95 transition-transform"
                            title={hit.name}
                          >
                            {hit.name.length > 30 ? `${hit.name.slice(0, 30)}…` : hit.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* PRIMARY ACTIONS */}
                  <div className="flex gap-3 sticky bottom-0 bg-white pt-2">
                    <button
                      onClick={handleARCamera}
                      className="flex-[1.2] bg-[#451a03] text-white font-bold py-5 rounded-2xl text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all active:scale-95 shadow-lg shadow-orange-900/20"
                    >
                      <Camera size={20} /> AR
                    </button>
                    <button
                      onClick={() => setShow3D(true)}
                      className="flex-1 bg-orange-500 text-white font-bold py-5 rounded-2xl text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all active:scale-95 shadow-lg shadow-orange-500/30"
                    >
                      <Box size={20} /> 3D
                    </button>
                    <button
                      onClick={handleCreatePost}
                      className="flex-1 bg-white border-2 border-stone-200 text-stone-800 font-bold py-5 rounded-2xl text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all active:scale-95"
                    >
                      <Plus size={20} /> Post
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>

      {/* 3D PROJECT VIEWER (three.js — lazy chunk) */}
      {show3D && selectedProject && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1c1410]">
              <p className="text-sm font-semibold text-orange-300">Loading 3D viewer…</p>
            </div>
          }
        >
          <Project3DViewer project={selectedProject} onClose={() => setShow3D(false)} />
        </Suspense>
      )}

      {/* AR CAMERA MODAL */}
      {isARModalOpen && selectedProject && (
        <ARCameraModal
          project={selectedProject}
          onClose={closeARModal}
        />
      )}

      {/* CREATE POST MODAL */}
      {isCreatePostOpen && user && selectedProject && (
        <CreatePostModalForProject
          project={selectedProject}
          onClose={closeCreatePost}
          user={user}
        />
      )}
    </section>
  )
}

// ============ CREATE POST MODAL FOR PROJECT ============
function CreatePostModalForProject({
  project,
  onClose,
  user,
}: {
  project: EnhancedProject
  onClose: () => void
  user: User
}) {
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

  const handleImageCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCompressing(true)
    try {
      // Compress to ~200 KB so the post fits Firestore's 1 MB document limit.
      const compressed = await compressImage(file)
      setImageFile(file)
      setImagePreview(compressed)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not process that image.')
    } finally {
      setCompressing(false)
    }
  }

  const removeImage = () => {
    setImageFile(null)
    setImagePreview(null)
  }

  const handleSubmit = async () => {
    if (!content.trim()) {
      alert('Please write some feedback')
      return
    }

    if (content.trim().length < 4) {
      alert('Feedback must be at least 4 characters')
      return
    }

    if (!user) {
      alert('Please sign in to post.')
      return
    }

    setSubmitting(true)
    try {
      // Posting from a project card: the project link and feed category come
      // from the project itself — nothing for the user to pick.
      const categoryByProject: Record<string, string> = {
        Hospitals: 'Healthcare',
        Colleges: 'Smart City',
        Bridges: 'Transport',
        Flyovers: 'Transport',
        'Metro stations': 'Transport',
        'Road projects': 'Roads',
        'Smart city projects': 'Smart City',
      }

      await createCommunityPost(
        {
          content,
          category: categoryByProject[project.category] ?? 'Roads',
          projectId: project.id,
          imageData: imagePreview,
        },
        user,
      )
      setContent('')
      setImageFile(null)
      setImagePreview(null)
      onClose()
    } catch (error) {
      console.error('Error creating post:', error)
      alert(error instanceof Error ? `Failed to create post: ${error.message}` : 'Failed to create post. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end" onClick={handleBackdropClick}>
      <div className="w-full bg-white rounded-t-[32px] p-6 space-y-5 max-h-[90vh] overflow-y-auto animate-in slide-in-from-bottom-5 duration-300">
        
        {/* Header with Close Button */}
        <div className="flex items-start justify-between">
          <div className="space-y-2 flex-1">
            <h2 className="text-2xl font-black text-[#451a03]">Create a Post</h2>
            <p className="text-sm text-orange-700 font-semibold">About: {project.name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors active:scale-95"
            aria-label="Close modal"
          >
            <X size={24} className="text-[#451a03]" />
          </button>
        </div>

        {/* Description Textarea */}
        <div className="space-y-2">
          <label className="text-xs font-black text-[#451a03] uppercase">Your Feedback</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Share your experience with this project, what you've observed, suggestions for improvement... (like Reddit)"
            maxLength={500}
            className="w-full p-4 border-2 border-black/5 rounded-2xl focus:outline-none focus:ring-2 focus:ring-orange-500 text-sm resize-none"
            rows={5}
          />
          <p className="text-[10px] text-stone-400">{content.length}/500</p>
        </div>

        {/* Image Capture (Optional) */}
        <div className="space-y-2">
          <label className="text-xs font-black text-[#451a03] uppercase">📸 Capture Image (Optional)</label>
          <div className="flex gap-2">
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleImageCapture}
              disabled={submitting}
              className="hidden"
              id="imageInput"
            />
            <label 
              htmlFor="imageInput"
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border-2 border-dashed border-orange-300 bg-orange-50 text-orange-700 font-black text-xs uppercase cursor-pointer hover:bg-orange-100 transition-all active:scale-95 disabled:opacity-50"
            >
              <Camera size={16} strokeWidth={3} />
              {compressing ? 'Compressing…' : imageFile ? imageFile.name.substring(0, 20) : 'Capture / Upload'}
            </label>
          </div>

          {/* Image Preview */}
          {imagePreview && (
            <div className="relative rounded-2xl overflow-hidden bg-stone-100 border-2 border-orange-200">
              <img 
                src={imagePreview} 
                alt="Preview" 
                className="w-full h-48 object-cover"
              />
              <button
                onClick={removeImage}
                className="absolute top-2 right-2 p-2 bg-red-500 hover:bg-red-600 text-white rounded-full transition-all active:scale-90"
                type="button"
              >
                <X size={16} strokeWidth={3} />
              </button>
            </div>
          )}
        </div>

        {/* Buttons */}
        <div className="flex gap-3 pt-4">
          <button
            onClick={onClose}
            className="flex-1 px-6 py-3 rounded-2xl border-2 border-black/5 text-[#451a03] font-black text-sm hover:bg-stone-50 transition-all active:scale-95"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || compressing}
            className="flex-1 px-6 py-3 rounded-2xl bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-black text-sm transition-all active:scale-95"
          >
            {submitting ? '...' : 'Create Post'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============ AR CAMERA MODAL ============
function ARCameraModal({ 
  project, 
  onClose 
}: { 
  project: EnhancedProject
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    // Hold the stream here rather than reaching through videoRef in cleanup.
    // If the modal closes while the permission prompt is still open, the element
    // is already gone by then — so the old cleanup found `videoRef.current` null,
    // stopped nothing, and left the camera running with its indicator lit.
    let stream: MediaStream | null = null
    let cancelled = false

    const startCamera = async () => {
      try {
        const granted = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        })
        if (cancelled) {
          granted.getTracks().forEach(track => track.stop())
          return
        }
        stream = granted
        if (videoRef.current) {
          videoRef.current.srcObject = granted
        }
      } catch (err) {
        if (cancelled) return
        setError('Camera access denied or not available')
        console.error('Camera error:', err)
      }
    }

    startCamera()

    return () => {
      cancelled = true
      stream?.getTracks().forEach(track => track.stop())
    }
  }, [])

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col" onClick={handleBackdropClick}>
      {/* AR Camera View */}
      <div className="flex-1 relative bg-black flex items-center justify-center">
        {error ? (
          <div className="text-white text-center space-y-4">
            <div className="text-4xl">📷</div>
            <p className="text-lg font-bold">{error}</p>
            <p className="text-sm text-gray-400">Grant camera permission to view AR</p>
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />
        )}

        {/* Project Info Overlay - Enhanced with full details */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-4">
          <div className="bg-black/80 backdrop-blur-md rounded-3xl p-6 text-white text-center max-w-sm space-y-3 border border-white/20">
            <p className="text-xs font-black uppercase tracking-widest text-orange-400">📍 AR View</p>
            <div>
              <p className="text-2xl font-black uppercase tracking-tight">{project.name}</p>
              <p className="text-xs text-gray-300 mt-2">{project.location}</p>
            </div>
            
            {/* Status badge */}
            <div className="flex justify-center gap-2 flex-wrap">
              <span className={`text-[10px] font-black px-3 py-1 rounded-full uppercase ${
                project.status === 'completed' ? 'bg-green-500/30 text-green-200' :
                project.status === 'ongoing' ? 'bg-orange-500/30 text-orange-200' :
                'bg-blue-500/30 text-blue-200'
              }`}>
                ● {project.status}
              </span>
              {project.completionPercentage && (
                <span className="text-[10px] font-black px-3 py-1 rounded-full bg-blue-500/30 text-blue-200 uppercase">
                  {project.completionPercentage}%
                </span>
              )}
            </div>

            {/* Full description */}
            <p className="text-sm leading-snug text-gray-200 bg-black/40 rounded-xl p-3">
              {project.longDescription || project.description}
            </p>

            {/* Quick impact info */}
            {project.impact && (
              <div className="text-xs text-gray-300 italic border-l-2 border-orange-400 pl-2">
                ✨ {project.impact}
              </div>
            )}
          </div>
        </div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-6 right-6 p-3 bg-white/20 hover:bg-white/30 backdrop-blur rounded-full transition-all active:scale-95"
          aria-label="Close AR camera"
        >
          <X size={24} className="text-white" />
        </button>
      </div>

      {/* Info Bar - Show category and full description snippet */}
      <div className="bg-gradient-to-b from-black/50 to-black px-6 py-4 text-white text-center border-t border-white/10">
        <p className="text-[11px] text-orange-300 font-black uppercase tracking-widest">{project.category}</p>
        <p className="text-xs text-gray-300 mt-2 line-clamp-2">
          {project.longDescription || project.description}
        </p>
      </div>
    </div>
  )
}
