'use strict'
/**
 * Regression test: ALBUM share type -> one shared link for the whole album,
 * created AFTER the album batch call, using albumId (not assetIds).
 */
const ctx = {
  helper: {
    uploader: { _registered: {}, register(name, def) { this._registered[name] = def } },
  },
  getConfig: () => ({
    url: 'https://immich.example.com',
    token: 'tok',
    albumId: 'album-uuid-111',
    shareEnabled: true,
    shareType: 'ALBUM',
    sharePassword: 's3cret',
    shareExpiresInDays: '7',
    shareAllowDownload: false,
    shareShowMetadata: true,
  }),
  log: { info: () => {}, warn: () => {}, error: () => {} },
  request: async (payload) => {
    ctx.__calls = ctx.__calls || []
    ctx.__calls.push(payload)
    if (payload.method === 'GET' && payload.url.endsWith('/shared-links'))
      return { statusCode: 200, body: [] } // empty list -> forces a CREATE (no reuse match)
    if (payload.method === 'POST' && payload.url.endsWith('/assets'))
      return { statusCode: 201, body: { id: 'a1', status: 'created' } }
    if (payload.method === 'POST' && payload.url.endsWith('/shared-links'))
      return { statusCode: 201, body: { id: 'l1', key: 'albumKey42', type: 'ALBUM' } }
    return { statusCode: 200, body: {} }
  },
}

const fakePng = Buffer.from('89504e470d0a1a0a', 'hex')
ctx.output = [{ fileName: 'x.png', buffer: fakePng }]

const plugin = require('./index.js')
plugin(ctx).register()

;(async () => {
  await ctx.helper.uploader._registered.immich.handle(ctx)

  const calls = ctx.__calls
  const linkCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/shared-links'))
  const albumCall = calls.find((c) => c.method === 'PUT' && c.url.includes('/albums/'))

  const errors = []
  if (!linkCall) errors.push('expected one shared-link call')
  else {
    const b = linkCall.body
    if (b.type !== 'ALBUM') errors.push('type should be ALBUM')
    if (b.albumId !== 'album-uuid-111') errors.push('should use albumId')
    if (b.assetIds) errors.push('ALBUM type must NOT send assetIds')
    if (b.password !== 's3cret') errors.push('password missing')
    if (b.allowDownload !== false) errors.push('allowDownload should be false')
    if (b.showMetadata !== true) errors.push('showMetadata should be true')
    if (!b.expiresAt) errors.push('expiresAt should be set for 7 days')
    // expiresAt roughly 7 days from now
    const diff = new Date(b.expiresAt) - Date.now()
    if (Math.abs(diff - 7 * 86400000) > 2000) errors.push('expiresAt not ~7 days')
  }
  if (!albumCall) errors.push('expected album batch call')

  // In ALBUM mode the SAME share URL is assigned to every output item.
  if (ctx.output[0].imgUrl !== 'https://immich.example.com/share/albumKey42')
    errors.push('imgUrl should be the album share link')

  // Order: album batch (PUT) must come BEFORE shared-link creation (POST), so
  // the album actually contains the assets when the link is generated.
  // (There is also a GET /shared-links list call before the POST.)
  const albumIdx = calls.indexOf(albumCall)
  const linkIdx = calls.indexOf(linkCall)
  if (linkIdx <= albumIdx) errors.push('shared link should be created AFTER album assignment')

  if (errors.length) {
    console.log('❌ FAIL:')
    errors.forEach((e) => console.log('  -', e))
    process.exit(1)
  }
  console.log('✅ ALBUM mode assertions passed')
  console.log('  shared-link body:', JSON.stringify(linkCall.body))
  console.log('  imgUrl:', ctx.output[0].imgUrl)
})()
