#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { buildSourceEnvelope, extractCandidates, parseImportedContent } from '../src/weavespec.js'
import { resolveMemoryDirectory } from '../src/paths.js'

const args = parseArgs(process.argv.slice(2))
if (!args.input) fail('Usage: weave-ingest --input <path> [--format auto|chatgpt|jsonl|json|markdown] [--memory-dir .personal-model]')

const inputPath = resolve(args.input)
const memoryResolution = resolveMemoryDirectory(args['memory-dir'] ?? '.personal-model')
const memoryDir = memoryResolution.path
const text = readFileSync(inputPath, 'utf8')
const parsed = parseImportedContent(text, args.format ?? 'auto', inputPath)
const source = buildSourceEnvelope({ messages: parsed.messages, format: parsed.format, inputPath })
let batch = extractCandidates(source)
const sourcePath = join(memoryDir, 'sources', `${source.source_id}.json`)
const priorBatchPath = findBatchForSource(join(memoryDir, 'candidates'), source.source_id)
const candidatePath = priorBatchPath ?? join(memoryDir, 'candidates', `${batch.batch_id}.json`)

writeJson(sourcePath, source)
if (priorBatchPath) batch = JSON.parse(readFileSync(priorBatchPath, 'utf8'))
else writeJson(candidatePath, batch)

console.log(JSON.stringify({
  format: parsed.format,
  source_id: source.source_id,
  user_messages: source.messages.length,
  candidates: batch.candidates.length,
  source_file: sourcePath,
  candidate_file: candidatePath,
  memory_dir: memoryDir,
  memory_dir_source: memoryResolution.source,
  relative_memory_dir_warning: memoryResolution.relative
    ? 'This path was resolved against the CLI working directory. Use --memory-dir with an absolute path or set TACITWEAVE_MEMORY_DIR to share memory with DSH.'
    : null,
  already_imported: Boolean(priorBatchPath),
  personal_model_changed: false,
}, null, 2))

function findBatchForSource(dir, sourceId) {
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir).filter(item => item.endsWith('.json')).sort()) {
    const path = join(dir, name)
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).source_id === sourceId) return path
    } catch {}
  }
  return null
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    parsed[argv[i].slice(2)] = argv[i + 1]
    i += 1
  }
  return parsed
}
