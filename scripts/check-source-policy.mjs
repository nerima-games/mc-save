import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const rawClockRead = /\b(?:Date\.now|performance\.now)\s*\(|\bnew\s+Date\s*\(/u
const sourceFiles = []

const collectSourceFiles = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) collectSourceFiles(path)
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) sourceFiles.push(path)
  }
}

collectSourceFiles(sourceRoot)

const violations = sourceFiles.flatMap((path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      rawClockRead.test(line)
        ? [{ path: relative(process.cwd(), path), line: index + 1, text: line.trim() }]
        : [],
    ),
)

if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(
      `${violation.path}:${violation.line}: raw wall-clock access is not allowed in production source: ${violation.text}`,
    )
  }
  process.exitCode = 1
} else {
  process.stdout.write(`source policy passed: ${sourceFiles.length} production files scanned\n`)
}
