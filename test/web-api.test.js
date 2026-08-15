import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { MemoryStore } from '../src/store.js'
import { applyAction, registerMemoryDashboardApi } from '../src/web-api.js'
import { createCalibrationCandidate } from '../src/weavespec.js'

test('dashboard actions validate writes and use the store review path', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-api-'))
  try {
    const store = new MemoryStore(root, { projectId: 'alpha' })
    const candidate = createCalibrationCandidate({
      correction: '插件制作先给计划再持续执行。', policy: { riskLevel: 'low' }, projectId: 'alpha',
    })
    store.saveCandidate(candidate)
    applyAction(store, { action: 'update_controls', patch: { ask_before_activation: false, activation_threshold: 0.8 } })
    assert.equal(store.readControls().ask_before_activation, false)
    assert.equal(store.readControls().activation_threshold, 0.8)
    applyAction(store, { action: 'set_memory_enabled', kind: 'temporary', id: candidate.id, enabled: false })
    assert.equal(store.dashboardState().temporary[0].enabled, false)
    applyAction(store, { action: 'review_temporary', id: candidate.id, decision: 'accept' })
    assert.equal(store.dashboardState().long_term.length, 1)
    assert.throws(() => applyAction(store, { action: 'review_temporary', id: candidate.id, decision: 'erase' }), /Invalid review decision/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboard HTTP route rejects remote and cross-origin access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-api-'))
  try {
    const store = new MemoryStore(root)
    let route
    registerMemoryDashboardApi({ webServer: { register(value) { route = value; return () => {} } } }, store)
    const remote = await invoke(route, { method: 'GET', address: '192.0.2.10' })
    assert.equal(remote.status, 403)
    const crossOrigin = await invoke(route, {
      method: 'POST', address: '127.0.0.1', host: '127.0.0.1:3080', origin: 'http://evil.example',
      body: JSON.stringify({ action: 'update_controls', patch: { enabled: false } }),
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal(store.readControls().enabled, true)
    const sameOrigin = await invoke(route, {
      method: 'POST', address: '::1', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080',
      body: JSON.stringify({ action: 'update_controls', patch: { ask_before_activation: false } }),
    })
    assert.equal(sameOrigin.status, 200)
    assert.equal(store.readControls().ask_before_activation, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

async function invoke(route, options) {
  const request = Readable.from(options.body ? [Buffer.from(options.body)] : [])
  request.method = options.method
  request.socket = { remoteAddress: options.address }
  request.headers = { host: options.host, origin: options.origin }
  const response = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body },
  }
  await route.handler(request, response)
  return { status: response.statusCode, body: JSON.parse(response.body), headers: response.headers }
}
