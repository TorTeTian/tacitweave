import { isAbsolute, resolve } from 'node:path'

export function resolveMemoryDirectory(configured = '.personal-model', options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const environment = options.environment ?? process.env
  const environmentValue = String(environment.TACITWEAVE_MEMORY_DIR ?? '').trim()
  const requested = environmentValue || String(configured || '.personal-model')
  return {
    path: resolve(cwd, requested),
    configured: requested,
    source: environmentValue ? 'TACITWEAVE_MEMORY_DIR' : 'configuration',
    relative: !isAbsolute(requested),
    cwd: resolve(cwd),
  }
}
