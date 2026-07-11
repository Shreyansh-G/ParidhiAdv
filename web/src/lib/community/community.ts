import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  where,
  type Unsubscribe,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { User } from 'firebase/auth'
import { db, firebaseFunctions } from '../firebase'
import type { CommunityPost, PostStatus } from '../../types/community'

const moderationPriority: Record<PostStatus, number> = {
  active: 0,
  limited: 1,
  hidden: 2,
}

function ensureDb() {
  if (!db) {
    throw new Error('Firebase is not configured yet. Add your VITE_FIREBASE_* keys.')
  }

  return db
}

function ensureFunctions() {
  if (!firebaseFunctions) {
    throw new Error('Cloud Functions is not configured yet.')
  }

  return firebaseFunctions
}

export interface NewPostInput {
  content: string
  /** Feed category chip: Roads | Smart City | Transport | Healthcare */
  category: string
  /** Optional link to a project (set when posting from a project card) */
  projectId?: string | null
  /** Optional compressed base64 data-URL (see lib/imageCompression) */
  imageData?: string | null
}

/**
 * Single write path for posts.
 *
 * The write happens SERVER-SIDE (createPost callable), not from the client:
 * the author's name and photo are taken from the verified auth token, so a
 * crafted client can't post as "Delhi Municipal Corporation ✓", and the server
 * can rate-limit spam (each post costs an AI moderation call).
 */
export async function createCommunityPost(input: NewPostInput, _user: User) {
  const instance = ensureFunctions()
  const cleanContent = input.content.trim()

  if (cleanContent.length < 4) {
    throw new Error('Post is too short.')
  }
  if (cleanContent.length > 600) {
    throw new Error('Post is too long (600 characters max).')
  }

  const createPost = httpsCallable<NewPostInput, { id: string }>(instance, 'createPost')
  await createPost({
    content: cleanContent,
    category: input.category,
    projectId: input.projectId ?? null,
    imageData: input.imageData ?? null,
  })
}

export async function deleteCommunityPost(postId: string) {
  const firestore = ensureDb()
  await deleteDoc(doc(firestore, 'posts', postId))
}

export async function voteOnCommunityPost(postId: string, vote: 'up' | 'down' | 'none') {
  const instance = ensureFunctions()
  const votePost = httpsCallable(instance, 'votePost')
  await votePost({ postId, vote })
}

export async function reportCommunityPost(postId: string, reason: string) {
  const instance = ensureFunctions()
  const reportPost = httpsCallable(instance, 'reportPost')
  await reportPost({ postId, reason })
}

export function subscribeToCommunityPosts(
  callback: (posts: CommunityPost[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const firestore = ensureDb()
  const postsQuery = query(
    collection(firestore, 'posts'),
    where('status', 'in', ['active', 'limited']),
    orderBy('score', 'desc'),
    orderBy('createdAt', 'desc'),
  )

  return onSnapshot(
    postsQuery,
    (snapshot) => {
      const posts: CommunityPost[] = snapshot.docs.map((doc) => {
        const raw = doc.data() as Omit<CommunityPost, 'id'>
        return {
          id: doc.id,
          ...raw,
          authorPhotoURL: raw.authorPhotoURL ?? null,
          status: raw.status ?? 'active',
          upvotes: Number(raw.upvotes ?? 0),
          downvotes: Number(raw.downvotes ?? 0),
          reports: Number(raw.reports ?? 0),
          score: Number(raw.score ?? 0),
          createdAt: raw.createdAt ?? null,
          updatedAt: raw.updatedAt ?? null,
        }
      })

      posts.sort((a, b) => {
        const statusDelta = moderationPriority[a.status] - moderationPriority[b.status]
        if (statusDelta !== 0) return statusDelta
        if (a.score !== b.score) return b.score - a.score
        const aTime = a.createdAt?.toMillis() ?? 0
        const bTime = b.createdAt?.toMillis() ?? 0
        return bTime - aTime
      })

      callback(posts)
    },
    (error) => onError(error),
  )
}

export function subscribeToProjectPosts(
  projectId: string,
  callback: (posts: CommunityPost[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const firestore = ensureDb()
  const postsQuery = query(
    collection(firestore, 'posts'),
    where('projectId', '==', projectId),
    where('status', 'in', ['active', 'limited']),
    orderBy('score', 'desc'),
    orderBy('createdAt', 'desc'),
  )

  return onSnapshot(
    postsQuery,
    (snapshot) => {
      const posts: CommunityPost[] = snapshot.docs.map((doc) => {
        const raw = doc.data() as Omit<CommunityPost, 'id'>
        return {
          id: doc.id,
          ...raw,
          authorPhotoURL: raw.authorPhotoURL ?? null,
          status: raw.status ?? 'active',
          upvotes: Number(raw.upvotes ?? 0),
          downvotes: Number(raw.downvotes ?? 0),
          reports: Number(raw.reports ?? 0),
          score: Number(raw.score ?? 0),
          createdAt: raw.createdAt ?? null,
          updatedAt: raw.updatedAt ?? null,
        }
      })

      posts.sort((a, b) => {
        const statusDelta = moderationPriority[a.status] - moderationPriority[b.status]
        if (statusDelta !== 0) return statusDelta
        if (a.score !== b.score) return b.score - a.score
        const aTime = a.createdAt?.toMillis() ?? 0
        const bTime = b.createdAt?.toMillis() ?? 0
        return bTime - aTime
      })

      callback(posts)
    },
    (error) => onError(error),
  )
}
