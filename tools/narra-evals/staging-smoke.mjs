// Read-mostly probe of the Narra gateway: registers one throwaway installation, then only GETs + scenes/at (read of slot state).
import crypto from 'node:crypto'
const BASE = process.env.NARRA_BASE || 'https://api-test.narra.disrupt.builders'
const id = crypto.randomUUID()
const secret = crypto.randomBytes(32).toString('base64url')
const j = async (path, init = {}, token) => {
  const r = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } })
  const text = await r.text()
  let body; try { body = JSON.parse(text) } catch { body = text.slice(0, 300) }
  return { status: r.status, body }
}
const reg = await j('/v2/installations/register', { method: 'POST', body: JSON.stringify({ installation_id: id, installation_secret: secret, app_version: 'narra-probe', platform: 'probe', arch: 'probe' }) })
console.log('register', reg.status, reg.body.token ? 'token ok' : reg.body)
const token = reg.body.token
const cat = await j('/v2/books/catalog?limit=50', {}, token)
console.log('catalog', cat.status, Array.isArray(cat.body.items) ? cat.body.items.length : cat.body)
const items = cat.body.items || []
const brief = items.map(b => ({ id: b.id || b.book_edition_id, title: b.title, status: b.status, language: b.language, genres: b.genres, markup: b.markup_status || b.markup, analysis: b.analysis_status || b.analysis, scope: b.scope }))
console.log(JSON.stringify(brief.slice(0, 50), null, 0))
const want = items.filter(b => /Преступление|Война и мир|Анна Каренина|Онегин/.test(b.title || ''))
for (const b of want) {
  const bid = b.id || b.book_edition_id
  console.log('\n=== ', b.title, bid)
  const man = await j(`/v2/books/${bid}/manifest`, {}, token)
  const m = man.body
  console.log('manifest', man.status, JSON.stringify({ availability: m.availability, source: m.source, analysis: m.analysis, markup: m.markup && { analysis_version: m.markup.analysis_version, revision: m.markup.revision, text_length: m.markup.text_length, scene_policy: m.markup.scene_policy }, characters: Array.isArray(m.characters) ? m.characters.length : m.characters, tts_markup: m.tts_markup && (m.tts_markup.status || m.tts_markup.availability) }))
  if (Array.isArray(m.characters)) console.log('characters sample', JSON.stringify(m.characters.slice(0, 6).map(c => ({ key: c.character_key, name: c.name, full: c.full_name, unlock: c.unlock_text_offset ?? c.unlock_fraction, has_bio: !!(c.bio || c.description), portrait: !!(c.portrait || c.media) }))))
  for (const frac of [0.003, 0.02]) {
    const sc = await j(`/v2/books/${bid}/scenes/at`, { method: 'POST', body: JSON.stringify({ progress_fraction: frac }) }, token)
    console.log(`scenes/at frac=${frac}`, sc.status, JSON.stringify(sc.body).slice(0, 400))
  }
  const se = await j(`/v2/books/${bid}/search?q=${encodeURIComponent('Раскольников')}&limit=2`, {}, token)
  console.log('search', se.status, JSON.stringify(se.body).slice(0, 300))
}
