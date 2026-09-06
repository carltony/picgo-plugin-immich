# PicGo Immich 插件开发指南

## 项目概述

PicGo/PicList 插件，用于将图片上传到 [Immich](https://immich.app) 自托管照片管理系统。

## 环境要求

- **Node.js**: >= 14.0.0
- **PicGo-Core**: >= 1.4.0
- **目标平台**: PicList（主）、PicGo（兼容）

## 文件结构

```
src/
└── index.js          # 插件主入口（纯 JS，无需编译）
package.json
README.md
AGENTS.md
```

## 配置项

| 配置项     | 类型     | 必填 | 说明                 |
|-----------|---------|-----|---------------------|
| `url`     | string  | 是  | Immich 服务器地址      |
| `token`   | string  | 是  | API Key              |
| `albumId` | string  | 否  | 目标相册 ID            |

## 核心功能

1. **图片上传**: 通过 Immich REST API 上传图片
2. **SHA-1 去重**: 计算文件 SHA-1 校验和，Immich 自动去重
3. **回收站恢复**: 上传返回 `duplicate` 时自动从回收站恢复
4. **分享链接缩略图**: 自动创建分享链接，用于 PicList 图库缩略图显示
5. **相册管理**: 上传后自动加入指定相册
6. **脚本删除**: 通过 `onGalleryRemove` 脚本在图库删除时同步删除 Immich 资源

## 上传流程

1. 读取配置（url、token、albumId）
2. 计算文件 SHA-1 校验和
3. 构建 `multipart/form-data` 请求，POST 到 `/api/assets`
4. 如果返回 `duplicate`，调用 `POST /trash/restore/assets` 恢复
5. 创建分享链接（`POST /api/shared-links`）
6. 设置 `imgUrl` 为缩略图 URL（`/api/assets/{id}/thumbnail?key={shareKey}&size=thumbnail`）
7. 如果配置了 `albumId`，调用 `PUT /api/albums/{albumId}/assets` 加入相册

## 开发规范

### 代码风格

- 纯 JavaScript（无 TypeScript 编译）
- 使用 `ctx.Request.request()` 发送请求（PicList 兼容）
- 使用 `x-api-key` 请求头传递 API 密钥
- 异步操作使用 try-catch 错误处理

### 关键 API

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/assets` | 上传资产（multipart/form-data） |
| POST | `/api/shared-links` | 创建分享链接 |
| POST | `/trash/restore/assets` | 从回收站恢复资产 |
| PUT | `/api/albums/{id}/assets` | 将资产加入相册 |
| DELETE | `/api/assets` | 删除资产（body: `{ids: [...]}`） |

### PicList 兼容性

- `ctx.server` 在 PicList 中为 `undefined`，不能使用 `ctx.server.registerPost()`
- 删除功能通过 PicList 脚本系统实现（`scripts/onGalleryRemove/immich-delete.js`）
- 使用 `ctx.Request.request()` 替代 `ctx.request()`

## 测试

### 本地安装测试

```bash
# 打包
npm pack

# 安装到 PicList
cd ~/Library/Application\ Support/piclist
npm install /tmp/picgo-plugin-immich-1.0.0.tgz

# 重启 PicList
```

### 测试上传

1. 配置 Immich 服务器地址和 API Key
2. 上传一张图片
3. 检查日志中是否出现 `上传完成` 和 `分享链接已创建`
4. 检查 PicList 图库是否显示缩略图

### 测试删除

1. 在 PicList 图库中删除一张图片
2. 检查日志中是否出现 `[Immich Delete]`
3. 在 Immich 中确认资源已删除

## 部署

### 发布到 npm

```bash
# 登录 npm（首次需要注册）
npm login

# 发布
npm publish
```

### 安装方式

用户可通过以下方式安装：

```bash
# PicList/PicGo 插件管理器
搜索 "immich" 并安装

# 命令行
npm install picgo-plugin-immich
```

## 已知限制

- PicList 的 `picBedsCanbeDeleted` 白名单不包含 `immich`，云端删除通过脚本系统实现
- 分享链接每次上传都会创建（用于获取缩略图 key），可能产生大量分享链接
- 不支持 PicList 的内置云删除功能

## 联系方式

- GitHub: https://github.com/carltony/picgo-plugin-immich
- Issues: https://github.com/carltony/picgo-plugin-immich/issues
