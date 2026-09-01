import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildProvisionalAnalysisCharacters,
  bookAnalysisRunIdempotencyKey,
  createPostgresBookAnalysisRepository
} from '../book-analysis-repository.mjs'

function scriptedPool(scripts) {
  const queries = []
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      const script = scripts.shift()
      if (!script) throw new Error(`unexpected query: ${sql}`)
      return script(sql, params)
    },
    release() {}
  }
  return {
    queries,
    async connect() { return client },
    async query(sql, params = []) { return client.query(sql, params) }
  }
}

test('analysis run key binds source and both pipeline versions', () => {
  assert.equal(bookAnalysisRunIdempotencyKey({
    bookEditionId: 'book-1',
    inputHash: 'a'.repeat(64),
    pipelineVersion: 'book-analysis-v8',
    promptVersion: 'scan-v1'
  }), [
    'book-analysis-cache', 'narra', 'book-analysis-v51', 'a'.repeat(64),
    'book-analysis-v8', 'scan-v1', 'normalized-text-v1', 'schema-3',
    'book-markup-v3', 'book-1'
  ].join(':'))
})

test('analysis repository requires an explicit boolean media generation policy', () => {
  const pool = scriptedPool([])
  assert.throws(
    () => createPostgresBookAnalysisRepository(pool, { mediaGenerationEnabled: 'false' }),
    /mediaGenerationEnabled must be a boolean/
  )
  assert.doesNotThrow(
    () => createPostgresBookAnalysisRepository(pool, { mediaGenerationEnabled: false })
  )
})

test('provisional analysis keeps only grounded confirmed people behind temporary keys', () => {
  const observations = [10, 30].map((offset, index) => ({
    id: `observation-${index}`,
    observationKey: `obs:jane-${index}`,
    type: 'character_mention',
    entityKind: 'character',
    entityCandidate: 'Jane Eyre',
    relatedEntityCandidates: [],
    fact: 'Jane Eyre is present',
    evidence: {
      quote: 'Jane Eyre', startOffset: offset, endOffset: offset + 9, chapterKey: 'chapter-1'
    },
    confidence: 0.9,
    data: {}
  }))

  const preview = buildProvisionalAnalysisCharacters('run-1', observations)

  assert.deepEqual(preview, [{
    characterKey: preview[0].characterKey,
    name: 'Jane Eyre',
    fullName: 'Jane Eyre',
    firstAppearanceTextOffset: 10,
    confidence: 0.9,
    observationCount: 2
  }])
  assert.match(preview[0].characterKey, /^provisional:[a-f0-9]{48}$/)
})

test('latest analysis preview reports scan progress and resolved partial observations', async () => {
  const observationRows = [10, 30].map((offset, index) => ({
    id: `11111111-1111-4111-8111-11111111111${index}`,
    chunk_id: `21111111-1111-4111-8111-11111111111${index}`,
    source_job_id: `31111111-1111-4111-8111-11111111111${index}`,
    extractor_version: 'book-scan-v10',
    observation_key: `obs:jane-${index}`,
    observation_type: 'character_mention',
    entity_kind: 'character',
    entity_candidate: 'Jane Eyre',
    related_entity_candidates: [],
    fact: 'Jane Eyre is present',
    evidence_quote: 'Jane Eyre',
    evidence_start_offset: String(offset),
    evidence_end_offset: String(offset + 9),
    confidence: 0.9,
    data: {},
    chapter_key: 'chapter-1'
  }))
  const pool = scriptedPool([
    () => ({ rows: [{
      id: 'run-1', book_edition_id: 'book-1', pipeline_version: 'book-analysis-v18',
      prompt_version: 'book-scan-v10', input_hash: 'a'.repeat(64), run_sequence: 1,
      stage: 'scan', status: 'running', text_length: '1000'
    }] }),
    () => ({ rows: [{ total: 25, ready: 4 }] }),
    () => ({ rows: observationRows })
  ])

  const preview = await createPostgresBookAnalysisRepository(pool)
    .getLatestAnalysisPreview('book-1')

  assert.equal(preview.run.stage, 'scan')
  assert.deepEqual(preview.scan, { completedChunks: 4, totalChunks: 25 })
  assert.equal(preview.characters[0].name, 'Jane Eyre')
  assert.ok(pool.queries.some(({ sql }) => /stage = 'scan'/.test(sql)))
})

test('restart creates the next isolated run and leaves the previous publication untouched', async () => {
  const ids = [
    '123e4567-e89b-42d3-a456-426614174010',
    '123e4567-e89b-42d3-a456-426614174011'
  ]
  const pool = scriptedPool([
    () => ({ rows: [{
      id: '123e4567-e89b-42d3-a456-426614174001',
      content_sha256: 'a'.repeat(64)
    }] }),
    () => ({ rows: [{
      id: '123e4567-e89b-42d3-a456-426614174002',
      book_edition_id: '123e4567-e89b-42d3-a456-426614174001',
      input_hash: 'a'.repeat(64), pipeline_version: 'book-analysis-v8',
      prompt_version: 'book-scan-v4', run_sequence: 1,
      pipeline_id: 'narra', pipeline_implementation_version: 'book-analysis-v44',
      normalization_version: 'normalized-text-v1', output_schema_version: 3,
      stage: 'publish', status: 'ready'
    }] }),
    () => ({ rows: [{
      id: '123e4567-e89b-42d3-a456-426614174002',
      book_edition_id: '123e4567-e89b-42d3-a456-426614174001',
      input_hash: 'a'.repeat(64), pipeline_version: 'book-analysis-v8',
      prompt_version: 'book-scan-v4', run_sequence: 1,
      pipeline_id: 'narra', pipeline_implementation_version: 'book-analysis-v44',
      normalization_version: 'normalized-text-v1', output_schema_version: 3,
      stage: 'publish', status: 'ready'
    }] }),
    (_sql, params) => ({ rows: [{
      id: params[0], idempotency_key: params[1],
      book_edition_id: params[2], input_hash: params[3],
      pipeline_version: params[4], prompt_version: params[5],
      run_sequence: params[6], stage: 'prepare', status: 'queued'
    }] }),
    (_sql, params) => ({ rows: [{
      id: params[0], run_id: params[1], stage: 'prepare', shard_key: 'book',
      status: 'queued', priority: params[2], attempts: 0, max_attempts: 5,
      payload: {}
    }] })
  ])
  const repository = createPostgresBookAnalysisRepository(pool, {
    idFactory: () => ids.shift(),
    defaultPipelineId: 'external'
  })

  const restarted = await repository.restartAnalysisRun({
    bookEditionId: '123e4567-e89b-42d3-a456-426614174001',
    priority: 100
  })

  assert.equal(restarted.created, true)
  assert.equal(restarted.run.runSequence, 2)
  assert.equal(restarted.run.pipelineId, 'narra')
  assert.equal(restarted.prepareJob.priority, 100)
  assert.ok(pool.queries.some(({ sql }) => /INSERT INTO book_analysis_runs/.test(sql)))
  assert.ok(pool.queries.every(({ sql }) => !/(UPDATE|DELETE FROM) book_analysis_publications/.test(sql)))
})

test('analysis jobs are claimed with stage isolation, skip locked and expiring leases', async () => {
  const pool = scriptedPool([
    () => ({ rows: [] }),
    () => ({ rows: [{
      id: 'job-1', run_id: 'run-1', stage: 'scan', shard_key: 'chunk:0',
      chunk_id: 'chunk-1', status: 'running', priority: 50, attempts: 1,
      max_attempts: 5, lease_token: '123e4567-e89b-42d3-a456-426614174001', payload: {}
    }] }),
    () => ({ rows: [] })
  ])
  const repository = createPostgresBookAnalysisRepository(pool, {
    idFactory: () => '123e4567-e89b-42d3-a456-426614174001'
  })
  const job = await repository.claimAnalysisJob('scan-worker-1', {
    stages: ['scan'],
    runIds: ['123e4567-e89b-42d3-a456-426614174099'],
    leaseSeconds: 120
  })
  assert.equal(job.id, 'job-1')
  assert.equal(job.stage, 'scan')
  const claim = pool.queries.find(({ sql }) => /WITH candidate AS/.test(sql))
  assert.match(claim.sql, /run\.stage = job\.stage/)
  assert.match(claim.sql, /FOR UPDATE OF job SKIP LOCKED/)
  assert.match(claim.sql, /lease_expires_at = now\(\) \+ make_interval/)
  assert.match(claim.sql, /run\.id = ANY\(\$6::uuid\[\]\)/)
  assert.deepEqual(claim.params[1], ['scan'])
  assert.deepEqual(claim.params[5], ['123e4567-e89b-42d3-a456-426614174099'])
})

test('analysis job run allowlist rejects an empty or malformed scope', async () => {
  const pool = scriptedPool([])
  const repository = createPostgresBookAnalysisRepository(pool)
  await assert.rejects(
    repository.claimAnalysisJob('scan-worker-1', { stages: ['scan'], runIds: [] }),
    /runIds must not be empty/
  )
  await assert.rejects(
    repository.claimAnalysisJob('scan-worker-1', { stages: ['scan'], runIds: ['not-a-uuid'] }),
    /runId must be a UUID/
  )
  assert.equal(pool.queries.length, 0)
})

test('analysis jobs are claimed fairly across books before another chunk from the same run', async () => {
  const pool = scriptedPool([
    () => ({ rows: [] }),
    () => ({ rows: [] })
  ])
  const repository = createPostgresBookAnalysisRepository(pool, {
    idFactory: () => '123e4567-e89b-42d3-a456-426614174001'
  })

  await repository.claimAnalysisJob('scan-worker-1', { stages: ['scan'] })

  const claim = pool.queries.find(({ sql }) => /WITH candidate AS/.test(sql))
  assert.match(claim.sql, /MAX\(sibling\.updated_at\)/)
  assert.match(claim.sql, /sibling\.attempts > 0/)
  assert.match(claim.sql, /NULLS FIRST/)
})

test('non-retryable analysis failure marks the job and run failed immediately', async () => {
  const pool = scriptedPool([
    () => ({ rows: [{ id: 'resolve-1', max_attempts: 5, attempts: 1 }] }),
    () => ({ rows: [] }),
    () => ({ rows: [] })
  ])
  const repository = createPostgresBookAnalysisRepository(pool)
  const result = await repository.failAnalysisJob({
    id: 'resolve-1', runId: 'run-1', stage: 'resolve',
    leaseToken: '123e4567-e89b-42d3-a456-426614174001'
  }, 'ANALYSIS_TEXT_COVERAGE_INCOMPLETE', { retryable: false })

  assert.deepEqual(result, { status: 'failed', retrySeconds: undefined })
  const updateJob = pool.queries.find(({ sql }) => /UPDATE book_analysis_jobs/.test(sql))
  assert.equal(updateJob.params[2], 'failed')
  assert.ok(pool.queries.some(({ sql }) => /UPDATE book_analysis_runs/.test(sql)))
})

test('prepare completion writes chunks and scan jobs before advancing the barrier', async () => {
  const pool = scriptedPool([
    () => ({ rows: [{ id: 'prepare-1', max_attempts: 5, attempts: 1 }] }),
    () => ({ rows: [{ id: 'run-1', text_length: '100' }] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [{
      chunk_count: 1, first_ordinal: 0, last_ordinal: 0,
      first_offset: '0', last_offset: '100', covered_chars: '100',
      discontinuity_count: 0
    }] }),
    () => ({ rows: [] }),
    () => ({ rows: [] })
  ])
  const repository = createPostgresBookAnalysisRepository(pool, {
    idFactory: () => '123e4567-e89b-42d3-a456-426614174002'
  })
  const result = await repository.completePrepare({
    id: 'prepare-1', runId: 'run-1', leaseToken: '123e4567-e89b-42d3-a456-426614174003'
  }, {
    normalizedTextObjectKey: 'analysis/run-1/normalized-text-v1.txt',
    normalizedTextHash: 'b'.repeat(64),
    textLength: 100,
    sections: [{ key: 'document', startOffset: 0, endOffset: 100 }],
    contentNavigation: {
      version: 'book-navigation-v1', source: 'document', items: [], segments: []
    },
    chunks: [{
      id: '123e4567-e89b-42d3-a456-426614174004',
      ordinal: 0,
      chapterKey: 'document',
      coreStartOffset: 0,
      coreEndOffset: 100,
      contextStartOffset: 0,
      contextEndOffset: 100,
      contentHash: 'c'.repeat(64),
      metadata: {}
    }]
  })
  assert.deepEqual(result, { textLength: 100, chunkCount: 1, stage: 'scan' })
  const sql = pool.queries.map(({ sql }) => sql)
  const insertChunk = sql.findIndex((value) => /INSERT INTO book_analysis_chunks/.test(value))
  const insertJob = sql.findIndex((value) => /INSERT INTO book_analysis_jobs/.test(value))
  const readyPrepare = sql.findIndex((value) => /UPDATE book_analysis_jobs[\s\S]*status = 'ready'/.test(value))
  const advance = sql.findIndex((value) => /UPDATE book_analysis_runs SET stage = 'scan'/.test(value))
  assert.ok(insertChunk > 0 && insertChunk < insertJob)
  assert.ok(insertJob < readyPrepare && readyPrepare < advance)
  const scanInsert = pool.queries.find(({ sql: value }) => /INSERT INTO book_analysis_jobs/.test(value))
  assert.deepEqual(JSON.parse(scanInsert.params[5]), { chunkOrdinal: 0 })
  assert.equal(scanInsert.params[6], 'narra')
  assert.ok(sql.some((value) => /lag\(core_end_offset\)/.test(value)))
})

test('external prepare keeps Narra chunks but creates one book-level scan job', async () => {
  const pool = scriptedPool([
    () => ({ rows: [{ id: 'prepare-1', max_attempts: 5, attempts: 1 }] }),
    () => ({ rows: [{
      id: 'run-1', text_length: '100', pipeline_id: 'external',
      pipeline_implementation_version: 'external-autiobook-v1.d532bdd0'
    }] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [{
      chunk_count: 2, first_ordinal: 0, last_ordinal: 1,
      first_offset: '0', last_offset: '100', covered_chars: '100',
      discontinuity_count: 0
    }] }),
    () => ({ rows: [] }),
    () => ({ rows: [] })
  ])
  const repository = createPostgresBookAnalysisRepository(pool, {
    idFactory: () => '123e4567-e89b-42d3-a456-426614174002'
  })
  await repository.completePrepare({
    id: 'prepare-1', runId: 'run-1', leaseToken: '123e4567-e89b-42d3-a456-426614174003'
  }, {
    normalizedTextObjectKey: 'analysis/run-1/normalized-text-v1.txt',
    normalizedTextHash: 'b'.repeat(64),
    textLength: 100,
    sections: [{ key: 'document', startOffset: 0, endOffset: 100 }],
    contentNavigation: {
      version: 'book-navigation-v1', source: 'document', items: [], segments: []
    },
    chunks: [
      {
        id: '123e4567-e89b-42d3-a456-426614174004', ordinal: 0,
        chapterKey: 'one', coreStartOffset: 0, coreEndOffset: 50,
        contextStartOffset: 0, contextEndOffset: 60,
        contentHash: 'c'.repeat(64), metadata: {}
      },
      {
        id: '123e4567-e89b-42d3-a456-426614174005', ordinal: 1,
        chapterKey: 'two', coreStartOffset: 50, coreEndOffset: 100,
        contextStartOffset: 40, contextEndOffset: 100,
        contentHash: 'd'.repeat(64), metadata: {}
      }
    ]
  })
  const scanInserts = pool.queries.filter(({ sql }) =>
    /INSERT INTO book_analysis_jobs/.test(sql)
  )
  assert.equal(scanInserts.length, 1)
  assert.equal(scanInserts[0].params[2], 'pipeline:external')
  assert.deepEqual(JSON.parse(scanInserts[0].params[5]), { scope: 'book' })
  assert.equal(scanInserts[0].params[6], 'external')
})

test('resolve completion freezes evidence before advancing to synthesize', async () => {
  const observation = {
    id: '11111111-1111-4111-8111-111111111111',
    chunk_id: '21111111-1111-4111-8111-111111111111',
    source_job_id: '31111111-1111-4111-8111-111111111111',
    extractor_version: 'book-scan-v1',
    observation_key: 'obs:anna',
    observation_type: 'character_mention',
    entity_kind: 'character',
    entity_candidate: 'Анна',
    related_entity_candidates: [],
    fact: 'Анна появилась',
    evidence_quote: 'Анна',
    evidence_start_offset: '10',
    evidence_end_offset: '14',
    confidence: 0.9,
    data: {},
    chapter_key: 'chapter-1'
  }
  const pool = scriptedPool([
    () => ({ rows: [{ id: 'resolve-1', max_attempts: 5, attempts: 1 }] }),
    () => ({ rows: [{ id: 'run-1', text_length: '100' }] }),
    () => ({ rows: [observation] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] })
  ])
  const ids = [
    '41111111-1111-4111-8111-111111111111',
    '51111111-1111-4111-8111-111111111111',
    '61111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111'
  ]
  const repository = createPostgresBookAnalysisRepository(pool, {
    idFactory: () => ids.shift()
  })
  const input = await (async () => {
    const readPool = scriptedPool([
      () => ({ rows: [{
        run_id: 'run-1', book_edition_id: 'book-1', prompt_version: 'book-scan-v1',
        normalized_text_hash: 'a'.repeat(64), text_length: '100', title: 'Книга', author: ''
      }] }),
      () => ({ rows: [observation] })
    ])
    const readRepository = createPostgresBookAnalysisRepository(readPool)
    return readRepository.getResolveInput({
      id: 'resolve-1', runId: 'run-1', leaseToken: '71111111-1111-4111-8111-111111111111'
    })
  })()
  const result = await repository.completeResolve({
    id: 'resolve-1', runId: 'run-1', leaseToken: '71111111-1111-4111-8111-111111111111'
  }, {
    observationSetHash: input.observationSetHash,
    observationCount: 1,
    entities: [{
      entityKey: 'character:anna',
      entityKind: 'character',
      canonicalName: 'Анна',
      aliases: [],
      resolutionStatus: 'confirmed',
      confidence: 0.9,
      evidenceIds: [observation.id],
      data: { observationCount: 1 }
    }]
  })
  assert.equal(result.stage, 'synthesize')
  assert.equal(result.entityCount, 1)
  assert.equal(result.characterJobCount, 1)
  const sql = pool.queries.map(({ sql }) => sql)
  const insertEntity = sql.findIndex((value) => /INSERT INTO book_analysis_entities/.test(value))
  const linkEvidence = sql.findIndex((value) => /INSERT INTO book_analysis_entity_evidence/.test(value))
  const insertSnapshot = sql.findIndex((value) => /INSERT INTO book_analysis_snapshots/.test(value))
  const completeJob = sql.findIndex((value) => /UPDATE book_analysis_jobs[\s\S]*status = 'ready'/.test(value))
  const insertCharacterSynthesize = sql.findIndex((value) => /'synthesize', \$3/.test(value))
  const insertSynthesize = sql.findIndex((value) => /'synthesize', 'book'/.test(value))
  const advance = sql.findIndex((value) => /SET stage = 'synthesize'/.test(value))
  assert.ok(insertEntity < linkEvidence && linkEvidence < insertSnapshot)
  assert.ok(insertSnapshot < completeJob && completeJob < insertCharacterSynthesize)
  assert.ok(insertCharacterSynthesize < insertSynthesize && insertSynthesize < advance)
  const entityInsert = pool.queries[insertEntity]
  const insertedEntities = JSON.parse(entityInsert.params[1])
  assert.deepEqual(insertedEntities[0].data, {
    observationCount: 1,
    mentionCount: 1,
    evidenceCount: 1,
    prominenceRank: 1,
    selectedForPublication: true
  })
  const frozenSnapshot = JSON.parse(pool.queries[insertSnapshot].params[4])
  assert.deepEqual(frozenSnapshot.characterSelection, {
    version: 'character-frequency-v1',
    limit: 20,
    characterKeys: ['character:anna']
  })
})

test('catalog analysis backfill heals dead-leased queued/running runs, not only missing ones', async () => {
  const editionId = '123e4567-e89b-42d3-a456-426614174001'
  const runId = '123e4567-e89b-42d3-a456-426614174002'
  const pool = scriptedPool([
    () => ({ rows: [{
      id: editionId,
      content_sha256: 'a'.repeat(64),
      run_id: runId,
      run_status: 'running'
    }] }),
    () => ({ rows: [{ id: runId }] }),
    () => ({ rows: [{
      id: editionId,
      content_sha256: 'a'.repeat(64)
    }] }),
    () => ({ rows: [{
      id: runId,
      book_edition_id: editionId,
      input_hash: 'a'.repeat(64), pipeline_version: 'book-analysis-v8',
      prompt_version: 'book-scan-v4', run_sequence: 1,
      pipeline_id: 'narra', pipeline_implementation_version: 'book-analysis-v44',
      normalization_version: 'normalized-text-v1', output_schema_version: 3,
      stage: 'prepare', status: 'failed'
    }] }),
    () => ({ rows: [{
      id: runId,
      book_edition_id: editionId,
      input_hash: 'a'.repeat(64), pipeline_version: 'book-analysis-v8',
      prompt_version: 'book-scan-v4', run_sequence: 1,
      pipeline_id: 'narra', pipeline_implementation_version: 'book-analysis-v44',
      normalization_version: 'normalized-text-v1', output_schema_version: 3,
      stage: 'prepare', status: 'failed'
    }] }),
    (_sql, params) => ({ rows: [{
      id: params[0], idempotency_key: params[1],
      book_edition_id: params[2], input_hash: params[3],
      pipeline_version: params[4], prompt_version: params[5],
      run_sequence: params[6], stage: 'prepare', status: 'queued'
    }] }),
    (_sql, params) => ({ rows: [{
      id: params[0], run_id: params[1], stage: 'prepare', shard_key: 'book',
      status: 'queued', priority: params[2], attempts: 0, max_attempts: 5,
      payload: {}
    }] })
  ])
  const repository = createPostgresBookAnalysisRepository(pool, {
    idFactory: () => '123e4567-e89b-42d3-a456-426614174010'
  })
  const started = await repository.enqueueCatalogAnalysisBackfill({ limit: 10, priority: 40 })
  assert.equal(started.length, 1)
  assert.equal(started[0].created, true)
  const select = pool.queries.find(({ sql }) => /LEFT JOIN LATERAL/.test(sql))
  assert.match(select.sql, /run\.status IN \('queued', 'running'\)/)
  assert.match(select.sql, /lease_expires_at > now\(\)/)
  const fail = pool.queries.find(({ sql }) => /last_error_code = 'LEASE_EXPIRED'/.test(sql))
  assert.equal(fail.params[0], runId)
})
