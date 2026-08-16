#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, 'public')
const options = parseArgs(process.argv.slice(2))
const outputDir = resolve(options.output ?? join(here, 'output'))
const packDir = resolve(options.packDir ?? outputDir)
const dshHome = options.dshHome ? resolve(options.dshHome) : null
const host = options.host ?? '127.0.0.1'
const port = Number(options.port ?? 4173)
const harnessUrl = options.harnessUrl ?? 'http://127.0.0.1:3098'

let latest = null

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`)

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        ok: true,
        outputDir,
        installEnabled: dshHome !== null,
        harnessUrl,
        latest,
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/generate') {
      const payload = await readJson(request)
      const result = await generatePlugin(payload)
      latest = result
      return sendJson(response, 200, { ok: true, ...result })
    }

    if (request.method === 'POST' && url.pathname === '/api/install') {
      if (dshHome === null) return sendJson(response, 409, { ok: false, error: '当前服务未启用演示环境安装。' })
      if (latest === null) return sendJson(response, 409, { ok: false, error: '请先生成插件安装包。' })
      if (await profileHasPlugin(dshHome, 'web', 'harness-image-skin')) {
        const removed = await run('dsh', ['plugin', '--profile', 'web', 'remove', 'harness-image-skin'], {
          env: { ...process.env, DSH_HOME: dshHome },
        })
        if (removed.code !== 0) return sendJson(response, 500, { ok: false, error: removed.stderr || removed.stdout })
      }
      const result = await run('dsh', ['plugin', '--profile', 'web', 'add', latest.tarballPath], {
        env: { ...process.env, DSH_HOME: dshHome },
      })
      if (result.code !== 0) return sendJson(response, 500, { ok: false, error: result.stderr || result.stdout })
      return sendJson(response, 200, {
        ok: true,
        message: '插件已经写入隔离的 Harness Web profile。',
        harnessUrl,
        output: compactOutput(result.stdout),
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/uninstall') {
      if (dshHome === null) return sendJson(response, 409, { ok: false, error: '当前服务未启用演示环境卸载。' })
      const result = await run('dsh', ['plugin', '--profile', 'web', 'remove', 'harness-image-skin'], {
        env: { ...process.env, DSH_HOME: dshHome },
      })
      if (result.code !== 0) return sendJson(response, 500, { ok: false, error: result.stderr || result.stdout })
      return sendJson(response, 200, {
        ok: true,
        message: '插件已经从隔离的 Harness Web profile 移除。',
        output: compactOutput(result.stdout),
      })
    }

    if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'Method not allowed' })
    return serveStatic(url.pathname, response)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(response, 500, { ok: false, error: message })
  }
})

server.listen(port, host, () => {
  process.stdout.write(`Harness Skin Studio: http://${host}:${port}\n`)
  process.stdout.write(`Generated plugin output: ${outputDir}\n`)
  process.stdout.write(`Demo install: ${dshHome === null ? 'disabled' : `enabled (${dshHome})`}\n`)
})

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      result[toCamel(key.slice(2))] = true
    } else {
      result[toCamel(key.slice(2))] = value
      index += 1
    }
  }
  return result
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, character) => character.toUpperCase())
}

async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  const target = resolve(publicDir, relative)
  if (target !== publicDir && !target.startsWith(`${publicDir}${sep}`)) return sendText(response, 403, 'Forbidden')
  try {
    const info = await stat(target)
    if (!info.isFile()) return sendText(response, 404, 'Not found')
    response.writeHead(200, {
      'Content-Type': mime[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    createReadStream(target).pipe(response)
  } catch {
    sendText(response, 404, 'Not found')
  }
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 18 * 1024 * 1024) throw new Error('图片数据超过 18 MB，请换一张或降低尺寸。')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function generatePlugin(payload) {
  const image = validateImage(payload.imageDataUrl)
  const settings = validateSettings(payload)
  const pluginDir = join(outputDir, 'harness-image-skin')
  await rm(pluginDir, { recursive: true, force: true })
  await mkdir(join(pluginDir, 'assets'), { recursive: true })
  await mkdir(packDir, { recursive: true })

  const hash = createHash('sha256').update(image.buffer).digest('hex')
  const files = {
    'package.json': packageManifest(),
    'index.js': hostEntry(),
    'client.js': clientEntry(image.dataUrl, settings),
    'cordis.patch.yml': patchManifest(),
    'README.md': pluginReadme(settings, hash),
    'LICENSE': mitLicense(),
    'generation.json': `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      package: 'harness-image-skin@1.0.0',
      sourceFile: settings.sourceName,
      renderedImageSha256: hash,
      sourceWidth: settings.sourceWidth,
      sourceHeight: settings.sourceHeight,
      outputWidth: 1920,
      outputHeight: 1080,
      backgroundPositionY: settings.positionY,
      glassStrength: settings.glassStrength,
      palette: settings.palette,
    }, null, 2)}\n`,
  }

  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(join(pluginDir, name), contents, 'utf8')))
  await writeFile(join(pluginDir, 'assets', 'background.webp'), image.buffer)

  //const packed = await run('npm', ['pack', '--pack-destination', packDir], { cwd: pluginDir })
  const packed = process.platform === 'win32'
  ? await run(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'npm', 'pack', '--pack-destination', packDir],
      { cwd: pluginDir }
    )
  : await run(
      'npm',
      ['pack', '--pack-destination', packDir],
      { cwd: pluginDir }
    )
  if (packed.code !== 0) throw new Error(`npm pack 失败：${packed.stderr || packed.stdout}`)
  const tarballName = packed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!tarballName) throw new Error('npm pack 未返回安装包文件名。')
  const tarballPath = join(packDir, tarballName)

  return {
    pluginDir,
    tarballPath,
    tarballName,
    imageSha256: hash,
    installCommand: `dsh plugin --profile web add ./${tarballName}`,
    harnessUrl,
  }
}

function validateImage(value) {
  if (typeof value !== 'string') throw new Error('缺少处理后的图片。')
  const match = value.match(/^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=]+)$/)
  if (!match) throw new Error('只接受 Canvas 输出的 WebP、PNG 或 JPEG 数据。')
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length === 0 || buffer.length > 12 * 1024 * 1024) throw new Error('处理后的图片大小必须在 1 B 到 12 MB 之间。')
  return { dataUrl: value, buffer }
}

function validateSettings(payload) {
  const palette = Array.isArray(payload.palette) ? payload.palette.slice(0, 4) : []
  if (palette.length < 3 || palette.some(color => !/^#[0-9a-fA-F]{6}$/.test(color))) {
    throw new Error('无法读取有效的主题配色。')
  }
  const positionY = clampNumber(payload.positionY, 0, 100, 50)
  const glassStrength = clampNumber(payload.glassStrength, 35, 92, 72)
  return {
    palette: palette.map(color => color.toLowerCase()),
    positionY,
    glassStrength,
    sourceName: cleanText(payload.sourceName, '自定义背景图', 120),
    sourceWidth: clampNumber(payload.sourceWidth, 1, 20000, 1920),
    sourceHeight: clampNumber(payload.sourceHeight, 1, 20000, 1080),
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function cleanText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.length === 0 ? fallback : cleaned.slice(0, maxLength)
}

function packageManifest() {
  return `${JSON.stringify({
    name: 'harness-image-skin',
    version: '1.0.0',
    description: 'A generated image skin plugin for the DeepSeek Harness web client.',
    type: 'module',
    main: 'index.js',
    exports: {
      '.': './index.js',
      './client': './client.js',
      './package.json': './package.json',
    },
    files: ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'generation.json', 'assets/background.webp'],
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        inject: ['@deepseek-ai/dsh-client-ui-theme'],
        platform: 'web',
      },
    },
    engines: { node: '>=22.19.0' },
    license: 'MIT',
  }, null, 2)}\n`
}

function hostEntry() {
  return `/** Host half: the browser half is discovered through package.json#dsh.client. */\nexport const name = 'harness-image-skin'\nexport function apply() {}\n`
}

function patchManifest() {
  return `- insert:\n    - id: harness-image-skin\n      name: harness-image-skin\n`
}

function clientEntry(imageDataUrl, settings) {
  const [accent, deep, mist, highlight = accent] = settings.palette
  const strength = settings.glassStrength / 100
  const alpha = (0.24 + strength * 0.22).toFixed(2)
  const darkAlpha = (0.31 + strength * 0.22).toFixed(2)
  const lightAlpha = (0.58 + strength * 0.20).toFixed(2)
  const tokens = {
    '--dsw-alias-bg-base': modes(`rgba(246, 250, 255, ${alpha})`, `rgba(7, 17, 29, ${darkAlpha})`),
    '--dsw-alias-bg-layer-1': modes(`rgba(255, 255, 255, ${lightAlpha})`, `rgba(13, 27, 45, ${lightAlpha})`),
    '--dsw-alias-bg-layer-2': modes('rgba(236, 245, 255, 0.86)', 'rgba(18, 36, 57, 0.88)'),
    '--dsw-alias-bg-overlay': modes('rgba(251, 253, 255, 0.96)', 'rgba(11, 23, 39, 0.96)'),
    '--dsw-alias-bg-module-platform': modes('rgba(235, 245, 255, 0.82)', 'rgba(19, 39, 61, 0.84)'),
    '--dsw-specific-sidebar-fill': modes('rgba(235, 244, 254, 0.68)', 'rgba(8, 21, 36, 0.72)'),
    '--dsw-specific-input-major': modes('rgba(255, 255, 255, 0.90)', 'rgba(16, 34, 54, 0.92)'),
    '--dsw-specific-menu': modes('rgba(251, 253, 255, 0.97)', 'rgba(11, 25, 42, 0.97)'),
    '--dsw-specific-selector': modes('rgba(236, 246, 255, 0.94)', 'rgba(21, 42, 65, 0.94)'),
    '--dsw-specific-bubble': modes('rgba(219, 238, 255, 0.92)', 'rgba(31, 61, 91, 0.88)'),
    '--dsw-alias-border-l1': modes(`${mist}80`, `${mist}66`),
    '--dsw-alias-border-l2': modes(`${mist}a8`, `${mist}78`),
    '--dsw-alias-brand-primary': modes(accent, highlight),
    '--dsw-alias-state-business-primary': modes(accent, highlight),
    '--dsw-alias-state-business-tertiary': modes(`${accent}26`, `${accent}38`),
    '--dsw-alias-label-primary': modes(deep, '#edf7ff'),
    '--dsw-alias-label-secondary': modes(`${deep}cc`, '#b9cfe2'),
    '--dsw-alias-interactive-bg-hover': modes(`${accent}18`, `${highlight}24`),
    '--dsw-alias-interactive-bg-hover-solid': modes('#e5f3ff', '#1d3b59'),
    '--dsw-alias-button-floating-fill': modes('rgba(255, 255, 255, 0.92)', 'rgba(19, 40, 62, 0.94)'),
    '--dsw-alias-button-floating-hover': modes('#edf7ff', '#274b6e'),
  }

  return `window.__ModuleLoader__.load({\n` +
    `  id: "harness-image-skin",\n` +
    `  factory: (require) => {\n` +
    `    var module = { exports: {} };\n` +
    `    var exports = module.exports;\n` +
    `    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n` +
    `    const IMAGE = ${JSON.stringify(imageDataUrl)};\n` +
    `    const TOKENS = ${JSON.stringify(tokens, null, 2)};\n` +
    `    const inject = ["theme"];\n` +
    `    function apply(ctx) {\n` +
    `      ctx.effect(() => {\n` +
    `        const body = document.body;\n` +
    `        const previous = {\n` +
    `          marker: body.getAttribute("data-harness-image-skin"),\n` +
    `          image: body.style.getPropertyValue("--harness-image-skin-bg"),\n` +
    `          position: body.style.getPropertyValue("--harness-image-skin-position"),\n` +
    `        };\n` +
    `        const style = document.createElement("style");\n` +
    `        style.dataset.harnessImageSkin = "runtime";\n` +
    `        style.textContent = \`\n` +
    `          html { background: #07111d; }\n` +
    `          body[data-harness-image-skin=\"active\"] {\n` +
    `            background-color: #07111d !important;\n` +
    `            background-image: linear-gradient(90deg, rgba(4, 12, 22, 0.48) 0%, rgba(7, 20, 34, 0.12) 46%, rgba(4, 12, 22, 0.38) 100%), var(--harness-image-skin-bg) !important;\n` +
    `            background-position: center, center var(--harness-image-skin-position) !important;\n` +
    `            background-size: cover, cover !important;\n` +
    `            background-repeat: no-repeat, no-repeat !important;\n` +
    `            background-attachment: fixed, fixed !important;\n` +
    `          }\n` +
    `          body[data-harness-image-skin=\"active\"]:not([data-ds-dark-theme]) {\n` +
    `            background-image: linear-gradient(90deg, rgba(233, 245, 255, 0.20) 0%, rgba(237, 248, 255, 0.02) 48%, rgba(221, 238, 252, 0.12) 100%), var(--harness-image-skin-bg) !important;\n` +
    `          }\n` +
    `          body[data-harness-image-skin=\"active\"] #root { background: transparent !important; }\n` +
    `        \`;\n` +
    `        document.head.appendChild(style);\n` +
    `        body.setAttribute("data-harness-image-skin", "active");\n` +
    `        body.style.setProperty("--harness-image-skin-bg", \`url(\"\${IMAGE}\")\`);\n` +
    `        body.style.setProperty("--harness-image-skin-position", ${JSON.stringify(`${settings.positionY}%`)});\n` +
    `        const disposeTokens = ctx.theme.overrideTokens("harness-image-skin", TOKENS);\n` +
    `        return () => {\n` +
    `          disposeTokens();\n` +
    `          style.remove();\n` +
    `          if (previous.marker === null) body.removeAttribute("data-harness-image-skin");\n` +
    `          else body.setAttribute("data-harness-image-skin", previous.marker);\n` +
    `          restoreProperty(body, "--harness-image-skin-bg", previous.image);\n` +
    `          restoreProperty(body, "--harness-image-skin-position", previous.position);\n` +
    `        };\n` +
    `      }, "harness-image-skin: theme and background");\n` +
    `    }\n` +
    `    function restoreProperty(element, name, value) {\n` +
    `      if (value === "") element.style.removeProperty(name);\n` +
    `      else element.style.setProperty(name, value);\n` +
    `    }\n` +
    `    exports.apply = apply;\n` +
    `    exports.inject = inject;\n` +
    `    return module.exports;\n` +
    `  }\n` +
    `});\n`
}

function modes(light, dark) {
  return { light, dark }
}

function pluginReadme(settings, hash) {
  return `# Harness Image Skin\n\n这是一份由 Harness Skin Studio 根据单张图片生成的 DeepSeek Harness Web 皮肤插件。\n\n## 安装\n\n\`\`\`bash\ndsh plugin --profile web add ./harness-image-skin-1.0.0.tgz\ndsh web\n\`\`\`\n\n## 卸载\n\n\`\`\`bash\ndsh plugin --profile web remove harness-image-skin\n\`\`\`\n\n## 本次生成信息\n\n- 原图：${settings.sourceName}\n- 原图尺寸：${settings.sourceWidth} × ${settings.sourceHeight}\n- 运行时画幅：1920 × 1080\n- 处理后背景 SHA-256：${hash}\n- 背景纵向焦点：${settings.positionY}%\n- 玻璃层强度：${settings.glassStrength}%\n\n插件只使用 Harness 官方 Client Module、ThemeRuntime 和 Bundle/Profile 扩展点，不修改 Harness 源码。\n`
}

function mitLicense() {
  return `MIT License\n\nCopyright (c) 2026 Harness Image Skin contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`
}

function run(command, args, runOptions = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: runOptions.cwd ?? here,
      env: runOptions.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', rejectPromise)
    child.on('close', code => resolvePromise({ code: code ?? 1, stdout, stderr }))
  })
}

function compactOutput(value) {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-8).join('\n')
}

async function profileHasPlugin(home, profile, packageName) {
  try {
    const manifest = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
    return Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, packageName)
  } catch {
    return false
  }
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(`${JSON.stringify(value)}\n`)
}

function sendText(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(value)
}
