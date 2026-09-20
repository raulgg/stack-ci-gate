import fs from 'node:fs'

export function versionFromTag(tag) {
  const version = String(tag ?? '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`expected vMAJOR.MINOR.PATCH, got ${JSON.stringify(tag)}`)
  }
  return version
}

export function notesFor(changelog, tag) {
  const version = versionFromTag(tag)
  const escaped = version.replace(/\./g, '\\.')
  const heading = new RegExp(`^## \\[?${escaped}\\]?(?:\\s+-\\s+\\S.*)?$`)
  const lines = String(changelog).split(/\r?\n/)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no heading for ${version}`)
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim()
  if (!body) {
    throw new Error(`CHANGELOG.md section ${version} is empty`)
  }
  return body
}

if (import.meta.main) {
  try {
    const tag = process.argv[2]
    const changelog = fs.readFileSync('CHANGELOG.md', 'utf8')
    process.stdout.write(`${notesFor(changelog, tag)}\n`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
