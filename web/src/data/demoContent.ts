// ============================================================================
// DEMO CONTENT — dummy rows that fill sparse sections so the app looks alive
// during demos. Everything demo-related lives in THIS file only.
//
// ⚠️ Before a real public launch, set DEMO_CONTENT_ENABLED = false (or delete
// this file and its three call sites: CommunityPage, ProgressPage,
// NotificationsPage). Demo posts have ids starting with "demo-" and never
// touch Firestore — votes on them are local-only and they can't be reported
// or deleted.
// ============================================================================

import { Timestamp } from 'firebase/firestore'
import type { AppNotification } from '../lib/notificationService'

export const DEMO_CONTENT_ENABLED = true

const hoursAgo = (h: number) => Date.now() - h * 3600_000

// --- Community feed ---------------------------------------------------------

export interface DemoPost {
  id: string
  content: string
  category: string
  status: string
  upvotes: number
  downvotes: number
  score: number
  authorName: string
  authorId: string
  createdAt: Timestamp
}

export const demoPosts: DemoPost[] = [
  {
    id: 'demo-post-1',
    content:
      'Metro station ke bahar new cycle stand ban gaya hai! Finally a safe place to park. Great work DMRC 🚲',
    category: 'Transport',
    status: 'active',
    upvotes: 24,
    downvotes: 1,
    score: 23,
    authorName: 'Ravi Kumar',
    authorId: 'demo-user-1',
    createdAt: Timestamp.fromMillis(hoursAgo(3)),
  },
  {
    id: 'demo-post-2',
    content:
      'The new road near Karol Bagh is already showing cracks after one month. PWD should inspect the contractor work quality.',
    category: 'Roads',
    status: 'active',
    upvotes: 41,
    downvotes: 3,
    score: 38,
    authorName: 'Sneha Kapoor',
    authorId: 'demo-user-2',
    createdAt: Timestamp.fromMillis(hoursAgo(7)),
  },
  {
    id: 'demo-post-3',
    content:
      'Visited the upgraded mohalla clinic today — clean, fast token system, and the doctor was actually available. Impressed! 🏥',
    category: 'Healthcare',
    status: 'active',
    upvotes: 18,
    downvotes: 0,
    score: 18,
    authorName: 'Arif Khan',
    authorId: 'demo-user-3',
    createdAt: Timestamp.fromMillis(hoursAgo(12)),
  },
  {
    id: 'demo-post-4',
    content:
      'New LED streetlights installed in our block under the smart city project. The whole lane feels safer at night now 💡',
    category: 'Smart City',
    status: 'active',
    upvotes: 12,
    downvotes: 2,
    score: 10,
    authorName: 'Priya Singh',
    authorId: 'demo-user-4',
    createdAt: Timestamp.fromMillis(hoursAgo(26)),
  },
]

/** True when a post is demo filler (votes stay local, no report/delete). */
export function isDemoPost(postId: string): boolean {
  return postId.startsWith('demo-post-')
}

// --- Streak leaderboard ------------------------------------------------------

export interface DemoLeader {
  name: string
  streak: number
  xp: number
  level: number
  isYou?: boolean
}

export const demoLeaders: DemoLeader[] = [
  { name: 'Aman Sharma', streak: 12, xp: 1460, level: 6 },
  { name: 'Priya Singh', streak: 9, xp: 1105, level: 5 },
  { name: 'Rahul Verma', streak: 7, xp: 830, level: 4 },
  { name: 'Sneha Kapoor', streak: 5, xp: 655, level: 4 },
  { name: 'Vikram Das', streak: 4, xp: 470, level: 3 },
  { name: 'Meera Krishnan', streak: 3, xp: 320, level: 2 },
  { name: 'Zain Khan', streak: 2, xp: 195, level: 1 },
]

/**
 * Blend real leaderboard entries with demo filler: sorted by streak (it is a
 * streak leaderboard), re-ranked 1..10. Real users always keep their spot.
 */
export function padLeaderboard<T extends DemoLeader>(real: T[]): (DemoLeader & { rank: number })[] {
  const merged: DemoLeader[] = [...real, ...demoLeaders]
  merged.sort((a, b) => b.streak - a.streak || b.xp - a.xp)
  return merged.slice(0, 10).map((entry, i) => ({ ...entry, rank: i + 1 }))
}

// --- Notifications -----------------------------------------------------------

export function demoNotifications(userId: string): AppNotification[] {
  return [
    {
      id: 'demo-notif-1',
      userId,
      type: 'geofence',
      title: '📍 You discovered Delhi High Court S Block!',
      message: 'You walked near the Delhi High Court S Block Repair project and earned +50 XP. Keep exploring!',
      projectId: 'proj_delhi_hc_sblock_001',
      projectName: 'Delhi High Court S Block Repair',
      projectCategory: 'Smart city projects',
      read: false,
      createdAt: Timestamp.fromMillis(hoursAgo(5)),
    },
    {
      id: 'demo-notif-2',
      userId,
      type: 'admin',
      title: '🏗️ New projects added near you',
      message: '8 new under-construction projects were found in central Delhi. Open the map to see them.',
      read: false,
      createdAt: Timestamp.fromMillis(hoursAgo(20)),
    },
    {
      id: 'demo-notif-3',
      userId,
      type: 'system',
      title: '🔥 Streak reminder',
      message: 'Explore one project today to keep your streak alive!',
      read: true,
      createdAt: Timestamp.fromMillis(hoursAgo(44)),
    },
  ]
}
