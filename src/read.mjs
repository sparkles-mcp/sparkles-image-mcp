// Shared by the API client and the OAuth client so every response body has a
// hard memory ceiling, including metadata and token responses.
export async function readCapped(response, max) {
  const length = Number(response.headers.get('content-length') || 0)
  if (length > max) {
    await response.body?.cancel()
    return { tooLarge: true, buffer: null }
  }
  if (!response.body) return { tooLarge: false, buffer: Buffer.alloc(0) }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > max) {
        await reader.cancel()
        return { tooLarge: true, buffer: null }
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return { tooLarge: false, buffer: Buffer.concat(chunks) }
}
