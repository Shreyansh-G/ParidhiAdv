import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { Sparkles, SendHorizontal, X, Trash2 } from 'lucide-react'
import { firebaseFunctions } from '../lib/firebase'
import { useAuth } from '../context/AuthContext'

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

const STORAGE_KEY = 'paridhi:assistant:chat:v1'

const STARTERS = [
  'Top ongoing projects near me',
  'What are citizens saying?',
  'How is my exploration progress?',
  'मेट्रो प्रोजेक्ट्स के बारे में बताओ',
]

function loadChat(): ChatTurn[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as ChatTurn[]
  } catch {
    // ignore storage errors
  }
  return []
}

// The model replies in light markdown (**bold**, * bullets, ## headings) —
// render it as clean text instead of showing raw asterisks.
function formatAssistantText(text: string) {
  const lines = text.split('\n')
  return lines.map((rawLine, i) => {
    let line = rawLine.replace(/^#{1,4}\s*/, '')
    const isBullet = /^\s*[*•-]\s+/.test(line)
    if (isBullet) line = line.replace(/^\s*[*•-]\s+/, '')
    const parts = line.split(/\*\*(.+?)\*\*/g).map((segment, j) =>
      j % 2 === 1 ? (
        <strong key={j} className="font-bold">
          {segment}
        </strong>
      ) : (
        segment.replace(/\*(.+?)\*/g, '$1')
      ),
    )
    return (
      <span key={i} className={isBullet ? 'block pl-3' : undefined}>
        {isBullet ? '• ' : ''}
        {parts}
        {!isBullet && i < lines.length - 1 ? '\n' : ''}
      </span>
    )
  })
}

export function CivicAssistant() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatTurn[]>(loadChat)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slowHint, setSlowHint] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // If a reply takes more than a few seconds, explain why instead of hanging
  // silently behind three dots (cold start + live tool calls).
  useEffect(() => {
    if (!loading) {
      setSlowHint(false)
      return
    }
    const timer = setTimeout(() => setSlowHint(true), 4000)
    return () => clearTimeout(timer)
  }, [loading])

  // Hand focus back after each reply so the conversation flows.
  useEffect(() => {
    if (open && !loading) inputRef.current?.focus()
  }, [open, loading])

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-24)))
    } catch {
      // ignore storage errors
    }
  }, [messages])

  useEffect(() => {
    if (open) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, loading, open])

  // Best-effort GPS fix so "near me" questions work — resolves null quickly if
  // permission is missing or the fix is slow (never blocks the chat).
  const getLocation = () =>
    new Promise<{ lat: number; lng: number } | null>((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null)
      const timer = setTimeout(() => resolve(null), 2500)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer)
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        },
        () => {
          clearTimeout(timer)
          resolve(null)
        },
        { maximumAge: 300000, timeout: 2000 },
      )
    })

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || loading || !firebaseFunctions) return

    const nextMessages: ChatTurn[] = [...messages, { role: 'user', content }]
    setMessages(nextMessages)
    setInput('')
    setError(null)
    setLoading(true)

    try {
      const location = await getLocation()
      // Bound the wait — never leave the chat frozen behind a hung request.
      const ask = httpsCallable<
        { messages: ChatTurn[]; location?: { lat: number; lng: number } },
        { reply: string }
      >(firebaseFunctions, 'askCivicAssistant', { timeout: 60000 })
      const result = await ask({
        messages: nextMessages.slice(-12),
        ...(location ? { location } : {}),
      })
      const reply = result.data?.reply?.trim()
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: reply || 'Sorry, I could not answer that. Try again?' },
      ])
    } catch (err) {
      console.error('Assistant call failed', err)
      const msg = err instanceof Error ? err.message : ''
      setError(
        msg.includes('unauthenticated')
          ? 'Please sign in to use the assistant.'
          : msg.includes('deadline-exceeded') || msg.includes('timeout')
            ? 'That took too long — the servers may be waking up. Ask again, it will be faster now.'
            : 'The assistant is unavailable right now. Please try again in a moment.',
      )
    } finally {
      setLoading(false)
    }
  }

  const clearChat = () => {
    setMessages([])
    setError(null)
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore storage errors
    }
  }

  return (
    <>
      {/* Floating launcher — mirrors BottomNav's fixed max-w-md pattern */}
      {!open && (
        <div className="pointer-events-none fixed bottom-24 left-0 right-0 z-40 mx-auto flex w-full max-w-md justify-end px-5">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open Civic Assistant"
            className="pointer-events-auto flex h-13 items-center gap-2 rounded-full bg-gradient-to-br from-orange-500 to-orange-600 px-4 py-3 text-white shadow-[0_12px_30px_rgba(234,88,12,0.4)] transition-transform active:scale-95"
          >
            <Sparkles className="h-5 w-5" />
            <span className="text-sm font-semibold">Ask AI</span>
          </button>
        </div>
      )}

      {/* Chat panel — floating widget sized to the window, clears the bottom nav */}
      {open && (
        <div className="fixed inset-x-0 bottom-24 z-50 mx-auto w-full max-w-md px-3">
          <div className="flex h-[min(600px,calc(100dvh-8.5rem))] w-full flex-col overflow-hidden rounded-3xl border border-orange-200 bg-[#fff7f0] shadow-[0_20px_60px_rgba(69,26,3,0.3)]">
          {/* Header */}
          <div className="flex items-center justify-between bg-gradient-to-r from-orange-500 to-orange-600 px-4 py-3 text-white shadow-md">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              <div>
                <p className="text-sm font-bold leading-tight">Civic Assistant</p>
                <p className="text-[11px] leading-tight text-orange-100">
                  Knows Delhi projects, the feed & your progress
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={clearChat}
                  aria-label="Clear chat"
                  className="rounded-full p-2 transition-colors hover:bg-white/15"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                className="rounded-full p-2 transition-colors hover:bg-white/15"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="space-y-3 pt-6 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-100">
                  <Sparkles className="h-7 w-7 text-orange-500" />
                </div>
                <p className="text-sm font-semibold text-neutral-800">
                  Namaste! Ask me anything about Delhi's infrastructure.
                </p>
                <p className="px-6 text-xs text-neutral-500">
                  I can search live projects, summarize what citizens are posting, and track your
                  exploration progress. English या हिंदी — दोनों चलेंगे!
                </p>
                <div className="flex flex-wrap justify-center gap-2 px-2 pt-2">
                  {STARTERS.map((starter) => (
                    <button
                      key={starter}
                      onClick={() => send(starter)}
                      className="rounded-full border border-orange-200 bg-white px-3 py-1.5 text-xs font-medium text-orange-700 transition-colors active:bg-orange-50"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((turn, index) => (
              <div
                key={index}
                className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                    turn.role === 'user'
                      ? 'rounded-br-md bg-orange-500 text-white'
                      : 'rounded-bl-md border border-orange-100 bg-white text-neutral-800 shadow-sm'
                  }`}
                >
                  {turn.role === 'assistant' ? formatAssistantText(turn.content) : turn.content}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex flex-col items-start gap-1.5">
                <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-orange-100 bg-white px-4 py-3 shadow-sm">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400 [animation-delay:-0.3s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400 [animation-delay:-0.15s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400" />
                </div>
                {slowHint && (
                  <p className="pl-1 text-[11px] text-neutral-400">
                    Searching live project data… the first reply can take ~15s.
                  </p>
                )}
              </div>
            )}

            {error && (
              <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-center text-xs text-red-600">
                {error}
              </p>
            )}
          </div>

          {/* Input bar / sign-in gate */}
          {user ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                send(input)
              }}
              className="flex items-center gap-2 border-t border-orange-100 bg-white px-3 py-3"
            >
              <input
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={loading ? 'Thinking… you can type your next question' : 'Ask about projects, posts, progress…'}
                maxLength={2000}
                autoFocus
                className="flex-1 rounded-full border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm outline-none focus:border-orange-400"
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                aria-label="Send"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-500 text-white transition-all active:scale-95 disabled:opacity-40"
              >
                <SendHorizontal className="h-4 w-4" />
              </button>
            </form>
          ) : (
            <div className="border-t border-orange-100 bg-white px-4 py-4 text-center">
              <p className="mb-2 text-sm text-neutral-600">Sign in to chat with the assistant.</p>
              <button
                onClick={() => {
                  setOpen(false)
                  navigate('/profile')
                }}
                className="rounded-full bg-orange-500 px-5 py-2 text-sm font-semibold text-white active:scale-95"
              >
                Sign in
              </button>
            </div>
          )}
          </div>
        </div>
      )}
    </>
  )
}
