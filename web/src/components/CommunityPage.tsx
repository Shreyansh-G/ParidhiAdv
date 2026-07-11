import { useEffect, useState, type ReactNode } from 'react'
import { onSnapshot, collection, query } from 'firebase/firestore'
import type { User } from 'firebase/auth'
import { useNavigate } from "react-router-dom";
import { useModal } from '../context/ModalContext'
import { enhancedProjects } from '../data/projectsEnhanced'
import { sortPosts, type FeedOrder } from '../lib/ranking'
import { 
  Plus, 
  Image as ImageIcon, 
  ArrowUpRight, 
  HardHat, 
  Construction, 
  Droplets,
  ThumbsUp,
  ThumbsDown,
  Camera,
  X,
  Trash2,
  Flag
} from "lucide-react";
import { db } from '../lib/firebase'
import { useAuth } from '../context/AuthContext'
import {
  createCommunityPost,
  deleteCommunityPost,
  reportCommunityPost,
  voteOnCommunityPost,
} from '../lib/community/community'
import { compressImage } from '../lib/imageCompression'
import { voteCache } from '../lib/storage'
import { DEMO_CONTENT_ENABLED, demoPosts, isDemoPost } from '../data/demoContent'

/**
 * The Timestamp-like shape a post's `createdAt` actually has — from Firestore
 * itself, or from `Timestamp.fromMillis()` in the demo rows. Deliberately the
 * same structural type `RankablePost` (lib/ranking) expects, so posts can be
 * ranked without a cast.
 */
type PostTimestamp = { toDate?: () => Date; toMillis?: () => number }

interface Post {
  id: string
  content?: string
  projectId?: string
  category?: string
  status?: string
  upvotes?: number
  downvotes?: number
  score?: number
  imageData?: string
  createdAt?: PostTimestamp
  authorName?: string
  authorId?: string
}

const CATEGORIES = ['All Posts', 'Roads', 'Smart City', 'Transport', 'Healthcare']

export default function CommunityPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { isCreatePostOpen, openCreatePost, closeCreatePost } = useModal()
  const [selectedFilter, setSelectedFilter] = useState('All Posts')
  const [posts, setPosts] = useState<Post[]>([])
  // Only "loading" if there's a Firestore instance that owes us a snapshot.
  const [loading, setLoading] = useState(() => Boolean(db))
  const [feedOrder, setFeedOrder] = useState<FeedOrder>('hot')

  useEffect(() => {
    if (!db) return

    const unsubscribe = onSnapshot(
      query(collection(db, 'posts')),
      (querySnapshot) => {
        const postsData: Post[] = []
        querySnapshot.forEach((doc) => {
          const data = doc.data()
          if (data.status === 'active') {
            postsData.push({ id: doc.id, ...data } as Post)
          }
        })
        // Demo filler keeps the feed lively while the community is small
        if (DEMO_CONTENT_ENABLED && postsData.length < 5) {
          postsData.push(...(demoPosts as Post[]))
        }
        postsData.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
        setPosts(postsData)
        setLoading(false)
      },
      (error) => {
        console.error('Failed to load posts:', error)
        setLoading(false)
      },
    )

    return () => unsubscribe()
  }, [])

  // Filter by category, then rank: Hot = Wilson score × 24h-half-life decay
  const filteredPosts = sortPosts(
    selectedFilter === 'All Posts' ? posts : posts.filter(p => p.category === selectedFilter),
    feedOrder,
  )

  const handleCreatePost = () => {
    if (!user) {
      alert('Please log in to create a post')
      navigate('/profile')
    } else {
      openCreatePost()
    }
  }
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-10">
      
      {/* 1. Header: Community Branding */}
      <header className="space-y-1">
        <h1 className="text-3xl font-black text-[#451a03] tracking-tighter uppercase leading-none">
          Communities
        </h1>
        <p className="text-[11px] font-bold text-orange-600 uppercase tracking-[0.3em]">
          Verified Citizen Reports
        </p>
      </header>

      {/* 2. Quick Filters: Project Type */}
      <section>
        <div className="flex gap-3 overflow-x-auto pb-4 no-scrollbar">
          {CATEGORIES.map((cat) => (
            <button 
              key={cat}
              onClick={() => setSelectedFilter(cat)}
              className={`whitespace-nowrap rounded-2xl px-6 py-2.5 text-xs font-black transition-all active:scale-90 ${
                selectedFilter === cat
                  ? 'bg-[#451a03] text-white shadow-xl shadow-orange-900/20' 
                  : 'bg-white text-[#451a03] border border-black/5 hover:bg-orange-50'
              }`}>
              {cat}
            </button>
          ))}
        </div>
      </section>

      {/* 3. Create Post Button + Feed Order */}
      <div className="flex gap-3">
        <button
          onClick={handleCreatePost}
          className="flex-1 flex items-center justify-center gap-2 rounded-2xl bg-orange-500 hover:bg-orange-600 text-white px-6 py-3 text-xs font-black transition-all active:scale-95 shadow-lg shadow-orange-500/30"
        >
          <Plus size={16} strokeWidth={3} />
          Create Post
        </button>
        <div className="flex rounded-2xl border border-black/5 bg-white p-1">
          {([['hot', '🔥 Hot'], ['new', '🕐 New']] as [FeedOrder, string][]).map(([order, label]) => (
            <button
              key={order}
              onClick={() => setFeedOrder(order)}
              className={`rounded-xl px-3 py-2 text-[11px] font-black transition-all ${
                feedOrder === order ? 'bg-[#451a03] text-white' : 'text-[#451a03]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 4. Posts List */}
      {loading ? (
        <div className="text-center py-8 text-stone-400">
          <p>Loading posts...</p>
        </div>
      ) : filteredPosts.length === 0 ? (
        <div className="text-center py-8 text-stone-400">
          <p>No posts in this category yet</p>
        </div>
      ) : (
        <section className="space-y-4">
          {filteredPosts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </section>
      )}

      {/* 5. Create Post Modal */}
      {isCreatePostOpen && user && (
        <CreatePostModal onClose={closeCreatePost} user={user} />
      )}

      {/* 6. Infrastructure Community Hubs - Explore Projects */}
      <section className="space-y-4 pt-8">
        <h3 className="text-sm font-black text-[#451a03] uppercase tracking-widest opacity-40 px-1">
          Explore Projects
        </h3>
        
        <div className="grid grid-cols-2 gap-4">
          <ProjectCard 
            title="Buildings" 
            stats={`${getCountByCategory('Colleges')} Projects`}
            icon={<Construction size={22}/>} 
            color="bg-amber-600"
            filter="Buildings"
            onNavigate={() => navigate('/search?filter=Buildings')}
          />
          <ProjectCard 
            title="Healthcare" 
            stats={`${getCountByCategory('Hospitals')} Projects`}
            icon={<Droplets size={22}/>} 
            color="bg-blue-600"
            filter="Healthcare"
            onNavigate={() => navigate('/search?filter=Healthcare')}
          />
          <ProjectCard 
            title="Transport" 
            stats={`${getCountByCategory('Metro stations')} Projects`}
            icon={<HardHat size={22}/>} 
            color="bg-slate-700"
            filter="Transport"
            onNavigate={() => navigate('/search?filter=Transport')}
          />
          <ProjectCard 
            title="All Projects" 
            stats={`${enhancedProjects.length} Total`}
            icon={<ArrowUpRight size={22}/>} 
            color="bg-emerald-600"
            filter="All"
            onNavigate={() => navigate('/search')}
          />
        </div>
      </section>

      {/* Camera Button Removed - keeping Create Post button only */}
    </div>
  );
}

// Helper function to count projects by category
function getCountByCategory(category: string): number {
  return enhancedProjects.filter((p) => p.category === category).length
}

// ============ POST CARD COMPONENT ============
function PostCard({ post }: { post: Post }) {
  const { user } = useAuth()
  const isOwnPost = !!user && user.uid === post.authorId
  const isDemo = isDemoPost(post.id)
  const [votes, setVotes] = useState({ up: post.upvotes || 0, down: post.downvotes || 0 })
  const [userVote, setUserVote] = useState<'up' | 'down' | null>(
    () => voteCache.get(post.id) ?? null,
  )
  const [voting, setVoting] = useState(false)

  // Live counts come from the Firestore snapshot — keep local state in sync.
  useEffect(() => {
    setVotes({ up: post.upvotes || 0, down: post.downvotes || 0 })
  }, [post.upvotes, post.downvotes])

  const castVote = async (choice: 'up' | 'down') => {
    if (voting) return
    const next: 'up' | 'down' | 'none' = userVote === choice ? 'none' : choice
    const prevVote = userVote
    const prevVotes = votes

    // Optimistic UI; the snapshot listener reconciles with server truth.
    setUserVote(next === 'none' ? null : next)
    setVotes(v => {
      let { up, down } = v
      if (prevVote === 'up') up -= 1
      if (prevVote === 'down') down -= 1
      if (next === 'up') up += 1
      if (next === 'down') down += 1
      return { up: Math.max(0, up), down: Math.max(0, down) }
    })

    const rememberVote = () => {
      if (next === 'none') voteCache.remove(post.id)
      else voteCache.set(post.id, next)
    }

    if (isDemo) {
      // Demo posts don't exist in Firestore — the vote stays on this device.
      rememberVote()
      return
    }

    setVoting(true)
    try {
      await voteOnCommunityPost(post.id, next)
      rememberVote()
    } catch (error) {
      console.error('Vote failed:', error)
      setUserVote(prevVote)
      setVotes(prevVotes)
    } finally {
      setVoting(false)
    }
  }

  const handleUpvote = () => castVote('up')
  const handleDownvote = () => castVote('down')

  const handleDelete = async () => {
    if (!window.confirm('Delete this post? This cannot be undone.')) return
    try {
      await deleteCommunityPost(post.id)
    } catch (error) {
      console.error('Delete failed:', error)
      alert('Could not delete the post. Please try again.')
    }
  }

  const handleReport = async () => {
    if (!user) {
      alert('Please sign in to report posts.')
      return
    }
    const reason = window.prompt('Why are you reporting this post?', 'Inappropriate content')
    if (!reason || reason.trim().length < 4) return
    try {
      await reportCommunityPost(post.id, reason.trim())
      alert('Thanks — the post was reported for review.')
    } catch (error) {
      const msg = error instanceof Error ? error.message : ''
      alert(msg.includes('already-exists') ? 'You already reported this post.' : 'Could not report the post. Please try again.')
    }
  }

  const timeAgo = (createdAt?: PostTimestamp) => {
    const postTime = createdAt?.toMillis?.()
    if (!postTime) return 'recently'
    const now = Date.now()
    const diff = now - postTime
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)
    
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return `${days}d ago`
  }

  return (
    <div className={`bg-white rounded-3xl border border-black/5 overflow-hidden hover:border-orange-200 transition-all ${post.imageData ? 'space-y-0' : 'p-5 space-y-3'}`}>
      {/* Image - If present, show at top */}
      {post.imageData && (
        <div className="relative w-full h-48 bg-stone-200 overflow-hidden">
          <img 
            src={post.imageData} 
            alt="Post image" 
            className="w-full h-full object-cover hover:scale-105 transition-transform"
          />
        </div>
      )}

      {/* Content Section */}
      <div className={post.imageData ? 'p-5 space-y-3' : ''}>
        {/* Header: Author & Category */}
        <div className="flex justify-between items-start">
          <div>
            <p className="text-xs font-black text-[#451a03] uppercase">{post.authorName || 'Citizen'}</p>
            <p className="text-[10px] text-stone-400">{post.category || 'General'} • {timeAgo(post.createdAt)}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="px-2.5 py-1 bg-orange-50 text-orange-600 text-[9px] font-black rounded-lg">
              {post.category || 'Update'}
            </span>
            {isDemo ? null : isOwnPost ? (
              <button
                onClick={handleDelete}
                aria-label="Delete your post"
                title="Delete your post"
                className="p-1.5 rounded-lg text-stone-300 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            ) : (
              <button
                onClick={handleReport}
                aria-label="Report this post"
                title="Report this post"
                className="p-1.5 rounded-lg text-stone-300 hover:text-orange-600 hover:bg-orange-50 transition-colors"
              >
                <Flag size={14} />
              </button>
            )}
          </div>
      </div>

      {/* Content: Description/Feedback */}
      <p className="text-sm leading-relaxed text-[#451a03] line-clamp-4">
        {post.content || 'No description available'}
      </p>

      {/* Actions: Vote Buttons (Equal Width) */}
      <div className="flex items-center gap-2 pt-2 border-t border-black/5">
        <button
          onClick={handleUpvote}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-black text-sm transition-all active:scale-90 ${
            userVote === 'up'
              ? 'bg-green-100 text-green-700 border-2 border-green-300'
              : 'bg-stone-100 text-stone-600 hover:bg-green-50 border-2 border-transparent'
          }`}
        >
          <ThumbsUp size={18} strokeWidth={2.5} />
          <span>{votes.up}</span>
        </button>

        <button
          onClick={handleDownvote}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-black text-sm transition-all active:scale-90 ${
            userVote === 'down'
              ? 'bg-red-100 text-red-700 border-2 border-red-300'
              : 'bg-stone-100 text-stone-600 hover:bg-red-50 border-2 border-transparent'
          }`}
        >
          <ThumbsDown size={18} strokeWidth={2.5} />
          <span>{votes.down}</span>
        </button>
      </div>
      </div>
    </div>
  )
}

// ============ CREATE POST MODAL ============
function CreatePostModal({ onClose, user }: { onClose: () => void; user: User }) {
  const [content, setContent] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('Roads')
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
      alert('Please enter your feedback')
      return
    }
    if (content.trim().length < 4) {
      alert('Feedback must be at least 4 characters')
      return
    }

    setSubmitting(true)
    try {
      await createCommunityPost(
        {
          content,
          category: selectedCategory,
          imageData: imagePreview,
        },
        user,
      )
      setContent('')
      setSelectedCategory('Roads')
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

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
      <div className="w-full bg-white rounded-t-[32px] p-6 space-y-5 max-h-[90vh] overflow-y-auto animate-in slide-in-from-bottom-5 duration-300">
        
        {/* Header */}
        <div className="space-y-2">
          <h2 className="text-2xl font-black text-[#451a03]">Create a Post</h2>
          <p className="text-sm text-stone-600">Share your feedback and experiences</p>
        </div>

        {/* Category Selector */}
        <div className="space-y-2">
          <label className="text-xs font-black text-[#451a03] uppercase">What is this about?</label>
          <div className="grid grid-cols-3 gap-2">
            {CATEGORIES.filter(c => c !== 'All Posts').map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`py-2 rounded-xl text-xs font-black transition-all ${
                  selectedCategory === cat
                    ? 'bg-orange-500 text-white'
                    : 'bg-stone-100 text-stone-600 hover:bg-orange-50'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Description Textarea */}
        <div className="space-y-2">
          <label className="text-xs font-black text-[#451a03] uppercase">Your Feedback</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Share your experience, observations, or feedback about this project... (like Reddit)"
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

// ============ PROJECT CARD COMPONENT ============
// `icon` is a rendered element (e.g. <HardHat />), not the component itself.
function ProjectCard({ title, stats, icon, color, onNavigate }: { title: string, stats: string, icon: ReactNode, color: string, filter?: string, onNavigate?: () => void }) {
  return (
    <button 
      onClick={onNavigate}
      className="flex flex-col gap-6 rounded-[32px] bg-white p-6 shadow-sm border border-black/[0.02] transition-all active:scale-95 hover:shadow-md group hover:border-orange-200 w-full text-left"
    >
      <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${color} text-white shadow-lg shadow-black/10 group-hover:rotate-6 transition-transform`}>
        {icon}
      </div>
      <div>
        <h4 className="font-black text-[#451a03] tracking-tighter text-lg leading-none mb-2">{title}</h4>
        <div className="flex items-center gap-1 text-[10px] font-bold text-neutral-400 uppercase tracking-widest">
           <ImageIcon size={10} /> {stats}
        </div>
      </div>
    </button>
  );
}