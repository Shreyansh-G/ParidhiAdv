import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from './AuthContext'
import { db } from '../lib/firebase'

const STORAGE_KEY = 'paridhi.exploredProjects'
const TIMESTAMPS_KEY = 'paridhi.exploredAt'

interface ExplorationContextValue {
  exploredProjectIds: string[]
  /** projectId → ISO timestamp of when it was explored (drives streak/calendar math) */
  exploredAt: Record<string, string>
  isExplored: (projectId: string) => boolean
  markExplored: (projectId: string) => void
  totalExplored: number
}

const ExplorationContext = createContext<ExplorationContextValue | undefined>(undefined)

function loadExploredIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function loadExploredAt(ids: string[]): Record<string, string> {
  let stored: Record<string, string> = {}
  try {
    const raw = localStorage.getItem(TIMESTAMPS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') stored = parsed
    }
  } catch {
    // ignore storage errors
  }
  // Migration: ids explored before timestamps existed get stamped now (once)
  const nowIso = new Date().toISOString()
  for (const id of ids) {
    if (typeof stored[id] !== 'string') stored[id] = nowIso
  }
  return stored
}

export function ExplorationProvider({ children }: { children: React.ReactNode }) {
  const { user, isConfigured } = useAuth()
  const [exploredProjectIds, setExploredProjectIds] = useState<string[]>(() => loadExploredIds())
  const [exploredAt, setExploredAt] = useState<Record<string, string>>(() =>
    loadExploredAt(loadExploredIds()),
  )
  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(exploredProjectIds))
  }, [exploredProjectIds])

  useEffect(() => {
    localStorage.setItem(TIMESTAMPS_KEY, JSON.stringify(exploredAt))
  }, [exploredAt])

  useEffect(() => {
    async function hydrateFromCloud() {
      if (!db || !user || !isConfigured) {
        setHydratedUserId(null)
        return
      }

      const userRef = doc(db, 'users', user.uid)
      const snapshot = await getDoc(userRef)
      const data = snapshot.data()
      const cloudIds = Array.isArray(data?.exploredProjectIds)
        ? data?.exploredProjectIds.filter((item: unknown): item is string => typeof item === 'string')
        : []
      const cloudAt: Record<string, string> =
        data?.exploredAt && typeof data.exploredAt === 'object' ? data.exploredAt : {}

      setExploredProjectIds((previous) => Array.from(new Set([...previous, ...cloudIds])))
      setExploredAt((previous) => {
        const merged = { ...previous }
        for (const [id, iso] of Object.entries(cloudAt)) {
          // keep the EARLIEST known timestamp for each exploration
          if (typeof iso === 'string' && (!merged[id] || iso < merged[id])) merged[id] = iso
        }
        const nowIso = new Date().toISOString()
        for (const id of cloudIds) {
          if (!merged[id]) merged[id] = nowIso
        }
        return merged
      })
      setHydratedUserId(user.uid)
    }

    void hydrateFromCloud()
  }, [isConfigured, user])

  useEffect(() => {
    async function persistExploration() {
      if (!db || !user || !isConfigured || hydratedUserId !== user.uid) return

      await setDoc(
        doc(db, 'users', user.uid),
        {
          exploredProjectIds,
          exploredAt,
          exploredCount: exploredProjectIds.length,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      )
    }

    void persistExploration()
  }, [exploredProjectIds, exploredAt, hydratedUserId, isConfigured, user])

  const value = useMemo<ExplorationContextValue>(
    () => ({
      exploredProjectIds,
      exploredAt,
      totalExplored: exploredProjectIds.length,
      isExplored: (projectId) => exploredProjectIds.includes(projectId),
      markExplored: (projectId) => {
        setExploredProjectIds((previous) => {
          if (previous.includes(projectId)) return previous
          return [...previous, projectId]
        })
        setExploredAt((previous) =>
          previous[projectId] ? previous : { ...previous, [projectId]: new Date().toISOString() },
        )
      },
    }),
    [exploredProjectIds, exploredAt],
  )

  return <ExplorationContext.Provider value={value}>{children}</ExplorationContext.Provider>
}

export function useExploration() {
  const context = useContext(ExplorationContext)
  if (!context) {
    throw new Error('useExploration must be used within ExplorationProvider')
  }

  return context
}
