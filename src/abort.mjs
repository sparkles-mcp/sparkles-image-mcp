/**
 * AbortSignal.any() needs Node 20.3+, but the package supports Node 20.0.
 * Compose signals with the same abort reason and release listeners eagerly.
 */
export function anySignal(signals) {
  const controller = new AbortController()
  const listeners = []
  const cleanup = () => {
    for (const [signal, handler] of listeners)
      signal.removeEventListener('abort', handler)
    listeners.length = 0
  }
  const abort = (reason) => {
    if (controller.signal.aborted) return
    controller.abort(reason)
    cleanup()
  }
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      abort(signal.reason)
      break
    }
    const handler = () => abort(signal.reason)
    signal.addEventListener('abort', handler, { once: true })
    listeners.push([signal, handler])
  }
  return controller.signal
}

export function timeoutSignal(signal, timeout) {
  const timer = new AbortController()
  const timerId = setTimeout(
    () => timer.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    timeout
  )
  timerId.unref?.()
  const combined = anySignal(signal ? [signal, timer.signal] : [timer.signal])
  combined.addEventListener('abort', () => clearTimeout(timerId), { once: true })
  return combined
}
