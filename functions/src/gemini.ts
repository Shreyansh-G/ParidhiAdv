// Gemini provider adapter — the free-tier path for Paridhi's AI features.
//
// Uses the official @google/genai SDK with `gemini-flash-latest` (an alias
// that always tracks the current Flash model, so model retirements don't
// break us). Two entry points mirroring what ai.ts needs:
//   geminiToolChat — agentic function-calling loop over the same tool objects
//                    the Anthropic tool runner uses
//   geminiJson     — single structured-output call (moderation, insights)

import { GoogleGenAI, type Content, type Part } from '@google/genai'
import { logger } from 'firebase-functions'

// Free-tier daily quotas are PER MODEL, so the model choice matters a lot:
// gemini-flash-latest → 3.5-flash (only 20 req/day free) vs flash-lite (much higher).
// Override with GEMINI_MODEL in functions/.env without a code change.
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest'
const MAX_TOOL_ITERATIONS = 6

/** Free-tier Gemini throws transient 503 "high demand" / network errors — retry those. */
function isTransient(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  // A blown per-day quota won't recover within our backoff window — fail fast.
  if (msg.includes('PerDay')) return false
  return (
    msg.includes('fetch failed') ||
    msg.includes('"code":503') ||
    msg.includes('"code":429') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT')
  )
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delaysMs = [1000, 3000, 7000]
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= delaysMs.length || !isTransient(error)) throw error
      logger.warn(`Gemini transient error — retrying ${label}`, {
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      })
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]))
    }
  }
}

/**
 * Structural view of the Anthropic betaTool objects — lets us reuse them.
 * NOTE: betaTool() takes `inputSchema` but the object it RETURNS carries the
 * wire-format `input_schema` — accept both so either shape works.
 */
export interface SimpleTool {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  input_schema?: Record<string, unknown>
  run: (input: unknown) => string | Promise<string>
}

function toolSchema(tool: SimpleTool): Record<string, unknown> {
  return tool.inputSchema ?? tool.input_schema ?? { type: 'object', properties: {} }
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Gemini's JSON-schema support rejects some keywords — strip them deeply. */
function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
  const strip = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(strip)
      return
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      delete obj.additionalProperties
      Object.values(obj).forEach(strip)
    }
  }
  strip(clone)
  return clone
}

function toContents(history: ChatTurn[]): Content[] {
  return history.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }))
}

/**
 * Agentic chat: model ↔ tool loop until Gemini stops requesting functions
 * (or the iteration cap). Tool failures are fed back as error results so the
 * model can recover.
 */
export async function geminiToolChat(options: {
  apiKey: string
  system: string
  history: ChatTurn[]
  tools: SimpleTool[]
}): Promise<string> {
  const { apiKey, system, history, tools } = options
  const ai = new GoogleGenAI({ apiKey })

  const functionDeclarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: sanitizeSchema(toolSchema(tool)),
  }))
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))

  const contents: Content[] = toContents(history)

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await withRetry('tool chat', () =>
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations }],
        },
      }),
    )

    const calls = response.functionCalls
    if (!calls || calls.length === 0) {
      return (response.text ?? '').trim()
    }

    // Echo the model turn (with its function calls), then answer each call.
    const modelContent = response.candidates?.[0]?.content
    contents.push(modelContent ?? { role: 'model', parts: calls.map((c) => ({ functionCall: c })) })

    const responseParts: Part[] = []
    for (const call of calls) {
      const tool = call.name ? toolsByName.get(call.name) : undefined
      let result: string
      if (!tool) {
        result = JSON.stringify({ error: `Unknown tool: ${call.name}` })
      } else {
        try {
          result = await tool.run(call.args ?? {})
        } catch (error) {
          logger.warn('Gemini tool execution failed', {
            tool: call.name,
            error: error instanceof Error ? error.message : String(error),
          })
          result = JSON.stringify({ error: 'Tool execution failed — answer without it.' })
        }
      }
      responseParts.push({
        functionResponse: { name: call.name ?? 'unknown', response: { result } },
      })
    }
    contents.push({ role: 'user', parts: responseParts })
  }

  // Iteration cap reached — ask for a final answer without tools.
  const finalResponse = await withRetry('final answer', () =>
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: { systemInstruction: system },
    }),
  )
  return (finalResponse.text ?? '').trim()
}

/** Single structured-output call; returns the parsed JSON object. */
export async function geminiJson<T>(options: {
  apiKey: string
  system: string
  user: string
  schema: unknown
}): Promise<T> {
  const { apiKey, system, user, schema } = options
  const ai = new GoogleGenAI({ apiKey })

  const response = await withRetry('structured output', () =>
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseJsonSchema: sanitizeSchema(schema),
      },
    }),
  )

  const text = (response.text ?? '').trim()
  if (!text) {
    throw new Error(`Gemini returned no text (finishReason: ${response.candidates?.[0]?.finishReason ?? 'unknown'})`)
  }
  return JSON.parse(text) as T
}
