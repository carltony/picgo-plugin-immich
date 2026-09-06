'use strict'
/**
 * Offline test harness for the v1.2 "reuse existing shared link" feature.
 * Mocks ctx.request + ctx.log, feeds the plugin a fake PNG buffer, and
 * asserts the exact sequence of HTTP calls (GET list -> PATCH reuse vs
 * POST create, optional DELETE cleanup).
 */
const crypto = require('crypto')

const calls = []
let shareKeyCounter = 0
let linkIdCounter = 100

// In-memory shared-link store: survives across requests so we can simulate
// "upload the same file twice" and verify the second call reuses the link.
const linkStore = []

// ---- mock ctx ----------------------------------------------------------
const ctx = {
  helper: {
    uploader: {
      _registered: {},
      register(name, def) {
        this._registered[name] = def
      },
    },
  },
  getConfig: () => getConfig(),
  log: {
    info: (...a) => console.log('  [info ]', ...a),
    warn: (...a) => console.log('  [warn ]', ...a),
    error: (...a) => console.log('  [error]', ...a),
  },
  request: async (payload) => {
    calls.push(payload)
    const { method, url, body } = payload

    // GET /api/shared-links -> return current link store
    if (method === 'GET' && url.endsWith('/shared-links')) {
      return { statusCode: 200, body: JSON.parse(JSON.stringify(linkStore)) }
    }
    // POST /api/assets -> return asset id
    if (method === 'POST' && url.endsWith('/assets')) {
      return { statusCode: 201, body: { id: 'asset-' + calls.length, status: 'created' } }
    }
    // POST /api/shared-links -> create link, persist to store
    if (method === 'POST' && url.endsWith('/shared-links')) {
      const key = 'k' + ++shareKeyCounter
      const id = 'link-' + ++linkIdCounter
      const link = {
        id,
        key,
        type: body.type,
        album: body.type === 'ALBUM' ? { id: body.albumId } : undefined,
        assets: (body.assetIds || []).map((aid) => ({
          id: aid,
          checksum: currentChecksumB64,
          originalFileName: currentFileName,
        })),
        allowDownload: body.allowDownload,
        allowUpload: false,
        showMetadata: body.showMetadata,
        expiresAt: body.expiresAt || null,
        password: body.password || null,
      }
      linkStore.push(link)
      return { statusCode: 201, body: { id, key, type: body.type } }
    }
    // PATCH /api/shared-links/:id -> update link in store
    if (method === 'PATCH' && url.includes('/shared-links/')) {
      const id = url.split('/').pop()
      const link = linkStore.find((l) => l.id === id)
      if (link) Object.assign(link, body)
      return { statusCode: 200, body: { id, key: link && link.key, ...body } }
    }
    // DELETE /api/shared-links/:id -> remove from store
    if (method === 'DELETE' && url.includes('/shared-links/')) {
      const id = url.split('/').pop()
      const idx = linkStore.findIndex((l) => l.id === id)
      if (idx >= 0) linkStore.splice(idx, 1)
      return { statusCode: 200, body: {} }
    }
    // PUT /api/albums/:id/assets
    if (method === 'PUT' && url.includes('/albums/')) {
      return { statusCode: 200, body: {} }
    }
    return { statusCode: 200, body: {} }
  },
}

// ---- config switches ---------------------------------------------------
let currentFileName = 'screenshot-1.png'
let currentChecksumB64 = null

function makeConfig(overrides = {}) {
  return {
    url: 'https://immich.example.com',
    token: 'test-api-key-12345',
    albumId: 'b4147879-8384-4605-ae3d-137ce5eccb4f',
    isFavorite: false,
    isArchived: false,
    shareEnabled: true,
    shareType: 'INDIVIDUAL',
    sharePassword: '',
    shareExpiresInDays: '',
    shareAllowDownload: true,
    shareShowMetadata: false,
    // v1.2 reuse settings
    shareReuseExisting: true,
    shareRefreshOnReuse: true,
    shareCleanupOnReuse: false,
    ...overrides,
  }
}

let _config = makeConfig()
function getConfig() {
  return _config
}

// ---- minimal fake PNG buffer ------------------------------------------
const fakePng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
  '890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082',
  'hex',
)
currentChecksumB64 = crypto.createHash('sha1').update(fakePng).digest('base64')

// ---- load plugin -------------------------------------------------------
const plugin = require('./index.js')
const api = plugin(ctx)
api.register()
const uploader = ctx.helper.uploader._registered.immich

async function runHandle() {
  calls.length = 0
  return uploader.handle(ctx)
}

const errors = []
function assert(cond, msg) {
  if (!cond) errors.push(msg)
}

/* =====================================================================
 * Test 1: INDIVIDUAL — first upload creates, second upload REUSES
 * =================================================================== */
;(async () => {
  console.log('\n===== TEST 1: INDIVIDUAL 复用 (reuse=true, refresh=true) =====')
  linkStore.length = 0
  _config = makeConfig({ shareType: 'INDIVIDUAL' })
  ctx.output = [{ fileName: 'screenshot-1.png', buffer: fakePng }]

  // --- first upload: store is empty -> must CREATE ---
  await runHandle()
  const creates1 = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/shared-links'))
  assert(creates1.length === 1, `T1: first upload should CREATE, got ${creates1.length}`)
  const firstKey = linkStore[0].key
  console.log('  created key:', firstKey, '✓')

  // --- second upload of the SAME file: must REUSE (PATCH) not create ---
  calls.length = 0
  await runHandle()
  const creates2 = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/shared-links'))
  const patches2 = calls.filter((c) => c.method === 'PATCH' && c.url.includes('/shared-links/'))
  assert(creates2.length === 0, `T1: second upload should NOT create, got ${creates2.length}`)
  assert(patches2.length === 1, `T1: second upload should PATCH, got ${patches2.length}`)
  assert(linkStore.length === 1, `T1: should still be exactly 1 link, got ${linkStore.length}`)
  assert(ctx.output[0].imgUrl.endsWith('/' + firstKey), `T1: imgUrl should reuse key, got ${ctx.output[0].imgUrl}`)
  console.log('  reused, no new create, store size:', linkStore.length, '✓')
  console.log('  imgUrl:', ctx.output[0].imgUrl, '✓')

  // --- PATCH body must carry the refreshed fields ---
  const patchBody = patches2[0].body
  assert('expiresAt' in patchBody, 'T1: PATCH should send expiresAt (even if null)')
  assert(patchBody.allowDownload === true, 'T1: PATCH should send allowDownload')
  assert(patchBody.showMetadata === false, 'T1: PATCH should send showMetadata')
  console.log('  patch body:', JSON.stringify(patchBody), '✓')

  /* =====================================================================
   * Test 2: refresh=true must update expiresAt when days configured
   * =================================================================== */
  console.log('\n===== TEST 2: 复用时刷新有效期 =====')
  _config = makeConfig({ shareType: 'INDIVIDUAL', shareExpiresInDays: '7' })
  calls.length = 0
  await runHandle()
  const patches = calls.filter((c) => c.method === 'PATCH')
  assert(patches.length === 1, `T2: should PATCH once, got ${patches.length}`)
  assert(
    /^\d{4}-\d{2}-\d{2}T/.test(patches[0].body.expiresAt),
    `T2: expiresAt should be ISO date, got ${patches[0].body.expiresAt}`,
  )
  console.log('  expiresAt:', patches[0].body.expiresAt, '✓')

  /* =====================================================================
   * Test 3: refresh=false -> no PATCH on reuse
   * =================================================================== */
  console.log('\n===== TEST 3: 复用但关闭刷新 (refresh=false) =====')
  _config = makeConfig({ shareType: 'INDIVIDUAL', shareRefreshOnReuse: false })
  calls.length = 0
  await runHandle()
  const patches3 = calls.filter((c) => c.method === 'PATCH')
  assert(patches3.length === 0, `T3: should NOT patch, got ${patches3.length}`)
  console.log('  no PATCH calls ✓')

  /* =====================================================================
   * Test 4: reuse=false -> always creates a new link (link count grows)
   * =================================================================== */
  console.log('\n===== TEST 4: 关闭复用 (reuse=false) =====')
  _config = makeConfig({ shareType: 'INDIVIDUAL', shareReuseExisting: false })
  const before = linkStore.length
  calls.length = 0
  await runHandle()
  const creates4 = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/shared-links'))
  assert(creates4.length === 1, `T4: should always create, got ${creates4.length}`)
  assert(linkStore.length === before + 1, `T4: link count should grow, ${before} -> ${linkStore.length}`)
  console.log('  link count:', before, '->', linkStore.length, '✓')

  /* =====================================================================
   * Test 5: cleanup=true -> deletes ALL pre-existing matches, creates one
   *   Setup: 3 stale links for the same file already in the store.
   * =================================================================== */
  console.log('\n===== TEST 5: 清理多余旧链接 (cleanup=true) =====')
  // Seed 3 stale links for the same asset
  linkStore.length = 0
  for (let i = 0; i < 3; i++) {
    linkStore.push({
      id: 'stale-' + i,
      key: 'staleKey' + i,
      type: 'INDIVIDUAL',
      assets: [{ id: 'old-asset', checksum: currentChecksumB64, originalFileName: 'screenshot-1.png' }],
    })
  }
  _config = makeConfig({
    shareType: 'INDIVIDUAL',
    shareReuseExisting: false, // turn off reuse so we exercise the cleanup branch
    shareCleanupOnReuse: true,
  })
  calls.length = 0
  await runHandle()
  const deletes = calls.filter((c) => c.method === 'DELETE' && c.url.includes('/shared-links/'))
  const creates5 = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/shared-links'))
  assert(deletes.length === 3, `T5: should DELETE 3 stale links, got ${deletes.length}`)
  assert(creates5.length === 1, `T5: should CREATE exactly 1 fresh link, got ${creates5.length}`)
  assert(linkStore.length === 1, `T5: final store should have 1 link, got ${linkStore.length}`)
  console.log('  deleted:', deletes.length, 'created:', creates5.length, 'final store:', linkStore.length, '✓')

  /* =====================================================================
   * Test 6: ALBUM reuse — one link per album, second run reuses
   * =================================================================== */
  console.log('\n===== TEST 6: ALBUM 复用 =====')
  linkStore.length = 0
  _config = makeConfig({ shareType: 'ALBUM', albumId: 'album-uuid-abc' })
  ctx.output = [{ fileName: 'a.png', buffer: fakePng }]
  calls.length = 0
  await runHandle()
  const albumCreates = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/shared-links'))
  assert(albumCreates.length === 1, `T6: first ALBUM run should create, got ${albumCreates.length}`)
  console.log('  created album link ✓')

  calls.length = 0
  await runHandle()
  const albumCreates2 = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/shared-links'))
  const albumPatches2 = calls.filter((c) => c.method === 'PATCH' && c.url.includes('/shared-links/'))
  assert(albumCreates2.length === 0, `T6: second ALBUM run should NOT create, got ${albumCreates2.length}`)
  assert(albumPatches2.length === 1, `T6: second ALBUM run should PATCH, got ${albumPatches2.length}`)
  assert(linkStore.length === 1, `T6: should be 1 album link, got ${linkStore.length}`)
  console.log('  reused album link, store size:', linkStore.length, '✓')

  /* =====================================================================
   * Test 7: GET list failure degrades gracefully (reuse skipped, create works)
   * =================================================================== */
  console.log('\n===== TEST 7: 列出链接失败时优雅降级 =====')
  linkStore.length = 0
  // Make GET /shared-links fail by returning a non-2xx via a temporary mock
  const origRequest = ctx.request
  ctx.request = async (payload) => {
    if (payload.method === 'GET' && payload.url.endsWith('/shared-links')) {
      return { statusCode: 500, body: { message: 'boom' } }
    }
    return origRequest(payload)
  }
  _config = makeConfig({ shareType: 'INDIVIDUAL' })
  ctx.output = [{ fileName: 'screenshot-1.png', buffer: fakePng }]
  calls.length = 0
  await runHandle()
  const creates7 = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/shared-links'))
  assert(creates7.length === 1, `T7: should fall back to create, got ${creates7.length}`)
  console.log('  fell back to create (graceful) ✓')
  ctx.request = origRequest

  /* =====================================================================
   * Summary
   * =================================================================== */
  console.log('\n' + '='.repeat(60))
  if (errors.length) {
    console.log('❌ FAIL:')
    errors.forEach((e) => console.log('  -', e))
    process.exit(1)
  }
  console.log('✅ ALL REUSE TESTS PASSED')

  console.log('\n--- full call log (last run) ---')
  calls.forEach((c, i) => {
    console.log(`${i + 1}. ${c.method} ${c.url}`)
    if (c.body && typeof c.body === 'object' && !Buffer.isBuffer(c.body)) {
      console.log('   body:', JSON.stringify(c.body))
    }
  })
})()
