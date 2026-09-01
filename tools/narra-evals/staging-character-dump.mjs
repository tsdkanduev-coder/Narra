import crypto from 'node:crypto'
const BASE = 'https://api-test.narra.disrupt.builders'
const id = crypto.randomUUID(), secret = crypto.randomBytes(32).toString('base64url')
const j = async (path, init = {}, token) => { const r = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }); const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = t.slice(0, 200) } return { status: r.status, body: b } }
const reg = await j('/v2/installations/register', { method: 'POST', body: JSON.stringify({ installation_id: id, installation_secret: secret, app_version: 'narra-probe', platform: 'probe', arch: 'probe' }) })
const token = reg.body.token
const CP = 'bef16434-1e57-4088-a9e0-aa3883797e1f', ON = '3c1ab592-0228-4931-ba74-5003fb463c1b'
const man = await j(`/v2/books/${CP}/manifest`, {}, token)
const m = man.body
console.log('manifest keys:', Object.keys(m))
console.log('book:', JSON.stringify(m.book).slice(0, 600))
console.log('tts_markup:', JSON.stringify(m.tts_markup).slice(0, 300))
console.log('correction:', JSON.stringify(m.correction))
const ch = m.characters
console.log('character[1] FULL:', JSON.stringify(ch[1], null, 1).slice(0, 2500))
console.log('names:', ch.map(c => c.name).join(' | '))
console.log('unlock offsets:', ch.map(c => c.unlock_text_offset ?? c.unlock?.text_offset ?? c.first_appearance_text_offset ?? '?').join(','))
for (const [bid, fr] of [[CP, 0.02], [ON, 0.003]]) { const sc = await j(`/v2/books/${bid}/scenes/at`, { method: 'POST', body: JSON.stringify({ progress_fraction: fr }) }, token); console.log('scenes/at', bid.slice(0, 8), fr, sc.status, JSON.stringify(sc.body).slice(0, 200)) }
// content/toc + a content chunk to inspect text cleanliness
const toc = await j(`/v2/books/${CP}/content/toc`, {}, token); console.log('toc', toc.status, JSON.stringify(toc.body).slice(0, 400))
const chunks = await j(`/v2/books/${CP}/content/chunks?offset=0&limit=1`, {}, token); console.log('chunks', chunks.status, JSON.stringify(chunks.body).slice(0, 700))
const img = await fetch(m.characters[1].portrait_url || m.characters[1].media?.portrait_url || '', {}).catch(e=>null); console.log('portrait fetch', img ? img.status : 'no url')
