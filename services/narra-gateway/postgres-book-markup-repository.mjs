import { createHash, randomUUID } from 'node:crypto'
import {
  BOOK_IDENTITY_VERSION,
  bookIdentityTargetVersion,
  normalizeBookDisplayIdentity,
  normalizeBookIdentityValue
} from './book-identity.mjs'
import {
  BOOK_MARKUP_ANALYSIS_VERSION,
  BOOK_MARKUP_SCHEMA_VERSION,
  CHARACTER_MEDIA_JOB_TYPES,
  CHARACTER_BUNDLE_VERSION,
  REQUIRED_CHARACTER_MEDIA,
  characterMediaIdempotencyKey,
  characterMediaTargetVersion,
  hasReaderReachedCharacter
} from './book-markup.mjs'
import {
  bookMediaFrontier,
  bookSceneIdempotencyKey,
  bookSceneSlotAt,
  bookSceneSlotsThrough,
  normalizeBookScenePolicy
} from './book-scenes.mjs'

const BOOK_MIME_TYPES = Object.freeze({
  epub: 'application/epub+zip',
  fb2: 'application/x-fictionbook+xml',
  txt: 'text/plain',
  pdf: 'application/pdf'
})

const CATALOG_COVER_VERSION = 'catalog-cover-v4'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function catalogCoverTargetVersion(contentSha256) {
  return `${CATALOG_COVER_VERSION}-${contentSha256.slice(0, 16)}`
}

function leaseLost(jobId) {
  const error = new Error(`generation job lease lost: ${jobId}`)
  error.code = 'LEASE_LOST'
  return error
}

async function transaction(pool, operation) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function jobRow(row) {
  if (!row) return null
  return {
    id: row.id,
    type: row.job_type,
    bookEditionId: row.book_edition_id,
    characterKey: row.character_key ?? undefined,
    targetVersion: row.target_version,
    status: row.status,
    attempts: row.attempts,
    leaseToken: row.lease_token ?? undefined,
    payload: row.payload ?? {}
  }
}

function editionRow(row) {
  if (!row) return null
  const fallbackIdentity = normalizeBookDisplayIdentity({ title: row.title, author: row.author })
  const displayTitle = row.display_title
    ? normalizeBookIdentityValue(row.display_title)
    : fallbackIdentity.title
  const displayAuthor = row.display_author != null
    ? normalizeBookIdentityValue(row.display_author)
    : fallbackIdentity.author
  const edition = {
    id: row.id,
    scope: row.scope,
    catalogKey: row.catalog_key ?? undefined,
    contentSha256: row.content_sha256,
    title: displayTitle || 'Untitled book',
    author: displayAuthor,
    genres: Array.isArray(row.genres) ? row.genres.filter((genre) => typeof genre === 'string') : [],
    language: row.language ?? null,
    catalogPopularityRank: row.catalog_popularity_rank == null
      ? null
      : Number(row.catalog_popularity_rank),
    format: row.format,
    status: row.status,
    sourceStorage: row.source_storage || 'stored',
    expiresAt: row.expires_at == null
      ? null
      : row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at)
  }
  if (row.cover_status === 'ready') {
    edition.cover = {
      objectKey: row.cover_object_key,
      contentHash: row.cover_content_hash,
      mimeType: row.cover_mime_type,
      byteSize: Number(row.cover_byte_size)
    }
  }
  return edition
}

function catalogCoverRow(row) {
  if (!row) return null
  return {
    bookEditionId: row.book_edition_id,
    objectKey: row.object_key,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    status: row.status
  }
}

async function requireLeasedJob(client, job) {
  const result = await client.query(
    `SELECT * FROM generation_jobs
     WHERE id = $1 AND status = 'running' AND lease_token = $2::uuid
     FOR UPDATE`,
    [job.id, job.leaseToken]
  )
  if (!result.rows[0]) throw leaseLost(job.id)
  return result.rows[0]
}

/**
 * PostgreSQL implementation without a hard dependency on one driver. Pass a
 * pg-compatible Pool exposing connect(), query() and client.release().
 */
export function createPostgresBookMarkupRepository(pool, {
  idFactory = randomUUID,
  privateMaterialTtlDays = 7
} = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('a pg-compatible pool is required')
  }
  if (!Number.isSafeInteger(privateMaterialTtlDays) || privateMaterialTtlDays < 1 || privateMaterialTtlDays > 365) {
    throw new RangeError('privateMaterialTtlDays must be between 1 and 365')
  }

  async function touchPrivateRetention(client, bookEditionId) {
    await client.query(
      `WITH touched AS (
         UPDATE book_editions
         SET expires_at = now() + make_interval(days => $2), updated_at = now()
         WHERE id = $1 AND scope = 'private'
         RETURNING id, expires_at
       ), markup AS (
         UPDATE book_markup_versions AS value
         SET expires_at = touched.expires_at
         FROM touched WHERE value.book_edition_id = touched.id
       ), bundles AS (
         UPDATE character_media_bundles AS value
         SET expires_at = touched.expires_at, updated_at = now()
         FROM touched WHERE value.book_edition_id = touched.id
       )
       UPDATE media_assets AS value
       SET expires_at = touched.expires_at
       FROM touched WHERE value.book_edition_id = touched.id`,
      [bookEditionId, privateMaterialTtlDays]
    )
  }

  async function queueBookObjectDeletions(client, bookEditionIds) {
    const sources = await client.query(
      'SELECT object_key FROM book_files WHERE book_edition_id = ANY($1::uuid[])',
      [bookEditionIds]
    )
    const analysis = await client.query(
      `SELECT normalized_text_object_key AS object_key
       FROM book_analysis_runs
       WHERE book_edition_id = ANY($1::uuid[])
         AND normalized_text_object_key IS NOT NULL`,
      [bookEditionIds]
    )
    const media = await client.query(
      'SELECT object_key FROM media_assets WHERE book_edition_id = ANY($1::uuid[])',
      [bookEditionIds]
    )
    const jobs = await client.query(
      'SELECT idempotency_key FROM generation_jobs WHERE book_edition_id = ANY($1::uuid[])',
      [bookEditionIds]
    )
    const objectKeys = [...new Set([
      ...sources.rows.map((row) => row.object_key),
      ...analysis.rows.map((row) => row.object_key),
      ...media.rows.map((row) => row.object_key),
      ...jobs.rows.map((row) =>
        `generated/cache/${createHash('sha256').update(row.idempotency_key).digest('hex')}.json`
      )
    ])]
    if (!objectKeys.length) return 0
    const queued = await client.query(
      `INSERT INTO book_object_deletions (object_key)
       SELECT unnest($1::text[])
       ON CONFLICT (object_key) DO NOTHING
       RETURNING object_key`,
      [objectKeys]
    )
    return queued.rows.length
  }

  async function ensureJob({
    idempotencyKey,
    type,
    bookEditionId,
    characterKey = null,
    targetVersion,
    priority = 50,
    payload = {}
  }) {
    return transaction(pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO generation_jobs (
           id, idempotency_key, job_type, book_edition_id, character_key,
           target_version, status, priority, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          idFactory(), idempotencyKey, type, bookEditionId, characterKey,
          targetVersion, priority, JSON.stringify(payload)
        ]
      )
      if (inserted.rows[0]) return { row: inserted.rows[0], created: true }
      const existing = await client.query(
        'SELECT * FROM generation_jobs WHERE idempotency_key = $1',
        [idempotencyKey]
      )
      if (!existing.rows[0]) throw new Error('idempotent generation job disappeared')
      return { row: existing.rows[0], created: false }
    })
  }

  async function loadSceneContext(client, { subjectId = null, bookEditionId }) {
    const result = await client.query(
      `SELECT edition.id, edition.scope, edition.title, edition.author,
              edition.expires_at, markup.id AS markup_version_id,
              COALESCE(markup.text_length, run.text_length) AS text_length,
              markup.input_hash,
              publication.content_hash AS publication_content_hash,
              publication.data->'markup'->'scenePolicy' AS scene_policy,
              run.normalized_text_object_key, run.normalized_text_hash
       FROM book_editions AS edition
       JOIN book_markup_versions AS markup
         ON markup.book_edition_id = edition.id
        AND markup.status = 'published'
       LEFT JOIN LATERAL (
         SELECT value.content_hash, value.run_id, value.data
         FROM book_analysis_publications AS value
         WHERE value.book_edition_id = edition.id
         ORDER BY
           CASE WHEN value.content_hash = markup.input_hash THEN 0 ELSE 1 END,
           CASE WHEN value.channel = 'shadow' THEN 0 ELSE 1 END,
           value.published_at DESC, value.id DESC
         LIMIT 1
       ) AS publication ON true
       LEFT JOIN LATERAL (
         SELECT candidate.normalized_text_object_key,
                candidate.normalized_text_hash,
                candidate.text_length
         FROM book_analysis_runs AS candidate
         WHERE candidate.book_edition_id = edition.id
           AND candidate.normalized_text_object_key IS NOT NULL
           AND candidate.normalized_text_hash IS NOT NULL
         ORDER BY
           CASE WHEN publication.run_id IS NOT NULL
                 AND candidate.id = publication.run_id THEN 0 ELSE 1 END,
           candidate.run_sequence DESC NULLS LAST,
           candidate.created_at DESC
         LIMIT 1
       ) AS run ON true
       WHERE edition.id = $1 AND (
         $2::uuid IS NULL OR
         (edition.scope = 'catalog' AND edition.status IN ('base_ready', 'published')) OR
         (edition.scope = 'private' AND edition.owner_subject_id = $2::uuid
           AND edition.expires_at > now())
       )
       LIMIT 1 FOR SHARE OF edition, markup`,
      [bookEditionId, subjectId]
    )
    const row = result.rows[0]
    if (!row || !row.normalized_text_object_key || !row.normalized_text_hash) return null
    const textLength = Number(row.text_length)
    if (!Number.isSafeInteger(textLength) || textLength < 1) return null
    return {
      bookEditionId: row.id,
      scope: row.scope,
      title: row.title,
      author: row.author,
      markupVersionId: row.markup_version_id,
      markupContentHash: row.publication_content_hash || row.input_hash,
      normalizedTextObjectKey: row.normalized_text_object_key,
      normalizedTextHash: row.normalized_text_hash,
      textLength,
      policy: normalizeBookScenePolicy(row.scene_policy, textLength)
    }
  }

  async function ensureSceneSlot(client, context, slot, priority = 45) {
    const idempotencyKey = bookSceneIdempotencyKey({
      bookEditionId: context.bookEditionId,
      markupContentHash: context.markupContentHash,
      policyVersion: context.policy.version,
      slotIndex: slot.slotIndex
    })
    const targetVersion = `${context.policy.version}:${context.markupContentHash.slice(0, 16)}`
    const payload = {
      markup_version_id: context.markupVersionId,
      scene_key: slot.sceneKey,
      slot_index: slot.slotIndex,
      anchor_text_offset: slot.anchorTextOffset,
      excerpt_start_text_offset: slot.excerptStartTextOffset,
      excerpt_end_text_offset: slot.excerptEndTextOffset,
      normalized_text_object_key: context.normalizedTextObjectKey,
      normalized_text_hash: context.normalizedTextHash
    }
    const proposedJobId = idFactory()
    const insertedJob = await client.query(
      `INSERT INTO generation_jobs (
         id, idempotency_key, job_type, book_edition_id, character_key,
         target_version, status, priority, payload
       ) VALUES ($1, $2, 'scene_image', $3, NULL, $4, 'queued', $5, $6::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        proposedJobId, idempotencyKey, context.bookEditionId, targetVersion,
        priority, JSON.stringify(payload)
      ]
    )
    const job = insertedJob.rows[0] || (await client.query(
      'SELECT * FROM generation_jobs WHERE idempotency_key = $1',
      [idempotencyKey]
    )).rows[0]
    if (!job) throw new Error('idempotent scene generation job disappeared')
    if (job.status === 'failed' && priority >= 45) {
      await client.query(
        `UPDATE generation_jobs
         SET status = 'queued', attempts = 0, last_error_code = NULL,
             available_at = now(), locked_at = NULL, locked_by = NULL,
             lease_token = NULL, updated_at = now()
         WHERE id = $1 AND status = 'failed'`,
        [job.id]
      )
      job.status = 'queued'
    }
    await client.query(
      `INSERT INTO book_scene_slots (
         id, book_edition_id, markup_version_id, policy_version, scene_key,
         slot_index, anchor_text_offset, excerpt_start_text_offset,
         excerpt_end_text_offset, job_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (markup_version_id, slot_index) DO NOTHING`,
      [
        idFactory(), context.bookEditionId, context.markupVersionId,
        context.policy.version, slot.sceneKey, slot.slotIndex, slot.anchorTextOffset,
        slot.excerptStartTextOffset, slot.excerptEndTextOffset, job.id
      ]
    )
    const result = await client.query(
      `SELECT scene.scene_key, scene.slot_index, scene.anchor_text_offset,
              job.status, asset.id AS asset_id, asset.object_key,
              asset.type, asset.content_hash, asset.mime_type, asset.byte_size
       FROM book_scene_slots AS scene
       JOIN generation_jobs AS job ON job.id = scene.job_id
       LEFT JOIN media_assets AS asset
         ON asset.id = scene.asset_id AND asset.status = 'ready'
       WHERE scene.markup_version_id = $1 AND scene.slot_index = $2`,
      [context.markupVersionId, slot.slotIndex]
    )
    const row = result.rows[0]
    if (!row) throw new Error('durable scene slot disappeared')
    return {
      sceneKey: row.scene_key,
      slotIndex: Number(row.slot_index),
      anchorTextOffset: Number(row.anchor_text_offset),
      status: row.asset_id ? 'ready' : row.status === 'ready' ? 'failed' : row.status,
      asset: row.asset_id
        ? {
            assetId: row.asset_id,
            objectKey: row.object_key,
            type: row.type,
            contentHash: row.content_hash,
            mimeType: row.mime_type,
            byteSize: Number(row.byte_size)
          }
        : null
    }
  }

  function identityJobSpec(edition) {
    const targetVersion = bookIdentityTargetVersion({
      contentSha256: edition.content_sha256,
      title: edition.title,
      author: edition.author
    })
    return {
      targetVersion,
      idempotencyKey: `${edition.id}:book-identity:${targetVersion}`
    }
  }

  async function ensureBookIdentityJob(client, edition, priority = 60) {
    const spec = identityJobSpec(edition)
    if (edition.identity_version === spec.targetVersion) return null
    const inserted = await client.query(
      `INSERT INTO generation_jobs (
         id, idempotency_key, job_type, book_edition_id, character_key,
         target_version, status, priority, payload
       ) VALUES ($1, $2, 'book_identity', $3, NULL, $4, 'queued', $5, $6::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        idFactory(), spec.idempotencyKey, edition.id, spec.targetVersion, priority,
        JSON.stringify({ identity_version: BOOK_IDENTITY_VERSION })
      ]
    )
    if (inserted.rows[0]) {
      return { ...jobRow(inserted.rows[0]), created: true, ...spec }
    }
    const existing = await client.query(
      'SELECT * FROM generation_jobs WHERE idempotency_key = $1',
      [spec.idempotencyKey]
    )
    if (!existing.rows[0]) throw new Error('idempotent book identity job disappeared')
    return { ...jobRow(existing.rows[0]), created: false, ...spec }
  }

  async function ensureCharacterMediaJobs({
    bookEditionId,
    characterKey,
    bundleVersion,
    priority
  }) {
    return transaction(pool, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2 || ':' || $3))`,
        [bookEditionId, characterKey, bundleVersion]
      )
      const source = await client.query(
        `SELECT markup.id AS markup_version_id,
                COALESCE(publication.content_hash,
                  lpad(md5(character.data::text), 64, '0')) AS source_markup_hash,
                bundle.id AS bundle_id, bundle.status AS bundle_status,
                bundle.source_markup_hash AS previous_source_markup_hash,
                bundle.media_revision
         FROM book_markup_versions AS markup
         JOIN book_characters AS character
           ON character.markup_version_id = markup.id AND character.character_key = $2
         LEFT JOIN LATERAL (
           SELECT value.content_hash
           FROM book_analysis_publications AS value
           WHERE value.book_edition_id = markup.book_edition_id
           ORDER BY value.published_at DESC, value.id DESC
           LIMIT 1
         ) AS publication ON true
         LEFT JOIN character_media_bundles AS bundle
           ON bundle.book_edition_id = markup.book_edition_id
          AND bundle.character_key = character.character_key
          AND bundle.bundle_version = $3
         WHERE markup.book_edition_id = $1 AND markup.status = 'published'
         LIMIT 1
         FOR UPDATE OF markup, character`,
        [bookEditionId, characterKey, bundleVersion]
      )
      const row = source.rows[0]
      if (!row) throw new Error('published character is unavailable for media generation')
      let bundleId = row.bundle_id
      let mediaRevision = Number(row.media_revision ?? 1)
      const sourceMarkupHash = row.source_markup_hash
      let sourceChanged = false
      if (!bundleId) {
        bundleId = idFactory()
        await client.query(
          `INSERT INTO character_media_bundles (
             id, book_edition_id, character_key, bundle_version, status,
             source_markup_hash, media_revision, expires_at
           ) VALUES ($1, $2, $3, $4, 'queued', $5, 1,
             CASE WHEN EXISTS (
               SELECT 1 FROM book_editions WHERE id = $2 AND scope = 'private'
             ) THEN now() + make_interval(days => $6) ELSE NULL END)`,
          [
            bundleId, bookEditionId, characterKey, bundleVersion,
            sourceMarkupHash, privateMaterialTtlDays
          ]
        )
        sourceChanged = true
      } else if (!row.previous_source_markup_hash) {
        await client.query(
          `UPDATE character_media_bundles
           SET source_markup_hash = $2, updated_at = now() WHERE id = $1`,
          [bundleId, sourceMarkupHash]
        )
      } else if (row.previous_source_markup_hash !== sourceMarkupHash) {
        mediaRevision += 1
        sourceChanged = true
        await client.query(
          `UPDATE character_media_bundles
           SET source_markup_hash = $2, media_revision = $3,
               status = 'queued', published_at = NULL, updated_at = now()
           WHERE id = $1`,
          [bundleId, sourceMarkupHash, mediaRevision]
        )
        await client.query(
          'DELETE FROM character_bundle_assets WHERE bundle_id = $1',
          [bundleId]
        )
      }
      const complete = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM character_bundle_assets AS link
         JOIN media_assets AS asset ON asset.id = link.asset_id AND asset.status = 'ready'
         WHERE link.bundle_id = $1 AND link.asset_type = ANY($2::text[])`,
        [bundleId, REQUIRED_CHARACTER_MEDIA]
      )
      if (!sourceChanged &&
          Number(complete.rows[0].count) === REQUIRED_CHARACTER_MEDIA.length) {
        if (row.bundle_status !== 'ready') {
          await client.query(
            `UPDATE character_media_bundles
             SET status = 'ready', published_at = COALESCE(published_at, now()),
                 updated_at = now()
             WHERE id = $1`,
            [bundleId]
          )
        }
        return { status: 'ready', created: false, jobs: [], bundleId, mediaRevision }
      }
      const targetVersion = characterMediaTargetVersion({ bundleVersion, mediaRevision })
      const jobs = []
      for (const assetType of REQUIRED_CHARACTER_MEDIA) {
        const idempotencyKey = characterMediaIdempotencyKey({
          bookEditionId, characterKey, targetVersion, assetType
        })
        const inserted = await client.query(
          `INSERT INTO generation_jobs (
             id, idempotency_key, job_type, book_edition_id, character_key,
             target_version, status, priority, payload
           ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING *`,
          [
            idFactory(), idempotencyKey, CHARACTER_MEDIA_JOB_TYPES[assetType],
            bookEditionId, characterKey, targetVersion, priority,
            JSON.stringify({
              asset_type: assetType,
              required_media: [assetType],
              bundle_version: bundleVersion,
              source_markup_hash: sourceMarkupHash,
              media_revision: mediaRevision,
              markup_version_id: row.markup_version_id
            })
          ]
        )
        let job = inserted.rows[0]
        if (!job) {
          const existing = await client.query(
            'SELECT * FROM generation_jobs WHERE idempotency_key = $1',
            [idempotencyKey]
          )
          job = existing.rows[0]
        }
        jobs.push({ ...jobRow(job), created: Boolean(inserted.rows[0]), idempotencyKey })
      }
      await client.query(
        `UPDATE character_media_bundles
         SET job_id = $2, status = CASE
           WHEN status = 'ready' AND $3 = false THEN status
           ELSE 'queued'
         END, updated_at = now()
         WHERE id = $1`,
        [bundleId, jobs.find((job) => job.type === 'character_portrait')?.id ?? null, sourceChanged]
      )
      return {
        status: jobs.every((job) => job.status === 'ready') ? 'ready' : 'queued',
        created: jobs.some((job) => job.created),
        jobs,
        bundleId,
        mediaRevision
      }
    })
  }

  return {
    async registerLocalBook({
      subjectId,
      proposedBookEditionId,
      contentSha256,
      title,
      author,
      format,
      language = null
    }) {
      return transaction(pool, async (client) => {
        const catalog = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format, status,
                  source_storage, expires_at, created_at
           FROM book_editions
           WHERE scope = 'catalog' AND content_sha256 = $1
             AND status IN ('base_ready', 'published')
           LIMIT 1`,
          [contentSha256]
        )
        if (catalog.rows[0]) return editionRow(catalog.rows[0])

        const existing = await client.query(
          `SELECT id, expires_at
           FROM book_editions
           WHERE scope = 'private' AND owner_subject_id = $1::uuid
             AND content_sha256 = $2
           FOR UPDATE`,
          [subjectId, contentSha256]
        )
        if (existing.rows[0]?.expires_at && new Date(existing.rows[0].expires_at) <= new Date()) {
          await queueBookObjectDeletions(client, [existing.rows[0].id])
          await client.query('DELETE FROM book_editions WHERE id = $1', [existing.rows[0].id])
        }

        await client.query(
          `INSERT INTO book_editions (
             id, scope, owner_subject_id, content_sha256, title, author, format, language,
             status, source_storage, expires_at
           ) VALUES (
             $1, 'private', $2::uuid, $3, $4, $5, $6, $7,
             'marking_up', 'local_only', now() + make_interval(days => $8)
           )
           ON CONFLICT (owner_subject_id, content_sha256) WHERE scope = 'private'
           DO UPDATE SET
             display_title = CASE
               WHEN book_editions.title IS DISTINCT FROM EXCLUDED.title OR
                    book_editions.author IS DISTINCT FROM EXCLUDED.author
                 THEN NULL ELSE book_editions.display_title END,
             display_author = CASE
               WHEN book_editions.title IS DISTINCT FROM EXCLUDED.title OR
                    book_editions.author IS DISTINCT FROM EXCLUDED.author
                 THEN NULL ELSE book_editions.display_author END,
             identity_version = CASE
               WHEN book_editions.title IS DISTINCT FROM EXCLUDED.title OR
                    book_editions.author IS DISTINCT FROM EXCLUDED.author
                 THEN NULL ELSE book_editions.identity_version END,
             identity_source = CASE
               WHEN book_editions.title IS DISTINCT FROM EXCLUDED.title OR
                    book_editions.author IS DISTINCT FROM EXCLUDED.author
                 THEN NULL ELSE book_editions.identity_source END,
             identity_updated_at = CASE
               WHEN book_editions.title IS DISTINCT FROM EXCLUDED.title OR
                    book_editions.author IS DISTINCT FROM EXCLUDED.author
                 THEN NULL ELSE book_editions.identity_updated_at END,
             title = EXCLUDED.title,
             author = EXCLUDED.author,
             format = EXCLUDED.format,
             language = COALESCE(EXCLUDED.language, book_editions.language),
             expires_at = now() + make_interval(days => $8),
             updated_at = now()`,
          [
            proposedBookEditionId, subjectId, contentSha256, title, author, format, language,
            privateMaterialTtlDays
          ]
        )
        const result = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format, status,
                  source_storage, expires_at, created_at
           FROM book_editions
           WHERE scope = 'private' AND owner_subject_id = $1::uuid
             AND content_sha256 = $2`,
          [subjectId, contentSha256]
        )
        await touchPrivateRetention(client, result.rows[0].id)
        return editionRow(result.rows[0])
      })
    },

    async beginPrivateBookUpload({
      subjectId,
      bookEditionId,
      contentSha256,
      objectKey,
      mimeType,
      byteSize
    }) {
      return transaction(pool, async (client) => {
        const editionResult = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format, status,
                  source_storage, expires_at, created_at
           FROM book_editions
           WHERE id = $1 AND scope = 'private' AND owner_subject_id = $2::uuid
             AND expires_at > now()
           FOR UPDATE`,
          [bookEditionId, subjectId]
        )
        const current = editionResult.rows[0]
        if (!current) return null
        if (current.content_sha256 !== contentSha256) {
          throw Object.assign(new Error('SHA-256 файла книги не совпадает с регистрацией'), {
            code: 'UPLOAD_INTEGRITY', status: 409
          })
        }
        if (BOOK_MIME_TYPES[current.format] !== mimeType) {
          throw Object.assign(new Error('Content-Type не совпадает с форматом книги'), {
            code: 'UPLOAD_INTEGRITY', status: 409
          })
        }
        const existingResult = await client.query(
          'SELECT * FROM book_files WHERE book_edition_id = $1 FOR UPDATE',
          [bookEditionId]
        )
        const existing = existingResult.rows[0]
        if (
          existing?.status === 'ready' &&
          existing.object_key === objectKey &&
          existing.content_hash === contentSha256 &&
          existing.mime_type === mimeType &&
          Number(existing.byte_size) === byteSize
        ) {
          await touchPrivateRetention(client, bookEditionId)
          return {
            edition: editionRow({ ...current, source_storage: 'temporary' }),
            uploadRequired: false,
            file: { objectKey, contentSha256, mimeType, byteSize }
          }
        }
        if (existing?.object_key && existing.object_key !== objectKey) {
          await client.query(
            `INSERT INTO book_object_deletions (object_key)
             VALUES ($1) ON CONFLICT (object_key) DO NOTHING`,
            [existing.object_key]
          )
        }
        await client.query(
          `INSERT INTO book_files (
             book_edition_id, object_key, mime_type, byte_size, content_hash, status
           ) VALUES ($1, $2, $3, $4, $5, 'staging')
           ON CONFLICT (book_edition_id) DO UPDATE SET
             object_key = EXCLUDED.object_key,
             mime_type = EXCLUDED.mime_type,
             byte_size = EXCLUDED.byte_size,
             content_hash = EXCLUDED.content_hash,
             status = 'staging'`,
          [bookEditionId, objectKey, mimeType, byteSize, contentSha256]
        )
        await client.query(
          `UPDATE book_editions
           SET source_storage = 'temporary', status = 'marking_up',
               expires_at = now() + make_interval(days => $2), updated_at = now()
           WHERE id = $1`,
          [bookEditionId, privateMaterialTtlDays]
        )
        return {
          edition: editionRow({
            ...current,
            status: 'marking_up',
            source_storage: 'temporary',
            expires_at: new Date(Date.now() + privateMaterialTtlDays * 86_400_000)
          }),
          uploadRequired: true,
          file: { objectKey, contentSha256, mimeType, byteSize }
        }
      })
    },

    async completePrivateBookUpload({ subjectId, bookEditionId }) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `SELECT edition.id, edition.content_sha256, edition.title, edition.author,
                  edition.identity_version
           FROM book_editions AS edition
           JOIN book_files AS file ON file.book_edition_id = edition.id
           WHERE edition.id = $1 AND edition.scope = 'private'
             AND edition.owner_subject_id = $2::uuid
             AND edition.expires_at > now()
           FOR UPDATE OF edition, file`,
          [bookEditionId, subjectId]
        )
        if (!result.rows[0]) return null
        await client.query(
          `UPDATE book_files SET status = 'ready' WHERE book_edition_id = $1`,
          [bookEditionId]
        )
        await client.query(
          `UPDATE book_editions
           SET source_storage = 'temporary', status = 'marking_up',
               expires_at = now() + make_interval(days => $2), updated_at = now()
           WHERE id = $1`,
          [bookEditionId, privateMaterialTtlDays]
        )
        await ensureBookIdentityJob(client, result.rows[0])
        const edition = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format, status,
                  source_storage, expires_at, created_at
           FROM book_editions WHERE id = $1`,
          [bookEditionId]
        )
        return editionRow(edition.rows[0])
      })
    },

    async publishLocalBookMarkup({
      subjectId,
      bookEditionId,
      analysisVersion,
      inputHash,
      textLength,
      characters
    }) {
      return transaction(pool, async (client) => {
        const editionResult = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format, status,
                  source_storage, expires_at, created_at
           FROM book_editions
           WHERE id = $1 AND scope = 'private' AND owner_subject_id = $2::uuid
             AND source_storage = 'local_only' AND expires_at > now()
           FOR UPDATE`,
          [bookEditionId, subjectId]
        )
        if (!editionResult.rows[0]) return null
        const existing = await client.query(
          `SELECT id, revision
           FROM book_markup_versions
           WHERE book_edition_id = $1 AND status = 'published'
             AND analysis_version = $2 AND input_hash = $3
           LIMIT 1`,
          [bookEditionId, analysisVersion, inputHash]
        )
        if (existing.rows[0]) {
          await touchPrivateRetention(client, bookEditionId)
          return {
            edition: editionRow(editionResult.rows[0]),
            markupId: existing.rows[0].id,
            revision: Number(existing.rows[0].revision),
            created: false
          }
        }

        const revisionResult = await client.query(
          `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
           FROM book_markup_versions WHERE book_edition_id = $1`,
          [bookEditionId]
        )
        const revision = Number(revisionResult.rows[0].revision)
        const markupId = idFactory()
        await client.query(
          `UPDATE book_markup_versions SET status = 'ready'
           WHERE book_edition_id = $1 AND status = 'published'`,
          [bookEditionId]
        )
        await client.query(
          `INSERT INTO book_markup_versions (
             id, book_edition_id, schema_version, analysis_version, revision,
             status, input_hash, text_length, published_at, expires_at
           ) VALUES (
             $1, $2, $3, $4, $5, 'published', $6, $7, now(),
             now() + make_interval(days => $8)
           )`,
          [
            markupId, bookEditionId, BOOK_MARKUP_SCHEMA_VERSION, analysisVersion,
            revision, inputHash, textLength, privateMaterialTtlDays
          ]
        )
        for (const [index, character] of characters.entries()) {
          await client.query(
            `INSERT INTO book_characters (
               id, markup_version_id, character_key, sort_order, name, full_name,
               first_appearance_text_offset, warmup_text_offset, data
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
              idFactory(), markupId, character.characterKey, index,
              character.name, character.fullName,
              character.firstAppearanceTextOffset, character.warmupTextOffset,
              JSON.stringify(character.profile)
            ]
          )
        }
        await client.query(
          `UPDATE book_editions
           SET status = 'base_ready', expires_at = now() + make_interval(days => $2),
               updated_at = now()
           WHERE id = $1`,
          [bookEditionId, privateMaterialTtlDays]
        )
        await touchPrivateRetention(client, bookEditionId)
        return {
          edition: editionRow({
            ...editionResult.rows[0],
            status: 'base_ready',
            expires_at: new Date(Date.now() + privateMaterialTtlDays * 86_400_000)
          }),
          markupId,
          revision,
          created: true
        }
      })
    },

    async beginCatalogBookUpload({
      proposedBookEditionId,
      catalogKey,
      contentSha256,
      title,
      author,
      format,
      language = null,
      objectKey,
      mimeType,
      byteSize
    }) {
      return transaction(pool, async (client) => {
        const existingResult = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format, status,
                  source_storage, expires_at, created_at
           FROM book_editions
           WHERE scope = 'catalog' AND catalog_key = $1
           FOR UPDATE`,
          [catalogKey]
        )
        const existing = existingResult.rows[0]
        if (existing && existing.content_sha256 !== contentSha256) {
          throw Object.assign(new Error('catalog key already belongs to different source bytes'), {
            code: 'CATALOG_CONFLICT', status: 409
          })
        }
        if (existing && language && existing.language !== language) {
          await client.query(
            'UPDATE book_editions SET language = $2, updated_at = now() WHERE id = $1',
            [existing.id, language]
          )
          existing.language = language
        }
        if (!existing) {
          await client.query(
            `INSERT INTO book_editions (
               id, scope, catalog_key, content_sha256, title, author, format, language,
               status, source_storage
             ) VALUES ($1, 'catalog', $2, $3, $4, $5, $6, $7, 'uploading', 'stored')`,
            [proposedBookEditionId, catalogKey, contentSha256, title, author, format, language]
          )
        }
        const editionId = existing?.id || proposedBookEditionId
        const fileResult = await client.query(
          'SELECT status FROM book_files WHERE book_edition_id = $1',
          [editionId]
        )
        if (fileResult.rows[0]?.status === 'ready') {
          return { edition: editionRow(existing), uploadRequired: false, fileReady: true }
        }
        await client.query(
          `INSERT INTO book_files (
             book_edition_id, object_key, mime_type, byte_size, content_hash, status
           ) VALUES ($1, $2, $3, $4, $5, 'staging')
           ON CONFLICT (book_edition_id) DO UPDATE SET
             object_key = EXCLUDED.object_key,
             mime_type = EXCLUDED.mime_type,
             byte_size = EXCLUDED.byte_size,
             content_hash = EXCLUDED.content_hash,
             status = 'staging'`,
          [editionId, objectKey, mimeType, byteSize, contentSha256]
        )
        const editionResult = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format, status,
                  source_storage, expires_at, created_at
           FROM book_editions WHERE id = $1`,
          [editionId]
        )
        return {
          edition: editionRow(editionResult.rows[0]),
          uploadRequired: true,
          fileReady: false,
          file: { objectKey, mimeType, byteSize, contentSha256 }
        }
      })
    },

    async getCatalogBookUpload({ bookEditionId }) {
      const result = await pool.query(
        `SELECT edition.id, edition.scope, edition.catalog_key,
                edition.content_sha256, edition.title, edition.author,
                edition.display_title, edition.display_author,
                edition.language, edition.format, edition.status, edition.source_storage,
                edition.expires_at, edition.created_at,
                file.object_key, file.mime_type, file.byte_size,
                file.content_hash, file.status AS file_status
         FROM book_editions AS edition
         JOIN book_files AS file ON file.book_edition_id = edition.id
         WHERE edition.id = $1 AND edition.scope = 'catalog'`,
        [bookEditionId]
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        edition: editionRow(row),
        file: {
          objectKey: row.object_key,
          mimeType: row.mime_type,
          byteSize: Number(row.byte_size),
          contentSha256: row.content_hash,
          status: row.file_status
        }
      }
    },

    async completeCatalogBookUpload({ bookEditionId }) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `SELECT edition.id, edition.content_sha256, edition.title, edition.author,
                  edition.identity_version
           FROM book_editions AS edition
           JOIN book_files AS file ON file.book_edition_id = edition.id
           WHERE edition.id = $1 AND edition.scope = 'catalog'
           FOR UPDATE OF edition, file`,
          [bookEditionId]
        )
        if (!result.rows[0]) return null
        await client.query(
          `UPDATE book_files SET status = 'ready' WHERE book_edition_id = $1`,
          [bookEditionId]
        )
        await client.query(
          `UPDATE book_editions SET status = 'marking_up', updated_at = now()
           WHERE id = $1 AND status IN ('draft', 'uploading', 'failed')`,
          [bookEditionId]
        )
        const targetVersion = catalogCoverTargetVersion(result.rows[0].content_sha256)
        await client.query(
          `INSERT INTO generation_jobs (
             id, idempotency_key, job_type, book_edition_id, character_key,
             target_version, status, priority, payload
           ) VALUES ($1, $2, 'catalog_cover', $3, NULL, $4, 'queued', 45, $5::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            idFactory(), `${bookEditionId}:catalog-cover:${targetVersion}`,
            bookEditionId, targetVersion,
            JSON.stringify({ content_sha256: result.rows[0].content_sha256 })
          ]
        )
        await ensureBookIdentityJob(client, result.rows[0])
        const edition = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format,
                  status, source_storage, expires_at, created_at
           FROM book_editions WHERE id = $1`,
          [bookEditionId]
        )
        return editionRow(edition.rows[0])
      })
    },

    async beginCatalogCoverUpload({
      bookEditionId,
      objectKey,
      contentSha256,
      mimeType,
      byteSize
    }) {
      return transaction(pool, async (client) => {
        const edition = await client.query(
          `SELECT id FROM book_editions
           WHERE id = $1 AND scope = 'catalog'
           FOR UPDATE`,
          [bookEditionId]
        )
        if (!edition.rows[0]) return null
        const currentResult = await client.query(
          'SELECT * FROM catalog_book_covers WHERE book_edition_id = $1 FOR UPDATE',
          [bookEditionId]
        )
        const current = currentResult.rows[0]
        if (
          current?.status === 'ready' &&
          current.content_hash === contentSha256 &&
          current.mime_type === mimeType &&
          Number(current.byte_size) === byteSize
        ) {
          return { cover: catalogCoverRow(current), uploadRequired: false }
        }
        if (current?.object_key && current.object_key !== objectKey) {
          await client.query(
            `INSERT INTO book_object_deletions (object_key)
             VALUES ($1) ON CONFLICT (object_key) DO NOTHING`,
            [current.object_key]
          )
        }
        const result = await client.query(
          `INSERT INTO catalog_book_covers (
             book_edition_id, object_key, content_hash, mime_type, byte_size, status
           ) VALUES ($1, $2, $3, $4, $5, 'staging')
           ON CONFLICT (book_edition_id) DO UPDATE SET
             object_key = EXCLUDED.object_key,
             content_hash = EXCLUDED.content_hash,
             mime_type = EXCLUDED.mime_type,
             byte_size = EXCLUDED.byte_size,
             status = 'staging',
             updated_at = now()
           RETURNING *`,
          [bookEditionId, objectKey, contentSha256, mimeType, byteSize]
        )
        return { cover: catalogCoverRow(result.rows[0]), uploadRequired: true }
      })
    },

    async getCatalogCoverUpload({ bookEditionId }) {
      const result = await pool.query(
        `SELECT cover.*
         FROM catalog_book_covers AS cover
         JOIN book_editions AS edition ON edition.id = cover.book_edition_id
         WHERE cover.book_edition_id = $1 AND edition.scope = 'catalog'`,
        [bookEditionId]
      )
      return catalogCoverRow(result.rows[0])
    },

    async completeCatalogCoverUpload({ bookEditionId }) {
      const result = await pool.query(
        `UPDATE catalog_book_covers AS cover
         SET status = 'ready', updated_at = now()
         FROM book_editions AS edition
         WHERE cover.book_edition_id = $1
           AND edition.id = cover.book_edition_id
           AND edition.scope = 'catalog'
         RETURNING cover.*`,
        [bookEditionId]
      )
      return catalogCoverRow(result.rows[0])
    },

    async getReaderBookSource({ bookEditionId }) {
      const result = await pool.query(
        `SELECT file.object_key, file.mime_type, file.byte_size, file.content_hash,
                edition.title, edition.format
         FROM book_editions AS edition
         JOIN book_files AS file ON file.book_edition_id = edition.id AND file.status = 'ready'
         WHERE edition.id = $1 AND edition.scope = 'catalog'
           AND edition.status IN ('base_ready', 'published')`,
        [bookEditionId]
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        objectKey: row.object_key,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        contentHash: row.content_hash,
        filename: `${row.title || 'book'}.${row.format}`
      }
    },

    async getReaderBookContent({ bookEditionId }) {
      const result = await pool.query(
         `SELECT edition.id AS book_edition_id,
                prepared.normalized_text_object_key, prepared.normalized_text_hash,
                prepared.text_length, prepared.normalization_version,
                prepared.content_navigation
         FROM book_editions AS edition
         JOIN LATERAL (
           SELECT run.normalized_text_object_key, run.normalized_text_hash,
                  run.text_length, run.normalization_version, run.content_navigation
           FROM book_analysis_runs AS run
           WHERE run.book_edition_id = edition.id
             AND run.input_hash = edition.content_sha256
             AND run.normalization_version = 'normalized-text-v1'
             AND run.normalized_text_object_key IS NOT NULL
             AND run.normalized_text_hash IS NOT NULL
           ORDER BY run.run_sequence DESC, run.created_at DESC
           LIMIT 1
         ) AS prepared ON true
         WHERE edition.id = $1 AND edition.scope = 'catalog'
           AND edition.status IN ('base_ready', 'published')`,
        [bookEditionId]
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        bookEditionId: row.book_edition_id,
        objectKey: row.normalized_text_object_key,
        contentHash: row.normalized_text_hash,
        textLength: Number(row.text_length),
        normalizationVersion: row.normalization_version,
        navigation: row.content_navigation ?? null
      }
    },

    async getCatalogBookCover({ bookEditionId }) {
      const result = await pool.query(
        `SELECT cover.object_key, cover.mime_type, cover.byte_size, cover.content_hash
         FROM catalog_book_covers AS cover
         JOIN book_editions AS edition ON edition.id = cover.book_edition_id
         WHERE cover.book_edition_id = $1
           AND cover.status = 'ready'
           AND edition.scope = 'catalog'
           AND edition.status IN ('base_ready', 'published')`,
        [bookEditionId]
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        objectKey: row.object_key,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        contentHash: row.content_hash,
        filename: `cover.${row.mime_type === 'image/png' ? 'png' : row.mime_type === 'image/webp' ? 'webp' : 'jpg'}`
      }
    },

    async getReaderMediaAsset({
      subjectId,
      bookEditionId,
      assetId,
      bundleVersion = CHARACTER_BUNDLE_VERSION
    }) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `SELECT asset.id, asset.object_key, asset.type, asset.content_hash,
                  asset.mime_type, asset.byte_size, edition.scope,
                  character.character_key, character.first_appearance_text_offset,
                  character.warmup_text_offset, character.data,
                  position.text_offset AS reader_text_offset,
                  position.section_index AS reader_section_index,
                  position.section_fraction AS reader_section_fraction
           FROM book_editions AS edition
           JOIN book_markup_versions AS markup
             ON markup.book_edition_id = edition.id AND markup.status = 'published'
           JOIN book_characters AS character ON character.markup_version_id = markup.id
           JOIN character_media_bundles AS bundle
             ON bundle.book_edition_id = edition.id
            AND bundle.character_key = character.character_key
            AND bundle.bundle_version = $4
           JOIN character_bundle_assets AS link ON link.bundle_id = bundle.id
           JOIN media_assets AS asset
             ON asset.id = link.asset_id AND asset.status = 'ready'
           LEFT JOIN reader_book_positions AS position
             ON position.subject_id = $2::uuid AND position.book_edition_id = edition.id
           WHERE edition.id = $1 AND asset.id = $3::uuid
             AND (
               (edition.scope = 'catalog' AND edition.status IN ('base_ready', 'published')) OR
               (edition.scope = 'private' AND edition.owner_subject_id = $2::uuid
                 AND edition.expires_at > now())
             )`,
          [bookEditionId, subjectId, assetId, bundleVersion]
        )
        const row = result.rows[0]
        if (!row) return null
        if (!hasReaderReachedCharacter({
          characterKey: row.character_key,
          firstAppearanceTextOffset: Number(row.first_appearance_text_offset),
          warmupTextOffset: Number(row.warmup_text_offset),
          data: row.data
        }, {
          textOffset: Number(row.reader_text_offset ?? 0),
          sectionIndex: row.reader_section_index == null
            ? null
            : Number(row.reader_section_index),
          sectionFraction: row.reader_section_fraction == null
            ? null
            : Number(row.reader_section_fraction)
        })) return null
        if (row.scope === 'private') await touchPrivateRetention(client, bookEditionId)
        return {
          assetId: row.id,
          objectKey: row.object_key,
          type: row.type,
          contentHash: row.content_hash,
          mimeType: row.mime_type,
          byteSize: Number(row.byte_size)
        }
      })
    },

    async ensureReaderBookScene({
      subjectId,
      bookEditionId,
      readerTextOffset = null,
      progressFraction = null,
      priority = 70
    }) {
      return transaction(pool, async (client) => {
        const context = await loadSceneContext(client, { subjectId, bookEditionId })
        if (!context) return null
        const canonicalOffset = progressFraction != null
          ? Math.round(context.textLength * Math.min(1, Math.max(0, progressFraction)))
          : readerTextOffset
        const slot = bookSceneSlotAt(
          context.policy,
          context.textLength,
          Math.min(context.textLength - 1, Math.max(0, canonicalOffset ?? 0))
        )
        const scene = await ensureSceneSlot(client, context, slot, priority)
        if (context.scope === 'private') await touchPrivateRetention(client, bookEditionId)
        return scene
      })
    },

    async ensureBookScenesThrough({
      subjectId,
      bookEditionId,
      readerTextOffset,
      priority = 45
    }) {
      return transaction(pool, async (client) => {
        const context = await loadSceneContext(client, { subjectId, bookEditionId })
        if (!context) return { requested: 0, ready: 0, pending: 0, failed: 0 }
        const frontier = bookMediaFrontier({
          scope: context.scope,
          textLength: context.textLength,
          readerTextOffset
        })
        const slots = bookSceneSlotsThrough(context.policy, context.textLength, frontier)
        const scenes = []
        for (const slot of slots) scenes.push(await ensureSceneSlot(client, context, slot, priority))
        if (context.scope === 'private') await touchPrivateRetention(client, bookEditionId)
        return {
          requested: scenes.length,
          ready: scenes.filter(({ status }) => status === 'ready').length,
          pending: scenes.filter(({ status }) => status === 'queued' || status === 'running').length,
          failed: scenes.filter(({ status }) => status === 'failed').length
        }
      })
    },

    async listCatalogBooks({ limit, cursor = null, language = null }) {
      const result = await pool.query(
        `SELECT edition.id, edition.scope, edition.catalog_key,
                edition.content_sha256, edition.title, edition.author,
                edition.display_title, edition.display_author,
                COALESCE((
                  SELECT array_agg(link.genre ORDER BY link.position)
                  FROM book_edition_genres AS link
                  WHERE link.book_edition_id = edition.id
                ), ARRAY[]::text[]) AS genres,
                edition.language, edition.format, edition.status, edition.source_storage,
                edition.expires_at, edition.created_at,
                popularity.popularity_rank AS catalog_popularity_rank,
                cover.object_key AS cover_object_key,
                cover.content_hash AS cover_content_hash,
                cover.mime_type AS cover_mime_type,
                cover.byte_size AS cover_byte_size,
                cover.status AS cover_status
         FROM book_editions AS edition
         LEFT JOIN catalog_book_covers AS cover
           ON cover.book_edition_id = edition.id AND cover.status = 'ready'
         LEFT JOIN catalog_book_popularity_aliases AS popularity_alias
           ON popularity_alias.catalog_key = edition.catalog_key
         LEFT JOIN catalog_book_popularity AS popularity
           ON popularity.source_key = COALESCE(popularity_alias.source_key, CASE
             WHEN edition.catalog_key ~ '^narra-ru-top100-.+-[0-9a-f]{8}$' THEN
               regexp_replace(
                 substr(edition.catalog_key, length('narra-ru-top100-') + 1),
                 '-[0-9a-f]{8}$',
                 ''
               )
             WHEN edition.catalog_key ~ '^narra-ru-[0-9]+-.+$' THEN
               regexp_replace(edition.catalog_key, '^narra-ru-[0-9]+-', '')
             ELSE edition.catalog_key
           END)
         WHERE edition.scope = 'catalog'
           AND edition.status IN ('base_ready', 'published')
           AND edition.catalog_hidden_at IS NULL
           AND (
             $2::timestamptz IS NULL OR
             COALESCE(popularity.popularity_rank, 2147483647) >
               COALESCE($1::integer, 2147483647) OR
             (
               COALESCE(popularity.popularity_rank, 2147483647) =
                 COALESCE($1::integer, 2147483647)
               AND (edition.created_at, edition.id) < ($2::timestamptz, $3::uuid)
             )
           )
           AND ($5::text IS NULL OR edition.language = $5)
         ORDER BY popularity.popularity_rank ASC NULLS LAST,
                  edition.created_at DESC, edition.id DESC
         LIMIT $4`,
        [
          cursor?.popularityRank ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1,
          language
        ]
      )
      const hasMore = result.rows.length > limit
      const items = result.rows.slice(0, limit).map(editionRow)
      const last = items.at(-1)
      return {
        items,
        nextCursor: hasMore && last
          ? {
              popularityRank: last.catalogPopularityRank,
              createdAt: last.createdAt,
              id: last.id
            }
          : null
      }
    },

    async hideReplacedCatalogBook({ bookEditionId, replacedByBookEditionId }) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `UPDATE book_editions AS old_edition
           SET catalog_hidden_at = now(),
               replaced_by_book_edition_id = replacement.id,
               updated_at = now()
           FROM book_editions AS replacement
           WHERE old_edition.id = $1
             AND replacement.id = $2
             AND old_edition.id <> replacement.id
             AND old_edition.scope = 'catalog'
             AND replacement.scope = 'catalog'
             AND old_edition.language IS NOT DISTINCT FROM replacement.language
             AND lower(btrim(COALESCE(NULLIF(old_edition.display_title, ''), old_edition.title))) =
                 lower(btrim(COALESCE(NULLIF(replacement.display_title, ''), replacement.title)))
             AND old_edition.content_sha256 <> replacement.content_sha256
             AND replacement.status IN ('base_ready', 'published')
             AND EXISTS (
               SELECT 1 FROM book_analysis_publications AS publication
               WHERE publication.book_edition_id = replacement.id
             )
           RETURNING old_edition.id, old_edition.catalog_hidden_at,
                     old_edition.replaced_by_book_edition_id`,
          [bookEditionId, replacedByBookEditionId]
        )
        return result.rows[0] || null
      })
    },

    async resolveBook({ subjectId, source, catalogKey, contentSha256 }) {
      if (source === 'catalog') {
        const result = await pool.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format,
                  status, source_storage, expires_at, created_at
           FROM book_editions
           WHERE scope = 'catalog' AND catalog_key = $1
             AND status <> 'failed'
           LIMIT 1`,
          [catalogKey]
        )
        return editionRow(result.rows[0])
      }
      return transaction(pool, async (client) => {
        const result = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format,
                  status, source_storage, expires_at, created_at
           FROM book_editions
           WHERE content_sha256 = $2 AND (
             (scope = 'catalog' AND status IN ('base_ready', 'published')) OR
             (scope = 'private' AND owner_subject_id = $1::uuid
               AND expires_at > now())
           )
           ORDER BY CASE WHEN scope = 'catalog' THEN 0 ELSE 1 END, created_at DESC
           LIMIT 1`,
          [subjectId, contentSha256]
        )
        const edition = editionRow(result.rows[0])
        if (edition?.scope === 'private') await touchPrivateRetention(client, edition.id)
        return edition
      })
    },

    async getReaderBookIdentity({ subjectId, bookEditionId }) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `SELECT id, scope, content_sha256, title, author,
                  display_title, display_author, identity_version,
                  identity_source, identity_updated_at
           FROM book_editions
           WHERE id = $1 AND (
             (scope = 'catalog' AND status <> 'failed') OR
             (scope = 'private' AND owner_subject_id = $2::uuid
               AND expires_at > now())
           )
           FOR SHARE`,
          [bookEditionId, subjectId]
        )
        const edition = result.rows[0]
        if (!edition) return null
        if (edition.scope === 'private') await touchPrivateRetention(client, edition.id)

        const spec = identityJobSpec(edition)
        if (edition.identity_version === spec.targetVersion && edition.display_title) {
          const identity = normalizeBookDisplayIdentity({
            title: edition.display_title,
            author: edition.display_author
          })
          return {
            bookEditionId: edition.id,
            version: BOOK_IDENTITY_VERSION,
            status: 'ready',
            title: identity.title,
            author: identity.author,
            source: edition.identity_source === 'llm' ? 'llm' : 'deterministic',
            updatedAt: edition.identity_updated_at instanceof Date
              ? edition.identity_updated_at.toISOString()
              : String(edition.identity_updated_at)
          }
        }

        const jobResult = await client.query(
          `SELECT status, last_error_code
           FROM generation_jobs
           WHERE book_edition_id = $1 AND job_type = 'book_identity'
             AND target_version = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [bookEditionId, spec.targetVersion]
        )
        const job = jobResult.rows[0]
        return {
          bookEditionId: edition.id,
          version: BOOK_IDENTITY_VERSION,
          status: job?.status === 'failed' ? 'failed' : 'processing',
          errorCode: job?.status === 'failed' && typeof job.last_error_code === 'string'
            ? job.last_error_code
            : undefined
        }
      })
    },

    async getReaderBookManifest({ subjectId, bookEditionId, bundleVersion }) {
      return transaction(pool, async (client) => {
        const editionResult = await client.query(
          `SELECT id, scope, catalog_key, content_sha256, title, author,
                  display_title, display_author, language, format, status,
                  source_storage, expires_at, created_at
           FROM book_editions
           WHERE id = $1 AND (
             (scope = 'catalog' AND status IN ('base_ready', 'published')) OR
             (scope = 'private' AND owner_subject_id = $2::uuid
               AND expires_at > now())
           )
           FOR SHARE`,
          [bookEditionId, subjectId]
        )
        const edition = editionRow(editionResult.rows[0])
        if (!edition) return null
        if (edition.scope === 'private') await touchPrivateRetention(client, edition.id)
        const positionResult = await client.query(
          `SELECT text_offset, reading_fraction, section_index, section_fraction
           FROM reader_book_positions
           WHERE subject_id = $1::uuid AND book_edition_id = $2`,
          [subjectId, bookEditionId]
        )
        const readerTextOffset = Number(positionResult.rows[0]?.text_offset ?? 0)
        const readingFraction = positionResult.rows[0]?.reading_fraction == null
          ? null
          : Number(positionResult.rows[0].reading_fraction)
        const readerSectionIndex = positionResult.rows[0]?.section_index == null
          ? null
          : Number(positionResult.rows[0].section_index)
        const readerSectionFraction = positionResult.rows[0]?.section_fraction == null
          ? null
          : Number(positionResult.rows[0].section_fraction)
        const markupResult = await client.query(
          `SELECT id, schema_version, analysis_version, revision, text_length, published_at
           FROM book_markup_versions
           WHERE book_edition_id = $1 AND status = 'published'
           LIMIT 1`,
          [bookEditionId]
        )
        const markupRow = markupResult.rows[0]
        if (!markupRow) {
          return {
            edition,
            readerTextOffset,
            readingFraction,
            readerSectionIndex,
            readerSectionFraction,
            markup: null,
            characters: []
          }
        }
        const characterResult = await client.query(
          `SELECT character.character_key, character.name, character.full_name,
                  character.first_appearance_text_offset,
                  character.warmup_text_offset, character.data,
                  bundle.id AS bundle_id, bundle.bundle_version,
                  bundle.media_revision, bundle.status AS bundle_status,
                  asset.id AS asset_id, asset.type AS asset_type,
                  asset.content_hash, asset.mime_type, asset.byte_size,
                  asset.status AS asset_status
           FROM book_characters AS character
           LEFT JOIN character_media_bundles AS bundle
             ON bundle.book_edition_id = $2
            AND bundle.character_key = character.character_key
            AND bundle.bundle_version = $3
           LEFT JOIN character_bundle_assets AS link ON link.bundle_id = bundle.id
           LEFT JOIN media_assets AS asset ON asset.id = link.asset_id
           WHERE character.markup_version_id = $1
           ORDER BY character.sort_order, asset.type`,
          [markupRow.id, bookEditionId, bundleVersion]
        )
        const characters = []
        const byKey = new Map()
        for (const row of characterResult.rows) {
          let character = byKey.get(row.character_key)
          if (!character) {
            character = {
              characterKey: row.character_key,
              name: row.name,
              fullName: row.full_name,
              firstAppearanceTextOffset: Number(row.first_appearance_text_offset),
              warmupTextOffset: Number(row.warmup_text_offset),
              data: row.data,
              bundle: row.bundle_id
                ? {
                    version: Number(row.media_revision ?? 1) > 1
                      ? `${row.bundle_version}:r${Number(row.media_revision)}`
                      : row.bundle_version,
                    status: row.bundle_status,
                    assets: []
                  }
                : null
            }
            byKey.set(row.character_key, character)
            characters.push(character)
          }
          if (row.asset_id && character.bundle) {
            character.bundle.assets.push({
              assetId: row.asset_id,
              type: row.asset_type,
              contentHash: row.content_hash,
              mimeType: row.mime_type,
              byteSize: Number(row.byte_size),
              status: row.asset_status
            })
          }
        }
        return {
          edition,
          readerTextOffset,
          readingFraction,
          readerSectionIndex,
          readerSectionFraction,
          markup: {
            schemaVersion: Number(markupRow.schema_version),
            analysisVersion: markupRow.analysis_version,
            revision: Number(markupRow.revision),
            textLength: markupRow.text_length == null ? null : Number(markupRow.text_length),
            publishedAt: markupRow.published_at instanceof Date
              ? markupRow.published_at.toISOString()
              : String(markupRow.published_at)
          },
          characters
        }
      })
    },

    async advanceReaderPosition({
      subjectId,
      bookEditionId,
      progressFraction = null,
      textOffset = null,
      chapterKey = null,
      sectionIndex = null,
      sectionFraction = null
    }) {
      return transaction(pool, async (client) => {
        const edition = await client.query(
          `SELECT edition.id, edition.scope, markup.text_length, markup.analysis_version
           FROM book_editions AS edition
           LEFT JOIN book_markup_versions AS markup
             ON markup.book_edition_id = edition.id AND markup.status = 'published'
           WHERE edition.id = $1 AND (
             (edition.scope = 'catalog' AND edition.status IN ('base_ready', 'published')) OR
             (edition.scope = 'private' AND edition.owner_subject_id = $2::uuid
               AND edition.expires_at > now())
           )
           FOR SHARE OF edition`,
          [bookEditionId, subjectId]
        )
        if (!edition.rows[0]) return null
        await touchPrivateRetention(client, bookEditionId)
        const textLength = edition.rows[0].text_length == null
          ? null
          : Number(edition.rows[0].text_length)
        const canonicalOffset = progressFraction != null && textLength
          ? Math.round(textLength * progressFraction)
          : 0
        const proposedTextOffset = Math.max(textOffset ?? 0, canonicalOffset)
        const position = await client.query(
           `INSERT INTO reader_book_positions (
             subject_id, book_edition_id, text_offset, reading_fraction, chapter_key,
             section_index, section_fraction
           ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (subject_id, book_edition_id) DO UPDATE SET
             chapter_key = CASE
               WHEN EXCLUDED.text_offset > reader_book_positions.text_offset OR (
                 EXCLUDED.text_offset = reader_book_positions.text_offset AND
                 COALESCE(EXCLUDED.reading_fraction, -1) >=
                   COALESCE(reader_book_positions.reading_fraction, -1)
               )
               THEN EXCLUDED.chapter_key
               ELSE reader_book_positions.chapter_key
             END,
             text_offset = GREATEST(reader_book_positions.text_offset, EXCLUDED.text_offset),
             reading_fraction = CASE
               WHEN EXCLUDED.reading_fraction IS NULL
               THEN reader_book_positions.reading_fraction
               ELSE GREATEST(
                 COALESCE(reader_book_positions.reading_fraction, 0),
                 EXCLUDED.reading_fraction
               )
             END,
             section_index = CASE
               WHEN EXCLUDED.section_index IS NULL AND (
                 EXCLUDED.text_offset > reader_book_positions.text_offset OR
                 COALESCE(EXCLUDED.reading_fraction, -1) >
                   COALESCE(reader_book_positions.reading_fraction, -1)
               ) THEN NULL
               WHEN EXCLUDED.section_index IS NOT NULL AND (
                 reader_book_positions.section_index IS NULL OR
                 EXCLUDED.section_index > reader_book_positions.section_index OR (
                   EXCLUDED.section_index = reader_book_positions.section_index AND
                   COALESCE(EXCLUDED.section_fraction, 0) >=
                     COALESCE(reader_book_positions.section_fraction, 0)
                 )
               ) THEN EXCLUDED.section_index
               ELSE reader_book_positions.section_index
             END,
             section_fraction = CASE
               WHEN EXCLUDED.section_index IS NULL AND (
                 EXCLUDED.text_offset > reader_book_positions.text_offset OR
                 COALESCE(EXCLUDED.reading_fraction, -1) >
                   COALESCE(reader_book_positions.reading_fraction, -1)
               ) THEN NULL
               WHEN EXCLUDED.section_index IS NOT NULL AND (
                 reader_book_positions.section_index IS NULL OR
                 EXCLUDED.section_index > reader_book_positions.section_index OR (
                   EXCLUDED.section_index = reader_book_positions.section_index AND
                   COALESCE(EXCLUDED.section_fraction, 0) >=
                     COALESCE(reader_book_positions.section_fraction, 0)
                 )
               ) THEN EXCLUDED.section_fraction
               ELSE reader_book_positions.section_fraction
             END,
             updated_at = now()
           RETURNING text_offset, reading_fraction, chapter_key, section_index, section_fraction`,
          [
            subjectId, bookEditionId, proposedTextOffset, progressFraction, chapterKey,
            sectionIndex, sectionFraction
          ]
        )
        const readerTextOffset = Number(position.rows[0].text_offset)
        const readingFraction = position.rows[0].reading_fraction == null
          ? null
          : Number(position.rows[0].reading_fraction)
        const readerSectionIndex = position.rows[0].section_index == null
          ? null
          : Number(position.rows[0].section_index)
        const readerSectionFraction = position.rows[0].section_fraction == null
          ? null
          : Number(position.rows[0].section_fraction)
        const mediaFrontier = textLength
          ? bookMediaFrontier({
              scope: edition.rows[0].scope,
              textLength,
              readerTextOffset
            })
          : readerTextOffset
        const due = await client.query(
          `SELECT character.character_key,
                  character.first_appearance_text_offset,
                  character.warmup_text_offset
           FROM book_markup_versions AS markup
           JOIN book_characters AS character ON character.markup_version_id = markup.id
           WHERE markup.book_edition_id = $1 AND markup.status = 'published'
             AND character.warmup_text_offset <= $2
           ORDER BY character.warmup_text_offset,
                    character.first_appearance_text_offset,
                    character.character_key`,
          [bookEditionId, mediaFrontier]
        )
        return {
          scope: edition.rows[0].scope,
          analysisVersion: edition.rows[0].analysis_version ?? null,
          readerTextOffset,
          readingFraction,
          chapterKey: position.rows[0].chapter_key,
          readerSectionIndex,
          readerSectionFraction,
          mediaFrontier,
          charactersDue: due.rows.map((row) => ({
            characterKey: row.character_key,
            firstAppearanceTextOffset: Number(row.first_appearance_text_offset),
            warmupTextOffset: Number(row.warmup_text_offset)
          }))
        }
      })
    },

    async enqueueBookMarkup({
      bookEditionId,
      analysisVersion = BOOK_MARKUP_ANALYSIS_VERSION,
      priority = 50
    }) {
      const idempotencyKey = `${bookEditionId}:book-markup:${analysisVersion}`
      const ensured = await ensureJob({
        idempotencyKey,
        type: 'book_markup',
        bookEditionId,
        targetVersion: analysisVersion,
        priority
      })
      return { ...jobRow(ensured.row), created: ensured.created, idempotencyKey }
    },

    async enqueueBookMarkupBackfill({
      analysisVersion = BOOK_MARKUP_ANALYSIS_VERSION,
      priority = 40,
      limit = 100
    } = {}) {
      const candidates = await pool.query(
        `SELECT edition.id
         FROM book_editions AS edition
         JOIN book_files AS file
           ON file.book_edition_id = edition.id AND file.status = 'ready'
         WHERE NOT EXISTS (
           SELECT 1 FROM book_markup_versions AS markup
           WHERE markup.book_edition_id = edition.id
             AND markup.status = 'published'
             AND markup.analysis_version = $1
             AND markup.text_length IS NOT NULL
         ) AND NOT EXISTS (
           SELECT 1 FROM generation_jobs AS job
           WHERE job.book_edition_id = edition.id
             AND job.job_type = 'book_markup'
             AND job.target_version = $1
             AND job.status <> 'failed'
         )
         ORDER BY edition.created_at, edition.id
         LIMIT $2`,
        [analysisVersion, limit]
      )
      const jobs = []
      for (const candidate of candidates.rows) {
        const idempotencyKey = `${candidate.id}:book-markup:${analysisVersion}`
        const ensured = await ensureJob({
          idempotencyKey,
          type: 'book_markup',
          bookEditionId: candidate.id,
          targetVersion: analysisVersion,
          priority
        })
        let row = ensured.row
        if (row.status === 'failed') {
          const reset = await pool.query(
            `UPDATE generation_jobs
             SET status = 'queued', attempts = 0, last_error_code = NULL,
                 available_at = now(), locked_at = NULL, locked_by = NULL,
                 lease_token = NULL, updated_at = now()
             WHERE id = $1 AND status = 'failed'
             RETURNING *`,
            [row.id]
          )
          row = reset.rows[0] || row
        }
        jobs.push({ ...jobRow(row), created: ensured.created, idempotencyKey })
      }
      return jobs
    },

    async enqueueBookIdentity({ bookEditionId, priority = 60 }) {
      return transaction(pool, async (client) => {
        const edition = await client.query(
          `SELECT edition.id, edition.content_sha256, edition.title, edition.author,
                  edition.identity_version
           FROM book_editions AS edition
           JOIN book_files AS file
             ON file.book_edition_id = edition.id AND file.status = 'ready'
           WHERE edition.id = $1
           FOR SHARE OF edition`,
          [bookEditionId]
        )
        if (!edition.rows[0]) return null
        return ensureBookIdentityJob(client, edition.rows[0], priority)
      })
    },

    async enqueueMissingBookIdentities({ priority = 60, limit = 10_000 } = {}) {
      const candidates = await pool.query(
        `SELECT edition.id, edition.content_sha256, edition.title, edition.author,
                edition.identity_version
         FROM book_editions AS edition
         JOIN book_files AS file
           ON file.book_edition_id = edition.id AND file.status = 'ready'
         WHERE edition.identity_version IS NULL
            OR edition.identity_version NOT LIKE $2
         ORDER BY edition.created_at, edition.id
         LIMIT $1`,
        [limit, `${BOOK_IDENTITY_VERSION}-%`]
      )
      const jobs = []
      for (const candidate of candidates.rows) {
        const job = await this.enqueueBookIdentity({
          bookEditionId: candidate.id,
          priority
        })
        if (job) jobs.push(job)
      }
      return jobs
    },

    async replaceBookEditionGenres({ bookEditionId, genres }) {
      return transaction(pool, async (client) => {
        const edition = await client.query(
          `SELECT id FROM book_editions
           WHERE id = $1 AND scope = 'catalog'
           FOR UPDATE`,
          [bookEditionId]
        )
        if (!edition.rows[0]) return false
        await client.query(
          'DELETE FROM book_edition_genres WHERE book_edition_id = $1',
          [bookEditionId]
        )
        if (genres.length > 0) {
          await client.query(
            `INSERT INTO book_edition_genres (book_edition_id, genre, position)
             SELECT $1, value, ordinality::smallint
             FROM unnest($2::text[]) WITH ORDINALITY AS item(value, ordinality)`,
            [bookEditionId, genres]
          )
        }
        return true
      })
    },

    async enqueueCatalogCover({
      bookEditionId,
      priority = 45
    }) {
      const edition = await pool.query(
        `SELECT edition.id, edition.content_sha256
         FROM book_editions AS edition
         WHERE edition.id = $1 AND edition.scope = 'catalog'
           AND edition.status IN ('marking_up', 'generating_portraits', 'base_ready', 'published')
           AND NOT EXISTS (
             SELECT 1 FROM catalog_book_covers AS cover
             WHERE cover.book_edition_id = edition.id AND cover.status = 'ready'
           )`,
        [bookEditionId]
      )
      const row = edition.rows[0]
      if (!row) return null
      const targetVersion = catalogCoverTargetVersion(row.content_sha256)
      const idempotencyKey = `${bookEditionId}:catalog-cover:${targetVersion}`
      const ensured = await ensureJob({
        idempotencyKey,
        type: 'catalog_cover',
        bookEditionId,
        targetVersion,
        priority,
        payload: { content_sha256: row.content_sha256 }
      })
      return { ...jobRow(ensured.row), created: ensured.created, idempotencyKey }
    },

    async enqueueMissingCatalogCovers({ priority = 45, limit = 1_000 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new RangeError('catalog cover limit must be between 1 and 10000')
      }
      const candidates = await pool.query(
        `SELECT edition.id
         FROM book_editions AS edition
         WHERE edition.scope = 'catalog'
           AND edition.status IN ('marking_up', 'generating_portraits', 'base_ready', 'published')
           AND NOT EXISTS (
             SELECT 1 FROM catalog_book_covers AS cover
             WHERE cover.book_edition_id = edition.id AND cover.status = 'ready'
           )
         ORDER BY edition.created_at, edition.id
         LIMIT $1`,
        [limit]
      )
      const jobs = []
      for (const candidate of candidates.rows) {
        const job = await this.enqueueCatalogCover({
          bookEditionId: candidate.id,
          priority
        })
        if (job) jobs.push(job)
      }
      return jobs
    },

    async ensureCharacterBundle({
      bookEditionId,
      characterKey,
      bundleVersion = CHARACTER_BUNDLE_VERSION,
      priority = 50
    }) {
      const ensured = await ensureCharacterMediaJobs({
        bookEditionId, characterKey, bundleVersion, priority
      })
      return {
        id: ensured.jobs[0]?.id,
        idempotencyKey: ensured.jobs[0]?.idempotencyKey,
        status: ensured.status,
        created: ensured.created,
        jobs: ensured.jobs,
        bundleVersion,
        mediaRevision: ensured.mediaRevision
      }
    },

    async enqueueCharacterMediaBackfill({ priority = 40, limit = 1_000 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new RangeError('character media backfill limit must be between 1 and 10000')
      }
      const candidates = await pool.query(
        `SELECT markup.book_edition_id, character.character_key,
                CASE WHEN markup.analysis_version = 'book-markup-v3'
                  THEN 'character-bundle-v3'
                  ELSE $1
                END AS bundle_version
         FROM book_markup_versions AS markup
         JOIN book_editions AS edition ON edition.id = markup.book_edition_id
         JOIN book_characters AS character ON character.markup_version_id = markup.id
         LEFT JOIN character_media_bundles AS bundle
           ON bundle.book_edition_id = markup.book_edition_id
          AND bundle.character_key = character.character_key
          AND bundle.bundle_version = CASE WHEN markup.analysis_version = 'book-markup-v3'
            THEN 'character-bundle-v3'
            ELSE $1
          END
         WHERE markup.status = 'published'
           AND (bundle.id IS NULL OR bundle.status <> 'ready')
           AND (
             edition.scope = 'catalog' OR
             character.warmup_text_offset <= LEAST(
               markup.text_length,
               COALESCE((
                 SELECT MAX(position.text_offset)
                 FROM reader_book_positions AS position
                 WHERE position.book_edition_id = markup.book_edition_id
               ), 0) + CEIL(markup.text_length * 0.1)::bigint
             )
           )
         ORDER BY markup.book_edition_id, character.sort_order, character.character_key
         LIMIT $2`,
        [CHARACTER_BUNDLE_VERSION, limit]
      )
      const jobs = []
      for (const candidate of candidates.rows) {
        const ensured = await ensureCharacterMediaJobs({
          bookEditionId: candidate.book_edition_id,
          characterKey: candidate.character_key,
          bundleVersion: candidate.bundle_version,
          priority
        })
        jobs.push(...ensured.jobs)
      }
      return jobs
    },

    async enqueueBookSceneBackfill({ priority = 35, limit = 1_000 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new RangeError('book scene backfill limit must be between 1 and 10000')
      }
      const candidates = await pool.query(
        `SELECT edition.id,
                COALESCE(MAX(position.text_offset), 0)::bigint AS reader_text_offset
         FROM book_editions AS edition
         JOIN book_markup_versions AS markup
           ON markup.book_edition_id = edition.id
          AND markup.status = 'published'
          AND markup.analysis_version = 'book-markup-v3'
         LEFT JOIN reader_book_positions AS position
           ON position.book_edition_id = edition.id
         WHERE edition.scope = 'catalog' OR edition.expires_at > now()
         GROUP BY edition.id, edition.created_at
         ORDER BY edition.created_at, edition.id
         LIMIT $1`,
        [limit]
      )
      const results = []
      for (const candidate of candidates.rows) {
        const result = await transaction(pool, async (client) => {
          const context = await loadSceneContext(client, {
            subjectId: null,
            bookEditionId: candidate.id
          })
          if (!context) return { requested: 0, ready: 0, pending: 0, failed: 0 }
          const frontier = bookMediaFrontier({
            scope: context.scope,
            textLength: context.textLength,
            readerTextOffset: Number(candidate.reader_text_offset)
          })
          const scenes = []
          for (const slot of bookSceneSlotsThrough(context.policy, context.textLength, frontier)) {
            scenes.push(await ensureSceneSlot(client, context, slot, priority))
          }
          return {
            requested: scenes.length,
            ready: scenes.filter(({ status }) => status === 'ready').length,
            pending: scenes.filter(({ status }) => status === 'queued' || status === 'running').length,
            failed: scenes.filter(({ status }) => status === 'failed').length
          }
        })
        results.push({ bookEditionId: candidate.id, ...result })
      }
      return results
    },

    async retryFailedGenerationJobs({ limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError('retry limit must be between 1 and 1000')
      }
      return transaction(pool, async (client) => {
        const retried = await client.query(
          `WITH candidates AS (
             SELECT id FROM generation_jobs
             WHERE status = 'failed'
             ORDER BY updated_at, created_at
             FOR UPDATE SKIP LOCKED
             LIMIT $1
           )
           UPDATE generation_jobs AS job
           SET status = 'queued', attempts = 0, last_error_code = NULL,
               available_at = now(), locked_at = NULL, locked_by = NULL,
               lease_token = NULL, updated_at = now()
           FROM candidates
           WHERE job.id = candidates.id
           RETURNING job.*`,
          [limit]
        )
        const characterJobs = retried.rows.filter((row) => row.character_key)
        for (const row of characterJobs) {
          const bundleVersion = row.payload?.bundle_version ?? row.target_version
          await client.query(
            `UPDATE character_media_bundles
             SET status = 'queued', updated_at = now()
             WHERE book_edition_id = $1 AND character_key = $2
               AND bundle_version = $3`,
            [row.book_edition_id, row.character_key, bundleVersion]
          )
        }
        return retried.rows.map((row) => jobRow(row))
      })
    },

    async purgeExpiredPrivateEditions({ limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError('cleanup limit must be between 1 and 1000')
      }
      return transaction(pool, async (client) => {
        const candidates = await client.query(
          `SELECT id
           FROM book_editions
           WHERE scope = 'private' AND expires_at <= now()
           ORDER BY expires_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $1`,
          [limit]
        )
        const ids = candidates.rows.map((row) => row.id)
        if (!ids.length) return { deletedEditions: 0, queuedObjects: 0 }
        const queuedObjects = await queueBookObjectDeletions(client, ids)
        await client.query(
          'DELETE FROM book_editions WHERE id = ANY($1::uuid[])',
          [ids]
        )
        return { deletedEditions: ids.length, queuedObjects }
      })
    },

    async listBookObjectDeletions({ limit = 100 } = {}) {
      const result = await pool.query(
        `SELECT object_key
         FROM book_object_deletions
         ORDER BY requested_at, object_key
         LIMIT $1`,
        [limit]
      )
      return result.rows.map((row) => row.object_key)
    },

    async acknowledgeBookObjectDeletions(objectKeys) {
      if (!Array.isArray(objectKeys) || !objectKeys.length) return 0
      const result = await pool.query(
        `DELETE FROM book_object_deletions
         WHERE object_key = ANY($1::text[])
         RETURNING object_key`,
        [objectKeys]
      )
      return result.rows.length
    },

    async failBookObjectDeletions(objectKeys, errorCode) {
      if (!Array.isArray(objectKeys) || !objectKeys.length) return 0
      const result = await pool.query(
        `UPDATE book_object_deletions
         SET attempts = attempts + 1, last_error_code = $2, updated_at = now()
         WHERE object_key = ANY($1::text[])
         RETURNING object_key`,
        [objectKeys, errorCode]
      )
      return result.rows.length
    },

    async claimGenerationJob(workerId, {
      leaseSeconds = 300,
      jobTypes = null,
      bookEditionIds = null
    } = {}) {
      const allowedJobTypes = Array.isArray(jobTypes) && jobTypes.length
        ? [...new Set(jobTypes)]
        : null
      const allowedBookEditionIds = Array.isArray(bookEditionIds) && bookEditionIds.length
        ? [...new Set(bookEditionIds)]
        : null
      if (allowedBookEditionIds?.some((value) => !UUID.test(String(value)))) {
        throw new TypeError('bookEditionIds must contain UUIDs')
      }
      const leaseToken = idFactory()
      const result = await pool.query(
        `WITH candidate AS (
           SELECT id
           FROM generation_jobs
           WHERE ($4::text[] IS NULL OR job_type = ANY($4::text[]))
             AND ($5::uuid[] IS NULL OR book_edition_id = ANY($5::uuid[])) AND ((
             status = 'queued' AND available_at <= now()
           ) OR (
             status = 'running' AND locked_at < now() - make_interval(secs => $2)
           )) AND (
             job_type <> 'character_animation' OR EXISTS (
               SELECT 1 FROM generation_jobs AS portrait
               WHERE portrait.book_edition_id = generation_jobs.book_edition_id
                 AND portrait.character_key = generation_jobs.character_key
                 AND portrait.target_version = generation_jobs.target_version
                 AND portrait.job_type = 'character_portrait'
               AND portrait.status = 'ready'
             )
           ) AND (
             job_type <> 'catalog_cover' OR NOT EXISTS (
               SELECT 1 FROM generation_jobs AS identity
               WHERE identity.book_edition_id = generation_jobs.book_edition_id
                 AND identity.job_type = 'book_identity'
                 AND identity.status IN ('queued', 'running')
             )
           )
           ORDER BY priority DESC, available_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE generation_jobs AS job
         SET status = 'running', locked_at = now(), locked_by = $1,
             lease_token = $3::uuid, attempts = attempts + 1, updated_at = now()
         FROM candidate
         WHERE job.id = candidate.id
         RETURNING job.*`,
        [workerId, leaseSeconds, leaseToken, allowedJobTypes, allowedBookEditionIds]
      )
      const job = jobRow(result.rows[0])
      if (job?.characterKey) {
        const bundleVersion = job.payload?.bundle_version ?? job.targetVersion
        await pool.query(
          `UPDATE character_media_bundles
           SET status = 'running', updated_at = now()
           WHERE book_edition_id = $1 AND character_key = $2 AND bundle_version = $3`,
          [job.bookEditionId, job.characterKey, bundleVersion]
        )
      }
      return job
    },

    async getBookMarkupInput(job) {
      const result = await pool.query(
        `SELECT edition.scope, edition.title, edition.author, edition.format,
                edition.content_sha256, file.object_key, file.mime_type, file.byte_size
         FROM generation_jobs AS job
         JOIN book_editions AS edition ON edition.id = job.book_edition_id
         JOIN book_files AS file ON file.book_edition_id = edition.id AND file.status = 'ready'
         WHERE job.id = $1 AND job.status = 'running' AND job.lease_token = $2::uuid`,
        [job.id, job.leaseToken]
      )
      if (!result.rows[0]) throw leaseLost(job.id)
      const row = result.rows[0]
      return {
        bookEditionId: job.bookEditionId,
        analysisVersion: job.targetVersion,
        scope: row.scope,
        title: row.title,
        author: row.author,
        format: row.format,
        contentSha256: row.content_sha256,
        objectKey: row.object_key,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size)
      }
    },

    async getBookIdentityInput(job) {
      const result = await pool.query(
        `SELECT edition.scope, edition.title, edition.author, edition.format,
                edition.content_sha256, file.object_key, file.mime_type, file.byte_size
         FROM generation_jobs AS job
         JOIN book_editions AS edition ON edition.id = job.book_edition_id
         JOIN book_files AS file ON file.book_edition_id = edition.id AND file.status = 'ready'
         WHERE job.id = $1 AND job.job_type = 'book_identity'
           AND job.status = 'running' AND job.lease_token = $2::uuid`,
        [job.id, job.leaseToken]
      )
      if (!result.rows[0]) throw leaseLost(job.id)
      const row = result.rows[0]
      return {
        bookEditionId: job.bookEditionId,
        targetVersion: job.targetVersion,
        scope: row.scope,
        title: row.title,
        author: row.author,
        format: row.format,
        contentSha256: row.content_sha256,
        objectKey: row.object_key,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size)
      }
    },

    async renewGenerationLease(job) {
      const result = await pool.query(
        `UPDATE generation_jobs SET locked_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'running' AND lease_token = $2::uuid
         RETURNING id`,
        [job.id, job.leaseToken]
      )
      if (!result.rows[0]) throw leaseLost(job.id)
    },

    async getCharacterBundleInput(job) {
      const result = await pool.query(
        `SELECT character.character_key, character.name, character.full_name,
                character.first_appearance_text_offset, character.warmup_text_offset,
                character.data, edition.scope, edition.title, edition.author
         FROM generation_jobs AS job
         JOIN book_editions AS edition ON edition.id = job.book_edition_id
         JOIN book_markup_versions AS markup
           ON markup.book_edition_id = edition.id AND (
             (job.payload ? 'markup_version_id'
               AND markup.id = (job.payload->>'markup_version_id')::uuid) OR
             (NOT (job.payload ? 'markup_version_id') AND markup.status = 'published')
           )
         JOIN book_characters AS character
           ON character.markup_version_id = markup.id AND character.character_key = job.character_key
         WHERE job.id = $1 AND job.status = 'running' AND job.lease_token = $2::uuid`,
        [job.id, job.leaseToken]
      )
      if (!result.rows[0]) throw leaseLost(job.id)
      const row = result.rows[0]
      return {
        bookEditionId: job.bookEditionId,
        characterKey: row.character_key,
        name: row.name,
        fullName: row.full_name,
        firstAppearanceTextOffset: Number(row.first_appearance_text_offset),
        warmupTextOffset: Number(row.warmup_text_offset),
        character: row.data,
        scope: row.scope,
        bookTitle: row.title,
        bookAuthor: row.author,
        bundleVersion: job.targetVersion
      }
    },

    async getBookSceneInput(job) {
      const result = await pool.query(
        `SELECT scene.scene_key, scene.slot_index, scene.anchor_text_offset,
                scene.excerpt_start_text_offset, scene.excerpt_end_text_offset,
                scene.markup_version_id, edition.scope, edition.title, edition.author,
                markup.text_length,
                job.payload->>'normalized_text_object_key' AS normalized_text_object_key,
                job.payload->>'normalized_text_hash' AS normalized_text_hash
         FROM generation_jobs AS job
         JOIN book_scene_slots AS scene ON scene.job_id = job.id
         JOIN book_editions AS edition ON edition.id = job.book_edition_id
         JOIN book_markup_versions AS markup ON markup.id = scene.markup_version_id
         WHERE job.id = $1 AND job.job_type = 'scene_image'
           AND job.status = 'running' AND job.lease_token = $2::uuid
           AND markup.status = 'published'`,
        [job.id, job.leaseToken]
      )
      if (!result.rows[0]) throw leaseLost(job.id)
      const row = result.rows[0]
      const characters = await pool.query(
        `SELECT character_key, name, full_name, data
         FROM book_characters
         WHERE markup_version_id = $1
           AND first_appearance_text_offset <= $2
         ORDER BY sort_order, character_key`,
        [row.markup_version_id, row.excerpt_end_text_offset]
      )
      return {
        bookEditionId: job.bookEditionId,
        targetVersion: job.targetVersion,
        scope: row.scope,
        bookTitle: row.title,
        bookAuthor: row.author,
        sceneKey: row.scene_key,
        slotIndex: Number(row.slot_index),
        anchorTextOffset: Number(row.anchor_text_offset),
        excerptStartTextOffset: Number(row.excerpt_start_text_offset),
        excerptEndTextOffset: Number(row.excerpt_end_text_offset),
        textLength: Number(row.text_length),
        normalizedTextObjectKey: row.normalized_text_object_key,
        normalizedTextHash: row.normalized_text_hash,
        characters: characters.rows.map((character) => ({
          characterKey: character.character_key,
          name: character.name,
          fullName: character.full_name,
          profile: character.data
        }))
      }
    },

    async getCatalogCoverInput(job) {
      const result = await pool.query(
        `SELECT COALESCE(edition.display_title, edition.title) AS title,
                COALESCE(edition.display_author, edition.author) AS author,
                edition.scope, edition.format, edition.content_sha256,
                file.object_key, file.mime_type, file.byte_size
         FROM generation_jobs AS job
         JOIN book_editions AS edition ON edition.id = job.book_edition_id
         JOIN book_files AS file ON file.book_edition_id = edition.id AND file.status = 'ready'
         WHERE job.id = $1 AND job.job_type = 'catalog_cover'
           AND job.status = 'running' AND job.lease_token = $2::uuid`,
        [job.id, job.leaseToken]
      )
      if (!result.rows[0]) throw leaseLost(job.id)
      const row = result.rows[0]
      return {
        bookEditionId: job.bookEditionId,
        targetVersion: job.targetVersion,
        scope: row.scope,
        title: row.title,
        author: row.author,
        format: row.format,
        contentSha256: row.content_sha256,
        objectKey: row.object_key,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        context: ''
      }
    },

    async publishBookMarkup(job, markup) {
      return transaction(pool, async (client) => {
        const leased = await requireLeasedJob(client, job)
        const revisionResult = await client.query(
          `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
           FROM book_markup_versions WHERE book_edition_id = $1`,
          [job.bookEditionId]
        )
        const revision = Number(revisionResult.rows[0].revision)
        const markupId = idFactory()
        await client.query(
          `UPDATE book_markup_versions SET status = 'ready'
           WHERE book_edition_id = $1 AND status = 'published'`,
          [job.bookEditionId]
        )
        await client.query(
          `INSERT INTO book_markup_versions (
             id, book_edition_id, schema_version, analysis_version, revision,
             status, input_hash, text_length, published_at
           ) VALUES ($1, $2, $3, $4, $5, 'published', $6, $7, now())`,
          [
            markupId,
            job.bookEditionId,
            BOOK_MARKUP_SCHEMA_VERSION,
            leased.target_version,
            revision,
            markup.inputHash,
            markup.textLength
          ]
        )
        for (const [index, character] of markup.characters.entries()) {
          await client.query(
            `INSERT INTO book_characters (
               id, markup_version_id, character_key, sort_order, name, full_name,
               first_appearance_text_offset, warmup_text_offset, data
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
              idFactory(), markupId, character.characterKey, index,
              character.name, character.fullName,
              character.firstAppearanceTextOffset, character.warmupTextOffset,
              JSON.stringify(character)
            ]
          )
        }
        await client.query(
          `UPDATE reader_book_positions
           SET text_offset = GREATEST(
             text_offset,
             ROUND(reading_fraction * $2)::bigint
           ), updated_at = now()
           WHERE book_edition_id = $1 AND reading_fraction IS NOT NULL`,
          [job.bookEditionId, markup.textLength]
        )
        await client.query(
          `UPDATE book_editions
           SET status = CASE WHEN scope = 'catalog' THEN 'generating_portraits' ELSE 'base_ready' END,
               updated_at = now()
           WHERE id = $1`,
          [job.bookEditionId]
        )
        await client.query(
          `UPDATE generation_jobs
           SET status = 'ready', result = $2::jsonb, locked_at = NULL,
               locked_by = NULL, lease_token = NULL, updated_at = now()
           WHERE id = $1`,
          [
            job.id,
            JSON.stringify({ markup_id: markupId, revision, text_length: markup.textLength })
          ]
        )
        return { markupId, revision }
      })
    },

    async publishCharacterBundle(job, bundle) {
      return transaction(pool, async (client) => {
        await requireLeasedJob(client, job)
        const bundleVersion = job.payload?.bundle_version ?? job.targetVersion
        const bundleResult = await client.query(
          `SELECT bundle.*, edition.scope
           FROM character_media_bundles AS bundle
           JOIN book_editions AS edition ON edition.id = bundle.book_edition_id
           WHERE bundle.book_edition_id = $1 AND bundle.character_key = $2
             AND bundle.bundle_version = $3
           FOR UPDATE OF bundle`,
          [job.bookEditionId, job.characterKey, bundleVersion]
        )
        const target = bundleResult.rows[0]
        if (!target) throw new Error(`character bundle missing for job ${job.id}`)
        for (const asset of bundle.assets) {
          const assetId = idFactory()
          const inserted = await client.query(
            `INSERT INTO media_assets (
               id, book_edition_id, visibility, type, object_key, content_hash,
               mime_type, byte_size, status, expires_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, 'ready',
               CASE WHEN $3 = 'private'
                 THEN now() + make_interval(days => $9)
                 ELSE NULL
               END
             )
             ON CONFLICT (object_key) DO UPDATE SET
               content_hash = EXCLUDED.content_hash,
               mime_type = EXCLUDED.mime_type,
               byte_size = EXCLUDED.byte_size,
               status = 'ready',
               expires_at = EXCLUDED.expires_at
             RETURNING id`,
            [
              assetId, job.bookEditionId, target.scope, asset.type,
              asset.objectKey, asset.contentHash, asset.mimeType, asset.byteSize,
              privateMaterialTtlDays
            ]
          )
          await client.query(
            `INSERT INTO character_bundle_assets (bundle_id, asset_type, asset_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (bundle_id, asset_type) DO UPDATE SET asset_id = EXCLUDED.asset_id`,
            [target.id, asset.type, inserted.rows[0].id]
          )
        }
        await client.query(
          `UPDATE generation_jobs
           SET status = 'ready', result = $2::jsonb, last_error_code = NULL,
               locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
           WHERE id = $1`,
          [job.id, JSON.stringify({ bundle_id: target.id, assets: bundle.assets.map((asset) => asset.type) })]
        )
        const complete = await client.query(
          `SELECT COUNT(*)::int AS count
           FROM character_bundle_assets AS link
           JOIN media_assets AS asset ON asset.id = link.asset_id AND asset.status = 'ready'
           WHERE link.bundle_id = $1 AND link.asset_type = ANY($2::text[])`,
          [target.id, REQUIRED_CHARACTER_MEDIA]
        )
        const independentJob = Object.values(CHARACTER_MEDIA_JOB_TYPES).includes(job.type)
        let bundleStatus = Number(complete.rows[0].count) === REQUIRED_CHARACTER_MEDIA.length
          ? 'ready'
          : 'running'
        if (independentJob) {
          const revisionJobs = await client.query(
            `SELECT status, COUNT(*)::int AS count
             FROM generation_jobs
             WHERE book_edition_id = $1 AND character_key = $2
               AND target_version = $3
               AND job_type = ANY($4::text[])
             GROUP BY status`,
            [job.bookEditionId, job.characterKey, job.targetVersion, Object.values(CHARACTER_MEDIA_JOB_TYPES)]
          )
          const counts = new Map(revisionJobs.rows.map((row) => [row.status, Number(row.count)]))
          bundleStatus = (counts.get('ready') ?? 0) === REQUIRED_CHARACTER_MEDIA.length
            ? 'ready'
            : (counts.get('failed') ?? 0) > 0 ? 'failed' : 'running'
        } else if (bundleStatus !== 'ready') {
          throw new Error('character bundle did not publish every required asset')
        }
        await client.query(
          `UPDATE character_media_bundles
           SET status = $4,
               published_at = CASE WHEN $4 = 'ready' THEN now() ELSE published_at END,
               updated_at = now(),
               expires_at = CASE WHEN $2 = 'private'
                 THEN now() + make_interval(days => $3)
                 ELSE NULL
               END
           WHERE id = $1`,
          [target.id, target.scope, privateMaterialTtlDays, bundleStatus]
        )
        if (target.scope === 'private') await touchPrivateRetention(client, job.bookEditionId)
        const missing = await client.query(
          `SELECT COUNT(*)::int AS count
           FROM book_markup_versions AS markup
           JOIN book_characters AS character ON character.markup_version_id = markup.id
           LEFT JOIN character_media_bundles AS bundle
             ON bundle.book_edition_id = markup.book_edition_id
            AND bundle.character_key = character.character_key
            AND bundle.bundle_version = $2
            AND bundle.status = 'ready'
           WHERE markup.book_edition_id = $1 AND markup.status = 'published'
             AND bundle.id IS NULL`,
          [job.bookEditionId, bundleVersion]
        )
        if (Number(missing.rows[0].count) === 0) {
          await client.query(
            `UPDATE book_editions SET status = 'base_ready', updated_at = now()
             WHERE id = $1 AND scope = 'catalog' AND status = 'generating_portraits'`,
            [job.bookEditionId]
          )
        }
        return { bundleId: target.id, status: bundleStatus }
      })
    },

    async publishBookScene(job, asset) {
      return transaction(pool, async (client) => {
        await requireLeasedJob(client, job)
        if (
          !asset || typeof asset.objectKey !== 'string' || !asset.objectKey ||
          typeof asset.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(asset.contentHash) ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(asset.mimeType) ||
          !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1
        ) {
          const error = new Error('book scene asset metadata is invalid')
          error.code = 'GENERATION_RESULT_INVALID'
          throw error
        }
        const target = await client.query(
          `SELECT scene.id, scene.asset_id, edition.scope
           FROM book_scene_slots AS scene
           JOIN book_editions AS edition ON edition.id = scene.book_edition_id
           WHERE scene.job_id = $1 FOR UPDATE OF scene`,
          [job.id]
        )
        if (!target.rows[0]) {
          await client.query(
            `UPDATE generation_jobs
             SET status = 'ready', result = '{"stale":true}'::jsonb,
                 locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
             WHERE id = $1`,
            [job.id]
          )
          return { status: 'stale' }
        }
        const assetId = idFactory()
        const inserted = await client.query(
          `INSERT INTO media_assets (
             id, book_edition_id, visibility, type, object_key, content_hash,
             mime_type, byte_size, status, expires_at
           ) VALUES (
             $1, $2, $3, 'scene_image', $4, $5, $6, $7, 'ready',
             CASE WHEN $3 = 'private'
               THEN now() + make_interval(days => $8)
               ELSE NULL
             END
           )
           ON CONFLICT (object_key) DO UPDATE SET
             content_hash = EXCLUDED.content_hash,
             mime_type = EXCLUDED.mime_type,
             byte_size = EXCLUDED.byte_size,
             status = 'ready',
             expires_at = EXCLUDED.expires_at
           RETURNING id`,
          [
            assetId, job.bookEditionId, target.rows[0].scope, asset.objectKey,
            asset.contentHash, asset.mimeType, asset.byteSize, privateMaterialTtlDays
          ]
        )
        await client.query(
          `UPDATE book_scene_slots SET asset_id = $2, updated_at = now() WHERE id = $1`,
          [target.rows[0].id, inserted.rows[0].id]
        )
        await client.query(
          `UPDATE generation_jobs
           SET status = 'ready', result = $2::jsonb, last_error_code = NULL,
               locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
           WHERE id = $1`,
          [job.id, JSON.stringify({ asset_id: inserted.rows[0].id })]
        )
        if (target.rows[0].scope === 'private') {
          await touchPrivateRetention(client, job.bookEditionId)
        }
        return { status: 'ready', assetId: inserted.rows[0].id }
      })
    },

    async publishCatalogCover(job, asset) {
      return transaction(pool, async (client) => {
        await requireLeasedJob(client, job)
        if (
          !asset || typeof asset.objectKey !== 'string' || !asset.objectKey ||
          typeof asset.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(asset.contentHash) ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(asset.mimeType) ||
          !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1
        ) {
          const error = new Error('catalog cover asset metadata is invalid')
          error.code = 'GENERATION_RESULT_INVALID'
          throw error
        }
        const previous = await client.query(
          `SELECT object_key FROM catalog_book_covers
           WHERE book_edition_id = $1 FOR UPDATE`,
          [job.bookEditionId]
        )
        const previousObjectKey = previous.rows[0]?.object_key
        await client.query(
          `INSERT INTO catalog_book_covers (
             book_edition_id, object_key, content_hash, mime_type, byte_size, status
           ) VALUES ($1, $2, $3, $4, $5, 'ready')
           ON CONFLICT (book_edition_id) DO UPDATE SET
             object_key = EXCLUDED.object_key,
             content_hash = EXCLUDED.content_hash,
             mime_type = EXCLUDED.mime_type,
             byte_size = EXCLUDED.byte_size,
             status = 'ready',
             updated_at = now()`,
          [job.bookEditionId, asset.objectKey, asset.contentHash, asset.mimeType, asset.byteSize]
        )
        if (previousObjectKey && previousObjectKey !== asset.objectKey) {
          await client.query(
            `INSERT INTO book_object_deletions (object_key)
             VALUES ($1) ON CONFLICT (object_key) DO NOTHING`,
            [previousObjectKey]
          )
        }
        await client.query(
          `UPDATE generation_jobs
           SET status = 'ready', result = $2::jsonb, last_error_code = NULL,
               locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
           WHERE id = $1`,
          [job.id, JSON.stringify({ asset })]
        )
        return { bookEditionId: job.bookEditionId, status: 'ready' }
      })
    },

    async publishBookIdentity(job, identity) {
      return transaction(pool, async (client) => {
        await requireLeasedJob(client, job)
        const edition = await client.query(
          `SELECT id, content_sha256, title, author, identity_version
           FROM book_editions WHERE id = $1 FOR UPDATE`,
          [job.bookEditionId]
        )
        if (!edition.rows[0]) throw leaseLost(job.id)
        const currentTarget = identityJobSpec(edition.rows[0]).targetVersion
        if (currentTarget !== job.targetVersion) {
          await ensureBookIdentityJob(client, edition.rows[0])
          await client.query(
            `UPDATE generation_jobs
             SET status = 'ready', result = $2::jsonb, last_error_code = NULL,
                 locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
             WHERE id = $1`,
            [job.id, JSON.stringify({ stale: true, current_target_version: currentTarget })]
          )
          return { bookEditionId: job.bookEditionId, status: 'stale' }
        }
        const generated = normalizeBookDisplayIdentity(identity)
        const fallback = normalizeBookDisplayIdentity(edition.rows[0])
        const normalized = {
          title: generated.title || fallback.title,
          author: generated.author || fallback.author
        }
        if (!normalized.title) {
          const error = new Error('book identity title is invalid')
          error.code = 'GENERATION_RESULT_INVALID'
          throw error
        }
        await client.query(
          `UPDATE book_editions
           SET display_title = $2, display_author = $3,
               identity_version = $4, identity_source = $5,
               identity_updated_at = now(), updated_at = now()
           WHERE id = $1`,
          [
            job.bookEditionId,
            normalized.title,
            normalized.author,
            job.targetVersion,
            identity.source === 'llm' ? 'llm' : 'deterministic'
          ]
        )
        await client.query(
          `UPDATE generation_jobs
           SET status = 'ready', result = $2::jsonb, last_error_code = NULL,
               locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
           WHERE id = $1`,
          [job.id, JSON.stringify({ identity: { ...normalized, source: identity.source } })]
        )
        return { bookEditionId: job.bookEditionId, status: 'ready' }
      })
    },

    async failGenerationJob(job, errorCode, { maxAttempts = 3 } = {}) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `UPDATE generation_jobs
           SET status = CASE WHEN attempts < $4 THEN 'queued' ELSE 'failed' END,
               last_error_code = $3,
               available_at = now() + make_interval(
                 secs => LEAST(300, power(2, attempts)::int)
               ),
               locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
           WHERE id = $1 AND status = 'running' AND lease_token = $2::uuid
           RETURNING status, book_edition_id, character_key, target_version`,
          [job.id, job.leaseToken, errorCode, maxAttempts]
        )
        if (!result.rows[0]) throw leaseLost(job.id)
        const failed = result.rows[0]
        if (failed.character_key) {
          const bundleVersion = job.payload?.bundle_version ?? failed.target_version
          await client.query(
            `UPDATE character_media_bundles SET status = $4, updated_at = now()
             WHERE book_edition_id = $1 AND character_key = $2 AND bundle_version = $3`,
            [
              failed.book_edition_id,
              failed.character_key,
              bundleVersion,
              failed.status
            ]
          )
        }
        return { status: failed.status }
      })
    }
  }
}
