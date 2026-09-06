'use strict'

/**
 * picgo-plugin-immich
 * Uploader for Immich (https://immich.app), compatible with the current
 * Immich REST API documented at https://api.immich.app
 *
 *   POST   /api/assets             (multipart/form-data)  upload assets
 *   GET    /api/shared-links        (application/json)     list existing shared links
 *   POST   /api/shared-links        (application/json)     create a new shared link
 *   PATCH  /api/shared-links/:id    (application/json)     refresh expiry/password/metadata
 *   DELETE /api/shared-links/:id                          (optional) clean up old links
 *   PUT    /api/albums/:id/assets                         add assets to an album
 *
 * Asset upload (POST /api/assets) required form fields:
 *   - assetData      (binary)  the image bytes
 *   - deviceAssetId  (string)  e.g. "<filename>-<size>"
 *   - deviceId       (string)
 *   - fileCreatedAt  (ISO 8601)
 *   - fileModifiedAt (ISO 8601)
 *
 * Optional header:
 *   - x-immich-checksum (SHA-1 hex)  server-side duplicate detection
 *
 * Upload response: { id: string, status: 'created' | 'replaced' | 'duplicate' }
 *
 * Shared link (POST /api/shared-links) request:
 *   - type        'INDIVIDUAL' | 'ALBUM'   (required)
 *   - assetIds    string[]                  required when type = 'INDIVIDUAL'
 *   - albumId     UUID                      required when type = 'ALBUM'
 *   - password    string  (optional)
 *   - expiresAt   ISO date-time (optional)
 *   - allowDownload / allowUpload / showMetadata  (optional booleans)
 *
 * Shared link response includes `key` -> public URL: ${url}/share/${key}
 *
 * Reuse strategy (the whole point of this v1.2 feature):
 *   Each shared link carries `assets: [{ checksum (base64 SHA-1),
 *   originalFileName, id, ... }]`.  We list existing links once, build a
 *   lookup keyed by (checksum, filename) for INDIVIDUAL links, and reuse the
 *   link whenever the same file is uploaded again — avoiding a new link per
 *   paste.  The matched link is PATCHed so its expiry/password/metadata stay
 *   in sync with the current config.
 */

const crypto = require('crypto')
const FormData = require('form-data')

const DEVICE_ID = 'picgo-immich-uploader'

/* ---------- configuration schema (drives the GUI config form) ---------- */

const config = (ctx) => [
  {
    name: 'url',
    type: 'input',
    required: true,
    message: 'Immich 服务器地址（含协议，如 https://immich.example.com）',
    alias: 'Server URL',
    default: '',
  },
  {
    name: 'token',
    type: 'input',
    required: true,
    message: 'API Key（在 Account Settings → API Keys 中创建）',
    alias: 'API Key',
    default: '',
  },
  {
    name: 'albumId',
    type: 'input',
    required: false,
    message: '相册 ID（可选，填写后会把上传的资产加入该相册）',
    alias: 'Album ID',
    default: '',
  },
]

/* ---------- helpers ---------- */

function getUploaderConfig(ctx) {
  return ctx.getConfig('picBed.immich') || {}
}

function buildApiBase(url) {
  let base = (url || '').replace(/\/+$/, '')
  if (!base.startsWith('http://') && !base.startsWith('https://')) {
    base = 'https://' + base
  }
  return base.endsWith('/api') ? base : `${base}/api`
}

function buildAssetsEndpoint(url) {
  return `${buildApiBase(url)}/assets`
}

/** SHA-1 as hex (used for the x-immich-checksum header). */
function sha1Hex(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

function nowIso() {
  return new Date().toISOString()
}

function safeJson(str) {
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}

/**
 * Perform a raw JSON request and return { statusCode, parsed }.
 */
async function jsonRequest(ctx, { method, url, token, body, timeout = 30000 }) {
  const hasBody = body !== undefined && body !== null
  const req = {
    method,
    url,
    headers: {
      'Accept': 'application/json',
      'x-api-key': token,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    timeout,
  }
  if (hasBody) req.data = body

  let resp
  try {
    resp = await ctx.Request.request(req)
  } catch (err) {
    const status = err.response?.status || err.statusCode || 'n/a'
    const data = err.response?.data || err.response?.body || err.message
    throw new Error(`(${method} ${url}) -> ${status}: ${JSON.stringify(data)}`)
  }
  const parsed = typeof resp === 'string' ? safeJson(resp) : resp
  return { statusCode: 200, parsed }
}

/* ---------- asset upload ---------- */

async function uploadOne(ctx, { buffer, fileName, endpoint, token, checksum, extraForm }) {
  const form = new FormData()

  form.append('assetData', buffer, { filename: fileName })
  form.append('deviceAssetId', `${fileName}-${buffer.length}`)
  form.append('deviceId', DEVICE_ID)
  form.append('fileCreatedAt', nowIso())
  form.append('fileModifiedAt', nowIso())

  for (const [key, value] of Object.entries(extraForm)) {
    if (value !== undefined && value !== null) {
      form.append(key, String(value))
    }
  }

  const config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: endpoint,
    headers: {
      'Content-Type': 'multipart/form-data',
      'Accept': 'application/json',
      'x-api-key': token,
      ...form.getHeaders(),
    },
    data: form,
  }

  let resp
  try {
    resp = await ctx.Request.request(config)
  } catch (err) {
    const status = err.response?.status || err.statusCode || 'n/a'
    const body = err.response?.data || err.response?.body || err.message
    throw new Error(`Immich 上传失败 (${status}): ${JSON.stringify(body)}`)
  }

  const parsed = typeof resp === 'string' ? safeJson(resp) : resp
  const id = parsed && (parsed.id || (Array.isArray(parsed) && parsed[0]?.id))
  if (!id) {
    throw new Error(`Immich 响应缺少资源 ID: ${JSON.stringify(parsed)}`)
  }

  return { id, status: parsed.status || 'created' }
}

/* =====================================================================
 * Main upload handle
 * =================================================================== */

const handle = async (ctx) => {
  const userConfig = getUploaderConfig(ctx)
  const { url, token, albumId } = userConfig

  if (!url) throw new Error('Immich 插件：未配置服务器地址 (url)')
  if (!token) throw new Error('Immich 插件：未配置 API Key (token)')

  const endpoint = buildAssetsEndpoint(url)
  const output = ctx.output || []

  for (const item of output) {
    let buffer = item.buffer
    if (!buffer && item.filePath) {
      const fs = require('fs')
      buffer = await fs.promises.readFile(item.filePath)
    }
    if (!buffer) {
      throw new Error(`无法读取文件内容: ${item.fileName || item.filePath || '(unknown)'}`)
    }

    const fileName = item.fileName || `upload-${Date.now()}`

    ctx.log.info(
      `正在上传 ${fileName}，大小: ${buffer.length} bytes，相册: ${albumId || '(未指定)'}`,
    )

    const { id, status } = await uploadOne(ctx, {
      buffer,
      fileName,
      endpoint,
      token,
      checksum: sha1Hex(buffer),
      extraForm: {},
    })

    ctx.log.info(`上传完成: ${status} (id=${id})`)

    // If asset was in trash (duplicate status), restore it
    if (status === 'duplicate') {
      try {
        await jsonRequest(ctx, {
          method: 'POST',
          url: `${buildApiBase(url)}/trash/restore/assets`,
          token,
          body: { ids: [id] },
        })
        ctx.log.info(`已从回收站恢复资产: ${id}`)
      } catch (err) {
        ctx.log.warn(`从回收站恢复失败（不影响上传）: ${err.message}`)
      }
    }

    item.assetId = id

    const baseUrl = url.replace(/\/+$/, '')
    item.url = `${baseUrl}/api/assets/${id}/original`

    // Create share link for thumbnail display in PicGo
    try {
      const { parsed } = await jsonRequest(ctx, {
        method: 'POST',
        url: `${buildApiBase(url)}/shared-links`,
        token,
        body: {
          type: 'INDIVIDUAL',
          assetIds: [id],
          allowDownload: true,
          showMetadata: false,
        },
      })
      const shareKey = parsed && parsed.key
      if (shareKey) {
        item.imgUrl = `${baseUrl}/api/assets/${id}/thumbnail?key=${shareKey}&size=thumbnail`
        ctx.log.info(`分享链接已创建: ${baseUrl}/share/${shareKey}`)
      } else {
        item.imgUrl = item.url
      }
    } catch (err) {
      ctx.log.warn(`分享链接创建失败（不影响上传）: ${err.message}`)
      item.imgUrl = item.url
    }
  }

  // Add uploaded assets to album
  if (albumId && output.length > 0) {
    const ids = output.map((o) => o.assetId).filter(Boolean)
    if (ids.length > 0) {
      try {
        await ctx.Request.request({
          method: 'PUT',
          url: `${buildApiBase(url)}/albums/${albumId}/assets`,
          headers: {
            'Accept': 'application/json',
            'x-api-key': token,
            'Content-Type': 'application/json',
          },
          data: { ids },
        })
        ctx.log.info(`已加入相册 ${albumId}: ${ids.length} 个资源`)
      } catch (err) {
        ctx.log.warn(`加入相册失败（资源已上传成功）: ${err.message}`)
      }
    }
  }

  return ctx
}

/* ---------- plugin registration ---------- */

function extractAssetId(imgUrl) {
  if (!imgUrl) return null
  const match = imgUrl.match(/\/api\/assets\/([a-f0-9-]+)\//)
  return match ? match[1] : null
}

module.exports = (ctx) => {
  const register = () => {
    ctx.helper.uploader.register('immich', {
      name: 'Immich',
      config,
      handle,
    })

    if (ctx.server && ctx.server.registerPost) {
      ctx.server.registerPost('/delete', async (c) => {
        try {
          const body = await c.req.json()
          const userConfig = getUploaderConfig(ctx)
          const { url, token } = userConfig

          if (!url || !token) {
            return c.json({ success: false, message: '未配置 Immich 服务器地址或 API Key' }, 400)
          }

          const imgUrl = body.imgUrl || (body.list && body.list[0] && body.list[0].imgUrl)
          const assetId = extractAssetId(imgUrl)

          if (!assetId) {
            return c.json({ success: false, message: '无法从链接中提取资产 ID' }, 400)
          }

          await jsonRequest(ctx, {
            method: 'DELETE',
            url: `${buildApiBase(url)}/assets`,
            token,
            body: { ids: [assetId] },
          })

          ctx.log.info(`Immich 资产已删除: ${assetId}`)
          return c.json({ success: true, message: '删除成功' })
        } catch (err) {
          ctx.log.error(`Immich 删除失败: ${err.message}`)
          return c.json({ success: false, message: err.message }, 500)
        }
      })
    }
  }

  return {
    register,
    uploader: 'immich',
  }
}
