// Makes a Syrphidae of Italy (SoI) data release, straight from TaxonWorks.
//
//   node scripts/release.mjs [version]
//
// Fetches (public project token, read only):
//   - every taxon name (valid names, synonyms, combinations)        /taxon_names
//   - every reference in the project                                 /sources
//   - the latest Darwin Core archive of the occurrences (same as GBIF) /downloads
// and writes, for the new version (e.g. 2026.1, made automatically when not given):
//   releases/<version>/names.csv                    every name (also used to compare with the next release)
//   releases/<version>/references.csv               every reference
//   releases/<version>/SoI-<version>-occurrences-dwca.zip   the occurrence archive
//   releases/<version>/stats.json                   counts and the changes since the previous release
//   releases/<version>/notes.md                     release notes
// and updates releases.json (newest first; the SoI website reads it) and CHANGELOG.md.
//
// With SKIP_IF_UNCHANGED=1 (scheduled runs) nothing is written when names and records are unchanged.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const API = 'https://sfg.taxonworks.org/api/v1'
const TOKEN = 'pfqGdynettFI9-mB48_oGQ' // public SoI project token (read only)
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const today = new Date().toISOString().slice(0, 10)

// ---------- TaxonWorks ----------
async function getJSON(path, params = {}) {
  const u = new URL(API + path)
  u.searchParams.set('project_token', TOKEN)
  for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) u.searchParams.append(k, x)
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(u)
    if (r.ok) return { data: await r.json(), headers: r.headers }
    if (attempt >= 3) throw new Error(`${r.status} for ${path}`)
    await new Promise((res) => setTimeout(res, 3000 * attempt))
  }
}
async function getAll(path, params = {}) {
  const out = []
  for (let page = 1; ; page++) {
    const { data, headers } = await getJSON(path, { ...params, per: 1000, page })
    out.push(...data)
    if (page >= Number(headers.get('pagination-total-pages') || 1)) return out
  }
}

// ---------- CSV ----------
const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCSV = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n'
function fromCSV(text) {
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const head = rows.shift() || []
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}
const strip = (html = '') => String(html).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()

// ---------- releases so far ----------
const releasesFile = join(ROOT, 'releases.json')
const releases = existsSync(releasesFile) ? JSON.parse(readFileSync(releasesFile, 'utf8')) : []
const previous = releases[0]
const year = today.slice(0, 4)
const version =
  (process.argv[2] || '').trim() ||
  `${year}.${releases.filter((r) => String(r.version).startsWith(year + '.')).length + 1}`
if (releases.some((r) => r.version === version)) {
  console.error(`Release ${version} already exists.`)
  process.exit(1)
}

// ---------- names ----------
console.error('Fetching names…')
const all = await getAll('/taxon_names')
const byId = new Map(all.map((n) => [n.id, n]))
function ancestor(n, rank) {
  let cur = n
  const seen = new Set()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.rank === rank) return cur.cached || cur.name
    cur = byId.get(cur.parent_id)
  }
  return ''
}
// only hoverflies: the project also holds the plants, prey, hosts and parasitoids of the
// biological associations, which are not part of the catalogue
const FAMILY = 'Syrphidae'
const inFamily = (n) => {
  const valid = byId.get(n.cached_valid_taxon_name_id) || n
  return n.cached === FAMILY || ancestor(valid, 'family') === FAMILY || ancestor(n, 'family') === FAMILY
}
const protonyms = all.filter((n) => n.type === 'Protonym' && n.rank_string !== 'NomenclaturalRank' && n.cached && inFamily(n))
const names = protonyms.map((n) => {
  const valid = byId.get(n.cached_valid_taxon_name_id) || n
  return {
    id: n.id,
    name: n.cached,
    authorship: n.cached_author_year || '',
    rank: n.rank || '',
    status: n.cached_is_valid ? 'valid' : n.cached_is_available === false ? 'unavailable' : 'invalid',
    valid_name: n.cached_is_valid ? '' : valid.cached || '',
    original_combination: n.cached_original_combination || '',
    subfamily: ancestor(valid, 'subfamily'),
    genus: valid.rank === 'genus' ? valid.cached : ancestor(valid, 'genus'),
    year: n.year || ''
  }
})
names.sort((a, b) => a.name.localeCompare(b.name))
const isSp = (r) => r.rank === 'species'
const counts = {
  subfamilies: names.filter((r) => r.rank === 'subfamily' && r.status === 'valid').length,
  genera: names.filter((r) => r.rank === 'genus' && r.status === 'valid').length,
  species: names.filter((r) => isSp(r) && r.status === 'valid').length,
  subspecies: names.filter((r) => r.rank === 'subspecies' && r.status === 'valid').length,
  invalid_names: names.filter((r) => r.status !== 'valid').length,
  combinations: all.filter((n) => n.type === 'Combination' && inFamily(n)).length
}
const perSubfamily = {}
for (const r of names) {
  if (r.status !== 'valid' || !['genus', 'species'].includes(r.rank)) continue
  const k = r.subfamily || '(no subfamily)'
  perSubfamily[k] ||= { genera: 0, species: 0 }
  perSubfamily[k][r.rank === 'genus' ? 'genera' : 'species']++
}

// ---------- the other taxa: plants, prey, hosts and parasitoids of the associations ----------
const associatedTaxa = all
  .filter((n) => n.type === 'Protonym' && n.rank_string !== 'NomenclaturalRank' && n.cached && !inFamily(n))
  .map((n) => {
    const valid = byId.get(n.cached_valid_taxon_name_id) || n
    return {
      id: n.id,
      name: n.cached,
      authorship: n.cached_author_year || '',
      rank: n.rank || '',
      status: n.cached_is_valid ? 'valid' : n.cached_is_available === false ? 'unavailable' : 'invalid',
      valid_name: n.cached_is_valid ? '' : valid.cached || '',
      family: valid.rank === 'family' ? valid.cached : ancestor(valid, 'family'),
      order: ancestor(valid, 'order')
    }
  })
  .sort((a, b) => a.name.localeCompare(b.name))
counts.associated_taxa = associatedTaxa.filter((r) => r.status === 'valid').length

// ---------- biological associations ----------
console.error('Fetching biological associations…')
const bas = await getAll('/biological_associations', {
  'extend[]': ['subject', 'object', 'biological_relationship', 'taxonomy', 'citations', 'source']
})
const side = (o = {}) => ({ name: o.object_label || '', family: o.taxonomy?.family || '', order: o.taxonomy?.order || '' })
const associations = bas
  .map((a) => {
    const sub = side(a.subject)
    const obj = side(a.object)
    const cits = a.citations || []
    return {
      id: a.id,
      subject: sub.name,
      subject_family: sub.family,
      subject_order: sub.order,
      relationship: a.biological_relationship?.name || '',
      object: obj.name,
      object_family: obj.family,
      object_order: obj.order,
      references: cits.map((c) => c.citation_source_body).filter(Boolean).join(' | '),
      reference_ids: cits.map((c) => c.source_id).filter(Boolean).join(' | ')
    }
  })
  .sort((a, b) => a.subject.localeCompare(b.subject) || a.object.localeCompare(b.object))
counts.associations = associations.length
const byRelationship = {}
for (const a of associations) byRelationship[a.relationship] = (byRelationship[a.relationship] || 0) + 1

// ---------- references ----------
console.error('Fetching references…')
const sources = await getAll('/sources', { in_project: 'true' })
const references = sources
  .map((s) => ({ id: s.id, year: s.year || '', citation: strip(s.cached), doi: s.doi || '', url: s.url || '' }))
  .sort((a, b) => a.citation.localeCompare(b.citation))
counts.references = references.length

// ---------- occurrences (the Darwin Core archive TaxonWorks makes for GBIF) ----------
console.error('Fetching the occurrence archive…')
const { data: downloads } = await getJSON('/downloads')
const dwca = downloads
  .filter((d) => /DwcArchive::Complete/.test(d.type))
  .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
let occ = { records: 0 }
let zipBuf = null
if (dwca) {
  const r = await fetch(`${dwca.file}?project_token=${TOKEN}`)
  if (!r.ok) throw new Error(`Archive download failed: ${r.status}`)
  zipBuf = Buffer.from(await r.arrayBuffer())
  const tmp = join(tmpdir(), `soi-dwca-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'a.zip'), zipBuf)
  execFileSync('unzip', ['-o', '-q', join(tmp, 'a.zip'), '-d', tmp])
  // the core file and its columns, as meta.xml describes them
  const metaPath = join(tmp, 'meta.xml')
  const meta = existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : ''
  const core = (meta.match(/<core[\s\S]*?<\/core>/) || [''])[0]
  const loc = (core.match(/<location>\s*([^<]+?)\s*<\/location>/) || [])[1]
  const sep = (core.match(/fieldsTerminatedBy="([^"]*)"/) || [, '\\t'])[1].replace('\\t', '\t')
  const skip = Number((core.match(/ignoreHeaderLines="(\d+)"/) || [, '1'])[1])
  const metaCols = []
  for (const m of core.matchAll(/<field\s+index="(\d+)"\s+term="[^"]*\/([^"/]+)"/g)) metaCols[Number(m[1])] = m[2]
  const file = [loc, 'occurrence.txt', 'occurrence.tsv', 'occurrence.csv', 'data.tsv'].filter(Boolean).map((f) => join(tmp, f)).find(existsSync)
  if (file) {
    const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
    const first = lines[0].split(sep)
    const head = metaCols.length ? first.map((h, i) => metaCols[i] || h) : first
    lines.splice(0, skip)
    const col = (n) => head.indexOf(n)
    const [cB, cS, cLat, cY, cSp, cFam] = ['basisOfRecord', 'scientificName', 'decimalLatitude', 'year', 'specificEpithet', 'family'].map(col)
    const basis = {}
    const taxa = new Set()
    let georef = 0, others = 0, minY = Infinity, maxY = -Infinity
    for (const l of lines) {
      const c = l.split(sep)
      if (cFam >= 0 && c[cFam] && c[cFam] !== FAMILY) { others++; continue }
      basis[c[cB] || 'unknown'] = (basis[c[cB] || 'unknown'] || 0) + 1
      if (cSp >= 0 && c[cSp]) taxa.add(c[cS])
      if (cLat >= 0 && c[cLat]) georef++
      const y = Number(c[cY])
      if (y > 1000) { minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    }
    occ = {
      records: lines.length - others,
      other_records_in_archive: others,
      georeferenced: georef,
      species_with_records: taxa.size,
      by_basis_of_record: basis,
      years: Number.isFinite(minY) ? [minY, maxY] : null,
      archive_date: dwca.created_at.slice(0, 10)
    }
  }
  rmSync(tmp, { recursive: true, force: true })
}
counts.occurrences = occ.records

// ---------- changes since the previous release ----------
let changes = null
if (previous) {
  const prevFile = join(ROOT, 'releases', previous.version, 'names.csv')
  const prev = existsSync(prevFile) ? fromCSV(readFileSync(prevFile, 'utf8')) : []
  const prevById = new Map(prev.map((r) => [String(r.id), r]))
  const nowById = new Map(names.map((r) => [String(r.id), r]))
  const pick = (r) => ({ id: Number(r.id), name: r.name, authorship: r.authorship, rank: r.rank })
  changes = {
    added: names.filter((r) => !prevById.has(String(r.id))).map(pick),
    removed: prev.filter((r) => !nowById.has(String(r.id))).map(pick),
    status: [],
    combination: []
  }
  for (const r of names) {
    const p = prevById.get(String(r.id))
    if (!p) continue
    if (p.status !== r.status || (r.status !== 'valid' && p.valid_name !== r.valid_name))
      changes.status.push({ ...pick(r), from: p.status, to: r.status, valid_name: r.valid_name })
    else if (p.name !== r.name) changes.combination.push({ ...pick(r), from: p.name })
  }
  const unchanged =
    !changes.added.length && !changes.removed.length && !changes.status.length && !changes.combination.length &&
    previous.counts?.occurrences === counts.occurrences && previous.counts?.references === counts.references && previous.counts?.associations === counts.associations
  if (unchanged && process.env.SKIP_IF_UNCHANGED === '1') {
    console.error('Nothing changed since the last release: no release made.')
    writeFileSync(join(ROOT, '.release-skip'), '1')
    process.exit(0)
  }
}

// ---------- write ----------
const dir = join(ROOT, 'releases', version)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'names.csv'), toCSV(names, ['id', 'name', 'authorship', 'rank', 'status', 'valid_name', 'original_combination', 'subfamily', 'genus', 'year']))
writeFileSync(join(dir, 'associations.csv'), toCSV(associations, ['id', 'subject', 'subject_family', 'subject_order', 'relationship', 'object', 'object_family', 'object_order', 'references', 'reference_ids']))
writeFileSync(join(dir, 'associated_taxa.csv'), toCSV(associatedTaxa, ['id', 'name', 'authorship', 'rank', 'status', 'valid_name', 'family', 'order']))
writeFileSync(join(dir, 'references.csv'), toCSV(references, ['id', 'year', 'citation', 'doi', 'url']))
const zipName = `SoI-${version}-occurrences-dwca.zip`
if (zipBuf) writeFileSync(join(dir, zipName), zipBuf)

const fmt = (n) => Number(n).toLocaleString('en-US')
const nameList = (list, f) => list.slice(0, 60).map(f).join('\n') + (list.length > 60 ? `\n- … and ${list.length - 60} more (see names.csv)` : '')
let notes = `# Syrphidae of Italy ${version}\n\nReleased ${today}.\n\n`
notes += `| | |\n|---|---:|\n| Valid species | ${fmt(counts.species)} |\n| Valid genera | ${fmt(counts.genera)} |\n| Invalid and unavailable names | ${fmt(counts.invalid_names)} |\n| Biological associations | ${fmt(counts.associations)} |\n| Associated taxa (plants, prey, hosts, parasitoids) | ${fmt(counts.associated_taxa)} |\n| References | ${fmt(counts.references)} |\n| Occurrence records | ${fmt(counts.occurrences)} |\n\n`
if (Object.keys(perSubfamily).length) {
  notes += `## By subfamily\n\n| Subfamily | Genera | Species |\n|---|---:|---:|\n`
  for (const [k, v] of Object.entries(perSubfamily).sort()) notes += `| ${k} | ${v.genera} | ${v.species} |\n`
  notes += '\n'
}
if (Object.keys(byRelationship).length) {
  notes += `## Biological associations\n\n| Relationship | Associations |\n|---|---:|\n`
  for (const [k, v] of Object.entries(byRelationship).sort((a, b) => b[1] - a[1])) notes += `| ${k} | ${v} |\n`
  notes += '\n'
}
if (!changes) notes += `## Changes\n\nFirst release.\n\n`
else {
  notes += `## Changes since ${previous.version}\n\n`
  const sec = (title, list, f) => { if (list.length) notes += `### ${title} (${list.length})\n\n${nameList(list, f)}\n\n` }
  sec('Names added', changes.added, (r) => `- *${r.name}* ${r.authorship}`)
  sec('Status changed', changes.status, (r) => `- *${r.name}* ${r.authorship}: ${r.from} → ${r.to}${r.valid_name ? ` (valid name *${r.valid_name}*)` : ''}`)
  sec('Moved to another genus or combination', changes.combination, (r) => `- *${r.from}* → *${r.name}* ${r.authorship}`)
  sec('Names removed', changes.removed, (r) => `- *${r.name}* ${r.authorship}`)
  const d = counts.occurrences - (previous.counts?.occurrences || 0)
  notes += `Occurrence records: ${fmt(counts.occurrences)} (${d >= 0 ? '+' : ''}${fmt(d)}).\n\n`
  const da = counts.associations - (previous.counts?.associations || 0)
  notes += `Biological associations: ${fmt(counts.associations)} (${da >= 0 ? '+' : ''}${fmt(da)}).\n\n`
  if (!changes.added.length && !changes.status.length && !changes.combination.length && !changes.removed.length) notes += 'No changes to the names.\n\n'
}
notes += `## Files\n\n- \`names.csv\`: every name, with its status and valid name\n- \`associations.csv\`: every biological association (who, relationship, with whom, and the references)
- \`associated_taxa.csv\`: the other taxa in the associations (plants, prey, hosts, parasitoids)
- \`references.csv\`: every reference\n- \`${zipName}\`: the occurrence records (Darwin Core archive, as published on GBIF, doi:10.15468/faryxm)\n- \`stats.json\`: the counts above\n\nLicence: CC0 1.0.\n`
writeFileSync(join(dir, 'notes.md'), notes)

const summary = changes
  ? { added: changes.added.length, status: changes.status.length, combination: changes.combination.length, removed: changes.removed.length }
  : null
const entry = { version, date: today, doi: '', counts, per_subfamily: perSubfamily, occurrences: occ, associations: byRelationship, changes: summary }
writeFileSync(join(dir, 'stats.json'), JSON.stringify({ ...entry, changes }, null, 2) + '\n')
// the website shows the lists too: keep them short in releases.json
const short = (l) => l.slice(0, 40)
releases.unshift({
  ...entry,
  lists: changes ? { added: short(changes.added), status: short(changes.status), combination: short(changes.combination), removed: short(changes.removed) } : null
})
writeFileSync(releasesFile, JSON.stringify(releases, null, 2) + '\n')

const logFile = join(ROOT, 'CHANGELOG.md')
const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').replace(/^# Changelog\s*/, '').replace(/^No releases yet\.\s*/, '') : ''
writeFileSync(logFile, `# Changelog\n\n${notes.replace(/^# /, '## ').replace(/^## (?!Syrphidae)/gm, '### ').replace(/^### (Names|Status|Moved)/gm, '#### $1')}\n${log}`)
writeFileSync(join(ROOT, '.release-version'), version)
process.stdout.write(notes)
