// Client-side image compression for community posts.
//
// Posts store images as base64 data-URLs inside the Firestore document, which
// has a hard 1 MB limit — so a raw phone photo must be shrunk before saving.
// Target: ≤ ~200 KB. Strategy: downscale to a max dimension, then walk the
// quality ladder (WebP first, JPEG fallback for browsers whose canvas cannot
// encode WebP) until the encoded size fits.

const MAX_DIMENSION = 1280
const TARGET_CHARS = 280_000 // ~210 KB of base64 → well under the rules cap
const QUALITY_LADDER = [0.8, 0.65, 0.5, 0.35, 0.25]

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read the image file.'))
    }
    img.src = url
  })
}

/**
 * Compress an image file to a base64 data-URL small enough for a Firestore
 * post document. Throws if the file is not an image or cannot be encoded
 * under the target size even at minimum quality.
 */
export async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file.')
  }

  const img = await loadImage(file)
  const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height))
  const width = Math.max(1, Math.round(img.width * scale))
  const height = Math.max(1, Math.round(img.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Image processing is not supported on this device.')
  ctx.drawImage(img, 0, 0, width, height)

  for (const format of ['image/webp', 'image/jpeg'] as const) {
    for (const quality of QUALITY_LADDER) {
      const dataUrl = canvas.toDataURL(format, quality)
      // Browsers that can't encode the requested format silently return PNG.
      if (!dataUrl.startsWith(`data:${format}`)) break
      if (dataUrl.length <= TARGET_CHARS) return dataUrl
    }
  }

  throw new Error('This image is too detailed to compress — try a smaller photo.')
}
