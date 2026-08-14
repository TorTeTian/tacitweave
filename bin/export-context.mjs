#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

const args = parseArgs(process.argv.slice(2))
const root = resolve(args.root ?? process.cwd())
const output = resolve(args.output ?? join(root, '.personal-model', 'exports', 'current-context.md'))
const maxFileBytes = numberArg(args['max-file-bytes'], 30000)
const maxTotalBytes = numberArg(args['max-total-bytes'], 500000)
const allowedExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.sql'])
const ignoredDirs = new Set(['.git', 'node_modules', '.npm-cache', 'dist', 'build', 'coverage', '__pycache__', '.venv', 'venv', 'work', 'exports', 'policies'])
const secretNames = new Set(['.env', '.npmrc', '.pypirc', 'credentials.json', 'secrets.json'])

const files = collectFiles(root)
let used = 0
const included = []
const skipped = []

for (const file of files) {
  const rel = normalize(relative(root, file))
  const size = statSync(file).size
  if (size > maxFileBytes || used + size > maxTotalBytes) {
    skipped.push(`${rel} (${size} bytes: size limit)`)
    continue
  }
  const content = readFileSync(file, 'utf8')
  if (looksSensitive(content)) {
    skipped.push(`${rel} (possible secret)`)
    continue
  }
  used += Buffer.byteLength(content)
  included.push({ rel, content })
}

const generated = new Date().toISOString()
const body = [
  '# Project context export',
  '',
  '> Review this file before sending it to any model. The exporter excludes common secret files and suspicious token patterns, but no automatic filter is perfect.',
  '',
  `- Root: ${root}`,
  `- Generated: ${generated}`,
  `- Included files: ${included.length}`,
  `- Included bytes: ${used}`,
  `- Skipped files: ${skipped.length}`,
  '',
  '## File manifest',
  '',
  ...included.map(item => `- ${item.rel}`),
  '',
  ...(skipped.length ? ['## Skipped', '', ...skipped.map(item => `- ${item}`), ''] : []),
  '## Contents',
  '',
  ...included.flatMap(item => [
    `### ${item.rel}`,
    '',
    `\`\`\`${fenceLanguage(item.rel)}`,
    escapeFence(item.content),
    '```',
    '',
  ]),
].join('\n')

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, body, 'utf8')
console.log(output)

function collectFiles(dir) {
  const result = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) result.push(...collectFiles(path))
      continue
    }
    if (secretNames.has(entry.name) || entry.name.endsWith('.key') || entry.name.endsWith('.pem')) continue
    if (allowedExtensions.has(extname(entry.name).toLowerCase()) || entry.name === 'Dockerfile') result.push(path)
  }
  return result.sort()
}

function looksSensitive(text) {
  return /(sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{16,})/i.test(text)
}

function escapeFence(text) { return text.replaceAll('```', '``\u200b`') }
function normalize(path) { return path.replaceAll('\\', '/') }
function fenceLanguage(path) { return extname(path).slice(1).replace('mjs', 'js').replace('yml', 'yaml') }
function numberArg(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback }

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key?.startsWith('--')) continue
    parsed[key.slice(2)] = argv[i + 1]
    i += 1
  }
  return parsed
}
