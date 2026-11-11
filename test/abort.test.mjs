import assert from 'node:assert/strict'
import test from 'node:test'
import { anySignal, timeoutSignal } from '../src/abort.mjs'

test('anySignal aborts with the first signal reason and cleans up listeners', () => {
  const first = new AbortController()
  const second = new AbortController()
  const combined = anySignal([first.signal, second.signal])
  const reason = new Error('cancelled')
  first.abort(reason)
  assert.equal(combined.aborted, true)
  assert.equal(combined.reason, reason)
  second.abort(new Error('late'))
  assert.equal(combined.reason, reason)
})

test('anySignal accepts an already-aborted signal', () => {
  const original = new AbortController()
  original.abort(new Error('already'))
  const combined = anySignal([original.signal])
  assert.equal(combined.aborted, true)
  assert.equal(combined.reason.message, 'already')
})

test('timeoutSignal aborts with a TimeoutError and follows the caller signal', async () => {
  const timed = timeoutSignal(undefined, 5)
  await new Promise((resolve) => timed.addEventListener('abort', resolve, { once: true }))
  assert.equal(timed.reason.name, 'TimeoutError')

  const caller = new AbortController()
  const combined = timeoutSignal(caller.signal, 10_000)
  caller.abort(new Error('stop'))
  assert.equal(combined.aborted, true)
  assert.equal(combined.reason.message, 'stop')
})
