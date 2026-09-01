import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const compose = await readFile(new URL('../compose.i167.yml', import.meta.url), 'utf8')
const localCompose = await readFile(
  new URL('../compose.book-analysis-local.yml', import.meta.url),
  'utf8'
)
const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
const gatewaySource = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
const deploySource = await readFile(new URL('../deploy-i167.sh', import.meta.url), 'utf8')

const stages = {
  prepare: '["node", "book-analysis-worker.mjs"]',
  scan: '["node", "book-analysis-scan-worker-runner.mjs"]',
  resolve: '["node", "book-analysis-resolve-worker-runner.mjs"]',
  synthesize: '["node", "book-analysis-stage-worker-runner.mjs", "synthesize"]',
  validate: '["node", "book-analysis-stage-worker-runner.mjs", "validate"]',
  publish: '["node", "book-analysis-stage-worker-runner.mjs", "publish"]'
}

test('canonical v3 analysis deploys every stage by default as an independently scalable service', () => {
  assert.doesNotMatch(compose, /profiles: \["book-analysis-shadow"\]/)
  for (const [stage, command] of Object.entries(stages)) {
    const service = `  book-analysis-${stage}:\n`
    assert.ok(compose.includes(service), `missing ${stage} service`)
    assert.ok(compose.includes(`    command: ${command}`), `wrong ${stage} command`)
  }
})

test('scan stage has parallel workers by default for catalog backfills', () => {
  const scan = compose.slice(
    compose.indexOf('  book-analysis-scan:'),
    compose.indexOf('  book-analysis-resolve:')
  )
  assert.match(scan, /replicas: \$\{BOOK_ANALYSIS_SCAN_REPLICAS:-8\}/)
})

test('external research services are isolated in the local-only compose profile', () => {
  assert.match(localCompose, /^name: \$\{NARRA_BOOK_ANALYSIS_PROJECT:-narra-book-analysis-local\}$/m)
  const adapter = localCompose.slice(
    localCompose.indexOf('  autiobook-adapter:'),
    localCompose.indexOf('  book-analysis-external:')
  )
  const worker = localCompose.slice(
    localCompose.indexOf('  book-analysis-external:'),
    localCompose.indexOf('  book-analysis-resolve:')
  )
  assert.match(adapter, /profiles: \["book-analysis-external"\]/)
  assert.match(adapter, /read_only: true/)
  assert.doesNotMatch(adapter, /\n    ports:/)
  assert.match(worker, /book-analysis-external-worker-runner\.mjs/)
  assert.match(worker, /AUTIOBOOK_ADAPTER_BASE_URL: http:\/\/autiobook-adapter\.railway\.internal:8080/)
  assert.match(gatewaySource, /BOOK_ANALYSIS_PIPELINE/)
})

test('gateway LLM capacity is aligned with the larger scan pool', () => {
  assert.match(envExample, /^LLM_CONCURRENCY=12$/m)
  assert.match(gatewaySource, /envInt\('LLM_CONCURRENCY', 12, 100\)/)
})

test('markup and synthesis capacity survives a routine compose redeploy', () => {
  const markup = compose.slice(
    compose.indexOf('  book-markup-worker:'),
    compose.indexOf('  book-analysis-prepare:')
  )
  const synthesize = compose.slice(
    compose.indexOf('  book-analysis-synthesize:'),
    compose.indexOf('  book-analysis-validate:')
  )
  assert.match(markup, /replicas: \$\{BOOK_MARKUP_WORKER_REPLICAS:-4\}/)
  assert.match(synthesize, /replicas: \$\{BOOK_ANALYSIS_SYNTHESIZE_REPLICAS:-4\}/)
})

test('book display identity has one separate durable worker', () => {
  const identity = compose.slice(
    compose.indexOf('  book-identity-worker:'),
    compose.indexOf('  book-analysis-prepare:')
  )
  assert.match(identity, /command: \["node", "book-identity-worker\.mjs"\]/)
  assert.match(identity, /replicas: \$\{BOOK_IDENTITY_WORKER_REPLICAS:-1\}/)
  assert.match(identity, /read_only: true/)
  assert.match(
    deploySource,
    /for worker_service in book-markup-worker book-identity-worker/
  )
})

test('TTS markup runs as an independently scalable hardened container', () => {
  const worker = compose.slice(
    compose.indexOf('  book-tts-markup-worker:'),
    compose.indexOf('  book-analysis-prepare:')
  )
  assert.match(worker, /command: \["node", "book-tts-markup-worker-runner\.mjs"\]/)
  assert.match(worker, /replicas: \$\{BOOK_TTS_MARKUP_WORKER_REPLICAS:-2\}/)
  assert.match(worker, /read_only: true/)
  assert.match(worker, /book-analysis-database-environment/)
  assert.match(worker, /book-analysis-storage-environment/)
  assert.match(worker, /book-analysis-generator-environment/)
  assert.match(envExample, /^BOOK_TTS_MARKUP_WORKER_REPLICAS=2$/m)
  assert.match(deploySource, /for worker_service in book-tts-markup-worker/)
  const publicBooksRouter = gatewaySource.slice(
    gatewaySource.indexOf("app.use('/v2/books'"),
    gatewaySource.indexOf("app.post('/v2/events/batch'")
  )
  assert.match(publicBooksRouter, /ttsMarkupRepository: bookTtsMarkupRepository/)
})

test('book scenes use the configured image route and landscape aspect ratio', () => {
  assert.match(gatewaySource, /generateScene: generateInternalScene/)
  assert.match(gatewaySource, /aspectRatio: '4:3'/)
  const sceneJobs = gatewaySource.slice(
    gatewaySource.indexOf('const sceneJobRunner'),
    gatewaySource.indexOf('sceneJobRunner.start()')
  )
  assert.match(sceneJobs, /generateInternalScene/)
  assert.doesNotMatch(sceneJobs, /generateInternalPortrait/)
  const images = gatewaySource.slice(
    gatewaySource.indexOf("app.post('/v2/media/images'"),
    gatewaySource.indexOf('function coverJobPollAfter')
  )
  assert.match(images, /requestCoverImageWithFallback/)
  assert.doesNotMatch(images, /gigachatImage/)
  assert.doesNotMatch(images, /kandinskyQueued/)
})

test('shadow analysis workers keep the hardened read-only runtime', () => {
  assert.match(compose, /x-book-analysis-worker: &book-analysis-worker/)
  assert.match(compose, /restart: unless-stopped/)
  assert.match(compose, /read_only: true/)
  assert.match(compose, /no-new-privileges:true/)
})

test('stage services receive only the provider credentials they need', () => {
  const resolve = compose.slice(
    compose.indexOf('  book-analysis-resolve:'),
    compose.indexOf('  book-analysis-synthesize:')
  )
  const publish = compose.slice(
    compose.indexOf('  book-analysis-publish:'),
    compose.indexOf('\nvolumes:')
  )
  assert.match(resolve, /book-analysis-database-environment/)
  assert.match(resolve, /book-analysis-generator-environment/)
  assert.doesNotMatch(resolve, /book-analysis-storage-environment/)
  assert.match(publish, /book-analysis-database-environment/)
  assert.doesNotMatch(publish, /generator-environment|storage-environment/)
})
