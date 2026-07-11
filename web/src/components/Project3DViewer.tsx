// 3D project viewer — react-three-fiber.
//
// Two rendering modes:
//   1. REAL footprint — for `osm-way-*` projects we extrude the building's
//      actual OpenStreetMap polygon (height from building:levels when mapped).
//   2. PROCEDURAL — low-poly parametric model per category for point-based
//      projects (hospital block, metro platform, bridge span, …).
//
// Under-construction projects "grow": the solid body is revealed to
// completionPercentage, with a wireframe ghost showing the remainder.
//
// Loaded lazily (React.lazy) so three.js stays out of the main bundle.

import { Suspense, useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { EnhancedProject } from '../data/projectsEnhanced'
import { fetchFootprint, type Footprint } from '../lib/buildingGeometry'

const ORANGE = '#f97316'
const DARK = '#451a03'
const CREAM = '#fde8d7'
const CONCRETE = '#d6cfc7'

const CATEGORY_FLOOR_HEIGHT = 3.2 // meters per level
const DEFAULT_LEVELS: Record<string, number> = {
  Hospitals: 5,
  Colleges: 3,
  'Metro stations': 2,
  Bridges: 2,
  Flyovers: 2,
  'Road projects': 1,
  'Smart city projects': 4,
}

// ---------------------------------------------------------------------------
// Real-footprint building (extruded OSM polygon)
// ---------------------------------------------------------------------------

function FootprintBuilding({
  footprint,
  levels,
  completion,
}: {
  footprint: Footprint
  levels: number
  completion: number
}) {
  const height = levels * CATEGORY_FLOOR_HEIGHT
  const builtHeight = Math.max(0.5, height * completion)

  const geometry = useMemo(() => {
    const shape = new THREE.Shape()
    footprint.points.forEach((p, i) => {
      if (i === 0) shape.moveTo(p.x, p.y)
      else shape.lineTo(p.x, p.y)
    })
    shape.closePath()
    return shape
  }, [footprint])

  const solid = useMemo(
    () => new THREE.ExtrudeGeometry(geometry, { depth: builtHeight, bevelEnabled: false }),
    [geometry, builtHeight],
  )
  const ghost = useMemo(
    () => new THREE.ExtrudeGeometry(geometry, { depth: height, bevelEnabled: false }),
    [geometry, height],
  )

  return (
    // Extrude runs along +Z; rotate so the building rises along +Y
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <mesh geometry={solid} castShadow receiveShadow>
        <meshStandardMaterial color={CREAM} roughness={0.85} />
      </mesh>
      {completion < 1 && (
        <mesh geometry={ghost}>
          <meshBasicMaterial color={ORANGE} wireframe transparent opacity={0.28} />
        </mesh>
      )}
    </group>
  )
}

// ---------------------------------------------------------------------------
// Procedural low-poly models per category
// ---------------------------------------------------------------------------

function Box({
  size,
  position,
  color,
  wireframe = false,
}: {
  size: [number, number, number]
  position: [number, number, number]
  color: string
  wireframe?: boolean
}) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      {wireframe ? (
        <meshBasicMaterial color={color} wireframe transparent opacity={0.28} />
      ) : (
        <meshStandardMaterial color={color} roughness={0.8} />
      )}
    </mesh>
  )
}

function ProceduralModel({ category }: { category: string }) {
  switch (category) {
    case 'Hospitals':
      return (
        <group>
          <Box size={[18, 14, 12]} position={[0, 7, 0]} color={CREAM} />
          <Box size={[10, 8, 10]} position={[13, 4, 0]} color={CREAM} />
          {/* red cross */}
          <Box size={[1.2, 5, 0.6]} position={[0, 17, 6.2]} color="#dc2626" />
          <Box size={[5, 1.2, 0.6]} position={[0, 17, 6.2]} color="#dc2626" />
        </group>
      )
    case 'Colleges':
      return (
        <group>
          <Box size={[26, 9, 10]} position={[0, 4.5, 0]} color={CREAM} />
          <Box size={[6, 15, 6]} position={[0, 7.5, 0]} color={ORANGE} />
          <mesh position={[0, 17.5, 0]} castShadow>
            <coneGeometry args={[4.2, 4, 4]} />
            <meshStandardMaterial color={DARK} />
          </mesh>
        </group>
      )
    case 'Metro stations':
      return (
        <group>
          <Box size={[30, 1.5, 10]} position={[0, 4, 0]} color={CONCRETE} />
          {[-12, -4, 4, 12].map((x) => (
            <Box key={x} size={[1.2, 4, 1.2]} position={[x, 2, 0]} color={CONCRETE} />
          ))}
          <mesh position={[0, 7.4, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[5.2, 5.2, 30, 24, 1, false, 0, Math.PI]} />
            <meshStandardMaterial color={ORANGE} side={THREE.DoubleSide} roughness={0.6} />
          </mesh>
        </group>
      )
    case 'Bridges':
    case 'Flyovers':
      return (
        <group>
          <Box size={[36, 1.4, 8]} position={[0, 8, 0]} color={CONCRETE} />
          {[-13, 0, 13].map((x) => (
            <Box key={x} size={[2.2, 8, 6]} position={[x, 4, 0]} color={CONCRETE} />
          ))}
          <Box size={[36, 0.7, 0.5]} position={[0, 9.4, 3.8]} color={ORANGE} />
          <Box size={[36, 0.7, 0.5]} position={[0, 9.4, -3.8]} color={ORANGE} />
        </group>
      )
    case 'Road projects':
      return (
        <group>
          <Box size={[34, 0.5, 9]} position={[0, 0.25, 0]} color="#54534f" />
          {[-10, 0, 10].map((x) => (
            <Box key={x} size={[3, 0.15, 0.7]} position={[x, 0.55, 0]} color="#f5f5f4" />
          ))}
          {/* barricades + crane */}
          <Box size={[2, 1.4, 0.4]} position={[-8, 0.9, 4]} color={ORANGE} />
          <Box size={[2, 1.4, 0.4]} position={[2, 0.9, -4]} color={ORANGE} />
          <Box size={[1, 12, 1]} position={[12, 6, 4]} color="#facc15" />
          <Box size={[10, 0.8, 0.8]} position={[8, 12, 4]} color="#facc15" />
        </group>
      )
    default: // Smart city projects
      return (
        <group>
          <Box size={[10, 20, 10]} position={[0, 10, 0]} color={CREAM} />
          <Box size={[10.4, 1, 10.4]} position={[0, 6, 0]} color={ORANGE} />
          <Box size={[10.4, 1, 10.4]} position={[0, 13, 0]} color={ORANGE} />
          <mesh position={[0, 23.5, 0]} castShadow>
            <cylinderGeometry args={[0.15, 0.15, 7]} />
            <meshStandardMaterial color={DARK} />
          </mesh>
          <mesh position={[0, 27, 0]}>
            <sphereGeometry args={[0.7]} />
            <meshStandardMaterial color={ORANGE} emissive={ORANGE} emissiveIntensity={0.6} />
          </mesh>
        </group>
      )
  }
}

// Reveal-by-completion wrapper for procedural models: solid part clipped by a
// scaled group, wireframe ghost above.
function ConstructionReveal({
  completion,
  children,
}: {
  completion: number
  children: React.ReactNode
}) {
  if (completion >= 1) return <>{children}</>
  return (
    <group>
      <group scale={[1, Math.max(0.15, completion), 1]}>{children}</group>
      <group>
        {/* ghost outline at full height */}
        <mesh position={[0, 10, 0]}>
          <boxGeometry args={[30, 20, 12]} />
          <meshBasicMaterial color={ORANGE} wireframe transparent opacity={0.12} />
        </mesh>
      </group>
    </group>
  )
}

// ---------------------------------------------------------------------------
// Scene + modal shell
// ---------------------------------------------------------------------------

function Scene({ project, footprint }: { project: EnhancedProject; footprint: Footprint | null }) {
  const completion =
    project.status === 'ongoing' ? (project.completionPercentage ?? 50) / 100 : 1
  const levels = footprint?.levels ?? DEFAULT_LEVELS[project.category] ?? 3
  const extent = footprint ? Math.max(30, footprint.extentM) : 45

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight
        position={[extent, extent * 1.2, extent * 0.6]}
        intensity={1.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      {/* ground disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
        <circleGeometry args={[extent * 1.2, 48]} />
        <meshStandardMaterial color="#efe7dd" roughness={1} />
      </mesh>

      {footprint ? (
        <FootprintBuilding footprint={footprint} levels={levels} completion={completion} />
      ) : (
        <ConstructionReveal completion={completion}>
          <ProceduralModel category={project.category} />
        </ConstructionReveal>
      )}

      <OrbitControls
        autoRotate
        autoRotateSpeed={0.8}
        enablePan={false}
        minDistance={extent * 0.6}
        maxDistance={extent * 3}
        maxPolarAngle={Math.PI / 2.1}
      />
    </>
  )
}

export default function Project3DViewer({
  project,
  onClose,
}: {
  project: EnhancedProject
  onClose: () => void
}) {
  // Tag the result with the project it belongs to, so "loading" is derived
  // rather than set. Switching projects can then never show the previous
  // building's footprint while the new one is still in flight.
  const [loaded, setLoaded] = useState<{ id: string; footprint: Footprint | null } | null>(null)
  const isCurrent = loaded?.id === project.id
  const footprint = isCurrent ? loaded.footprint : null
  const loadingFootprint = !isCurrent

  useEffect(() => {
    let alive = true
    fetchFootprint(project.id).then((result) => {
      if (alive) setLoaded({ id: project.id, footprint: result })
    })
    return () => {
      alive = false
    }
  }, [project.id])

  const cameraDistance = footprint ? Math.max(40, footprint.extentM * 1.3) : 55

  return (
    <div className="fixed inset-0 z-[100] mx-auto flex w-full max-w-md flex-col bg-[#1c1410]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-white">{project.name}</p>
          <p className="text-[11px] text-orange-300">
            {footprint
              ? '🧊 Real building footprint (OpenStreetMap)'
              : loadingFootprint
                ? 'Checking for real footprint…'
                : `🧊 ${project.category} — 3D model`}
            {project.status === 'ongoing' &&
              ` · ${project.completionPercentage ?? 50}% built`}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close 3D viewer"
          className="ml-3 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white active:scale-95"
        >
          Close
        </button>
      </div>

      {/* Canvas */}
      <div className="flex-1">
        <Suspense fallback={null}>
          <Canvas
            shadows
            camera={{ position: [cameraDistance, cameraDistance * 0.7, cameraDistance], fov: 45 }}
          >
            <color attach="background" args={['#1c1410']} />
            <fog attach="fog" args={['#1c1410', cameraDistance * 2, cameraDistance * 5]} />
            <Scene project={project} footprint={footprint} />
          </Canvas>
        </Suspense>
      </div>

      <p className="px-4 pb-4 pt-2 text-center text-[10px] text-white/40">
        Drag to rotate · pinch to zoom
        {project.status === 'ongoing' && ' · wireframe = under construction'}
      </p>
    </div>
  )
}
