'use strict'
/**
 * Offline test harness: mocks ctx.request + ctx.log, feeds the plugin a fake
 * PNG buffer, and asserts the exact sequence of HTTP calls the plugin makes.
 */
const path = require('path')
const Module = require('module')

const calls = []
let shareKeyCounter = 0

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
  getConfig: () => ({
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
  }),
  log: {
    info: (...a) => console.log('  [info ]', ...a),
    warn: (...a) => console.log('  [warn ]', ...a),
    error: (...a) => console.log('  [error]', ...a),
  },
  request: async (payload) => {
    calls.push(payload)
    const url = payload.url
    // POST /api/assets -> return asset id
    if (payload.method === 'POST' && url.endsWith('/assets')) {
      return { statusCode: 201, body: { id: 'asset-' + calls.length, status: 'created' } }
    }
    // POST /api/shared-links -> return key
    if (payload.method === 'POST' && url.endsWith('/shared-links')) {
      const key = 'k' + (++shareKeyCounter)
      return { statusCode: 201, body: { id: 'link-' + shareKeyCounter, key, type: 'INDIVIDUAL' } }
    }
    // PUT /api/albums/:id/assets
    if (payload.method === 'PUT' && url.includes('/albums/')) {
      return { statusCode: 200, body: {} }
    }
    return { statusCode: 200, body: {} }
  },
}

// ---- minimal fake PNG buffer ------------------------------------------
const fakePng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
  '890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082',
  'hex',
)

ctx.output = [
  { fileName: 'screenshot-1.png', buffer: fakePng },
  { fileName: 'screenshot-2.png', buffer: fakePng },
]

// ---- load & run -------------------------------------------------------
const plugin = require('./index.js')
const api = plugin(ctx)
api.register()

const uploader = ctx.helper.uploader._registered.immich
const configSchema = uploader.config(ctx)

;(async () => {
  console.log('=== config schema (share fields) ===')
  const shareFields = configSchema
    .filter((f) => f.name.startsWith('share'))
    .map((f) => `${f.name}(${f.type})${f.default !== undefined ? ' = ' + JSON.stringify(f.default) : ''}`)
  console.log(shareFields.join('\n'))

  console.log('\n=== run handle() ===')
  await uploader.handle(ctx)

  console.log('\n=== assertions ===')
  const errors = []

  // 1. Two asset uploads
  const uploads = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/assets'))
  if (uploads.length !== 2) errors.push(`expected 2 uploads, got ${uploads.length}`)
  uploads.forEach((c, i) => {
    if (!c.body || !c.body.includes('assetData')) errors.push(`upload ${i}: body should be multipart buffer`)
    const hdrs = c.headers
    if (hdrs['Authorization'] !== 'Bearer test-api-key-12345') errors.push('missing Bearer auth')
    if (hdrs['x-api-key'] !== 'test-api-key-12345') errors.push('missing x-api-key')
    if (!hdrs['x-immich-checksum']) errors.push('missing checksum')
  })
  console.log('upload calls:', uploads.length, '✓')

  // 2. Two shared-link creations (INDIVIDUAL, one per asset)
  const links = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/shared-links'))
  if (links.length !== 2) errors.push(`expected 2 shared-links, got ${links.length}`)
  links.forEach((c, i) => {
    if (c.headers['Content-Type'] !== 'application/json') errors.push('share: should be JSON')
    const b = c.body
    if (b.type !== 'INDIVIDUAL') errors.push(`share ${i}: type should be INDIVIDUAL`)
    if (!Array.isArray(b.assetIds) || b.assetIds.length !== 1) errors.push('share: assetIds[] required')
    if (b.expiresAt) errors.push('share: expiresAt should be null when days empty')
    if (b.password) errors.push('share: password should be omitted when empty')
  })
  console.log('shared-link calls:', links.length, '✓')

  // 3. One album batch call
  const albums = calls.filter((c) => c.method === 'PUT' && c.url.includes('/albums/'))
  if (albums.length !== 1) errors.push(`expected 1 album call, got ${albums.length}`)
  if (albums[0].body.ids.length !== 2) errors.push('album: should contain 2 ids')
  console.log('album calls:', albums.length, '✓')

  // 4. imgUrl is the public share URL, not the auth-gated original endpoint
  for (const item of ctx.output) {
    if (!/^https:\/\/immich\.example\.com\/share\/k\d+$/.test(item.imgUrl)) {
      errors.push(`imgUrl should be public share link, got ${item.imgUrl}`)
    }
  }
  console.log('imgUrl[0]:', ctx.output[0].imgUrl, '✓')
  console.log('imgUrl[1]:', ctx.output[1].imgUrl, '✓')

  if (errors.length) {
    console.log('\n❌ FAIL:')
    errors.forEach((e) => console.log('  -', e))
    process.exit(1)
  }
  console.log('\n✅ ALL ASSERTIONS PASSED')
  console.log('\n--- full call log ---')
  calls.forEach((c, i) => {
    console.log(`${i + 1}. ${c.method} ${c.url}`)
    if (c.body && typeof c.body === 'object' && !Buffer.isBuffer(c.body)) {
      console.log('   body:', JSON.stringify(c.body))
    }
  })
})()
