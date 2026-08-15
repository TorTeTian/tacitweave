import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('project context export excludes the complete private model directory and absolute root', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-export-'))
  try {
    const privateDir = join(root, '.personal-model')
    mkdirSync(privateDir, { recursive: true })
    writeFileSync(join(root, 'README.md'), '# Public project\n', 'utf8')
    writeFileSync(join(privateDir, 'personal_model.json'), '{"private":"DO_NOT_EXPORT"}\n', 'utf8')
    writeFileSync(join(privateDir, 'personal_model.pre-weavespec-v0.1.json'), '{"private":"OLD_PRIVATE_DATA"}\n', 'utf8')
    const output = join(root, 'context.md')
    const run = spawnSync(process.execPath, [resolve('bin/export-context.mjs'), '--root', root, '--output', output], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const exported = readFileSync(output, 'utf8')
    assert.match(exported, /# Public project/)
    assert.doesNotMatch(exported, /DO_NOT_EXPORT|OLD_PRIVATE_DATA|personal_model/)
    assert.doesNotMatch(exported, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
