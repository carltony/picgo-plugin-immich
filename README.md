# picgo-plugin-immich-up

PicList/PicGo 插件，用于将图片上传到 [Immich](https://immich.app) 自托管照片管理系统。

## 功能

- 上传图片到 Immich 服务器
- 自动创建分享链接，用于图库缩略图显示
- 上传到回收站中的重复文件时自动恢复
- 上传后自动加入指定相册
- 图库删除时同步删除 Immich 资源

## 安装

### 通过 PicList/PicGo 插件管理器

1. 打开 PicList 设置 -> 插件
2. 搜索 `immich`
3. 点击安装

### 通过命令行

```bash
npm install picgo-plugin-immich-up
```

## 配置

| 配置项     | 类型     | 必填 | 说明                 |
|-----------|---------|-----|---------------------|
| `url`     | string  | 是  | Immich 服务器地址（如 `https://immich.example.com`） |
| `token`   | string  | 是  | API Key（在 Immich Account Settings -> API Keys 中创建） |
| `albumId` | string  | 否  | 目标相册 ID（填写后上传的图片会自动加入该相册） |

## 使用

1. 安装插件并重启 PicList
2. 在插件设置中配置 Immich 服务器地址和 API Key
3. 选择 Immich 为默认图床
4. 上传图片，图片会自动同步到 Immich

## 工作原理

1. 计算文件 SHA-1 校验和（用于 Immich 去重）
2. 通过 `POST /api/assets` 上传文件
3. 如果文件在回收站中（返回 `duplicate`），自动恢复
4. 创建分享链接获取缩略图 key
5. 设置 `imgUrl` 为带认证的缩略图 URL，用于 PicList 图库显示
6. 如果配置了相册 ID，将资产加入相册

## 删除

插件监听 PicGo/PicList 原生的 `remove` 事件，当在图库中删除图片时自动同步删除 Immich 资源并清理关联的分享链接。安装后无需额外配置，删除功能自动生效。

## 开发

```bash
# 打包
npm pack

# 安装到 PicList 测试
cd ~/Library/Application\ Support/piclist
npm install /path/to/picgo-plugin-immich-up-1.0.2.tgz

# 重启 PicList
```

## 许可证

MIT
