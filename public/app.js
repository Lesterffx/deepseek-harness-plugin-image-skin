const state = {
  file: null,
  image: null,
  objectUrl: null,
  palette: ['#3f7ca5', '#162636', '#a9cde3', '#6da9cd'],
  installEnabled: false,
  installCommand: '',
  latest: null,
}

const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]
const imageInput = $('#imageInput')
const dropzone = $('#dropzone')
const previewCanvas = $('#previewCanvas')
const renderCanvas = $('#renderCanvas')
const positionRange = $('#positionRange')
const glassRange = $('#glassRange')
const generateButton = $('#generateButton')
const installButton = $('#installButton')
const copyButton = $('#copyButton')

boot()

async function boot() {
  bindEvents()
  updateRange(positionRange)
  updateRange(glassRange)
  try {
    const health = await fetchJson('/api/health')
    state.installEnabled = health.installEnabled
    $('#runtimeStatus').textContent = health.installEnabled ? '本地生成器与隔离 Harness 已连接' : '本地生成器已连接'
    $('#openHarnessButton').href = health.harnessUrl
  } catch (error) {
    $('#runtimeStatus').textContent = '本地生成器连接失败'
    setStatus('连接失败', error.message, 'error')
  }
}

function bindEvents() {
  imageInput.addEventListener('change', event => {
    const [file] = event.target.files
    if (file) void loadImageFile(file)
  })

  for (const eventName of ['dragenter', 'dragover']) {
    dropzone.addEventListener(eventName, event => {
      event.preventDefault()
      dropzone.classList.add('is-dragging')
    })
  }
  for (const eventName of ['dragleave', 'drop']) {
    dropzone.addEventListener(eventName, event => {
      event.preventDefault()
      dropzone.classList.remove('is-dragging')
    })
  }
  dropzone.addEventListener('drop', event => {
    const [file] = event.dataTransfer.files
    if (file) void loadImageFile(file)
  })

  positionRange.addEventListener('input', () => {
    $('#positionValue').value = `${positionRange.value}%`
    updateRange(positionRange)
    renderAll()
  })
  glassRange.addEventListener('input', () => {
    $('#glassValue').value = `${glassRange.value}%`
    updateRange(glassRange)
    renderHarnessPreview()
  })

  generateButton.addEventListener('click', () => void generatePlugin())
  installButton.addEventListener('click', () => void installPlugin())
  copyButton.addEventListener('click', () => void copyInstallCommand())

  $$('.theme-toggle button').forEach(button => button.addEventListener('click', () => {
    $$('.theme-toggle button').forEach(item => item.classList.toggle('is-active', item === button))
    $('#harnessPreview').classList.toggle('is-dark', button.dataset.theme === 'dark')
    $('#harnessPreview').classList.toggle('is-light', button.dataset.theme !== 'dark')
  }))
}

async function loadImageFile(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    showToast('请选择 PNG、JPG 或 WebP 图片。')
    return
  }
  if (file.size > 16 * 1024 * 1024) {
    showToast('原图请控制在 16 MB 以内。')
    return
  }

  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl)
  state.file = file
  state.objectUrl = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'
  image.src = state.objectUrl
  await image.decode()
  state.image = image

  dropzone.classList.add('has-file')
  $('#dropTitle').textContent = '图片已读取'
  $('#dropHint').textContent = '点击可替换另一张图片'
  $('#fileCard').hidden = false
  $('#fileName').textContent = file.name
  $('#fileMeta').textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${formatBytes(file.size)}`
  $('#fileThumb').style.backgroundImage = `url("${state.objectUrl}")`
  $('#canvasWrap').classList.add('has-image')
  $('#harnessPreview').classList.add('has-image')
  generateButton.disabled = false

  renderAll()
  state.palette = extractPalette(renderCanvas)
  applyPalette(state.palette)
  renderHarnessPreview()
  markStep(1, 'complete')
  setStatus('图片读取完成', `${file.name} · ${image.naturalWidth} × ${image.naturalHeight}，可以生成插件。`)
}

function renderAll() {
  if (!state.image) return
  drawCover(renderCanvas, state.image, Number(positionRange.value) / 100)
  drawCover(previewCanvas, state.image, Number(positionRange.value) / 100)
  const position = `${positionRange.value}%`
  $('.focus-line').style.top = position
  renderHarnessPreview()
}

function drawCover(canvas, image, focusY) {
  const context = canvas.getContext('2d', { alpha: false })
  const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
  const width = image.naturalWidth * scale
  const height = image.naturalHeight * scale
  const x = (canvas.width - width) / 2
  const y = (canvas.height - height) * focusY
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, x, y, width, height)
}

function extractPalette(canvas) {
  const sample = document.createElement('canvas')
  sample.width = 80
  sample.height = 45
  const context = sample.getContext('2d', { willReadFrequently: true })
  context.drawImage(canvas, 0, 0, sample.width, sample.height)
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data
  const colors = []
  for (let index = 0; index < pixels.length; index += 16) {
    const r = pixels[index]
    const g = pixels[index + 1]
    const b = pixels[index + 2]
    if (Math.max(r, g, b) - Math.min(r, g, b) < 7 && (r < 28 || r > 238)) continue
    colors.push([r, g, b])
  }
  if (colors.length < 20) return state.palette

  const byLightness = [...colors].sort((a, b) => luminance(a) - luminance(b))
  let centers = [.08, .34, .66, .92].map(point => [...byLightness[Math.floor((byLightness.length - 1) * point)]])
  for (let round = 0; round < 7; round += 1) {
    const groups = centers.map(() => [])
    for (const color of colors) {
      let nearest = 0
      let distance = Infinity
      centers.forEach((center, index) => {
        const next = colorDistance(color, center)
        if (next < distance) { nearest = index; distance = next }
      })
      groups[nearest].push(color)
    }
    centers = groups.map((group, index) => group.length ? average(group) : centers[index])
  }

  const deepSource = [...centers].sort((a, b) => luminance(a) - luminance(b))[0]
  const mistSource = [...centers].sort((a, b) => luminance(b) - luminance(a))[0]
  const accentSource = [...centers].sort((a, b) => saturation(b) - saturation(a))[0]
  const highlightSource = centers
    .filter(color => color !== deepSource && color !== accentSource)
    .sort((a, b) => Math.abs(luminance(a) - 145) - Math.abs(luminance(b) - 145))[0] ?? mistSource
  const accent = normalizeThemeColor(accentSource, { minSaturation: .42, lightness: .40 })
  const deep = normalizeThemeColor(deepSource, { minSaturation: .26, lightness: .17 })
  const mist = normalizeThemeColor(mistSource, { minSaturation: .20, lightness: .80 })
  const highlight = normalizeThemeColor(highlightSource, { minSaturation: .34, lightness: .62 })
  return [accent, deep, mist, highlight].map(rgbToHex)
}

function applyPalette(palette) {
  const [accent, deep, mist, highlight] = palette
  const root = document.documentElement
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-rgb', hexToRgb(accent).join(', '))
  root.style.setProperty('--deep', deep)
  root.style.setProperty('--mist', mist)
  root.style.setProperty('--highlight', highlight)
  $('#swatches').innerHTML = palette.map(color => `<span style="--color:${color}" title="${color}"></span>`).join('')
}

function renderHarnessPreview() {
  if (!state.objectUrl) return
  const preview = $('#harnessPreview')
  preview.style.setProperty('--preview-image', `url("${state.objectUrl}")`)
  preview.style.backgroundPosition = `center ${positionRange.value}%`
  const glass = Number(glassRange.value) / 100
  preview.style.setProperty('--preview-aside', `rgba(236, 246, 253, ${(0.48 + glass * .25).toFixed(2)})`)
  preview.style.setProperty('--preview-main', `rgba(247, 251, 255, ${(0.28 + glass * .28).toFixed(2)})`)
}

async function generatePlugin() {
  if (!state.image || !state.file) return
  generateButton.disabled = true
  installButton.disabled = true
  copyButton.disabled = true
  $('#resultCard').classList.remove('is-success')
  $('#resultTitle').textContent = '正在生成插件'
  $('#resultPath').textContent = '正在把图片、配色和官方插件契约写入安装包…'

  try {
    await runStage(2, '正在适配 16:9 画幅', '在浏览器 Canvas 中真实输出 1920 × 1080 WebP。', async () => {
      drawCover(renderCanvas, state.image, Number(positionRange.value) / 100)
      await wait(520)
    })
    await runStage(3, '正在提取主题配色', '分析图片像素，并同时生成浅色、深色可读性方案。', async () => {
      state.palette = extractPalette(renderCanvas)
      applyPalette(state.palette)
      await wait(560)
    })
    const imageDataUrl = renderCanvas.toDataURL('image/webp', .86)
    let result
    await runStage(4, '正在生成 Client Module', '写入 ThemeRuntime 变量、背景层与卸载清理逻辑。', async () => {
      result = await fetchJson('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl,
          palette: state.palette,
          positionY: Number(positionRange.value),
          glassStrength: Number(glassRange.value),
          sourceName: state.file.name,
          sourceWidth: state.image.naturalWidth,
          sourceHeight: state.image.naturalHeight,
        }),
      })
      await wait(620)
    })
    await runStage(5, '正在打包 Harness Bundle', 'npm pack 已生成可由 dsh plugin add 安装的 .tgz 文件。', () => wait(680))

    state.latest = result
    state.installCommand = result.installCommand
    $('#resultCard').classList.add('is-success')
    $('#resultTitle').textContent = '插件与安装包已经生成'
    $('#resultPath').textContent = result.tarballName
    copyButton.disabled = false
    installButton.disabled = !state.installEnabled
    generateButton.disabled = false
    setStatus('生成完成', `${result.tarballName} 已落盘，接下来可以安装到 Harness Web profile。`)
    showToast('完成：源码目录和 .tgz 安装包都已真实生成。')
  } catch (error) {
    generateButton.disabled = false
    $('#resultTitle').textContent = '生成失败'
    $('#resultPath').textContent = error.message
    setStatus('生成失败', error.message, 'error')
    showToast(error.message)
  }
}

async function runStage(step, title, detail, task) {
  markStep(step, 'active')
  setStatus(title, detail, 'busy')
  await task()
  markStep(step, 'complete')
}

function markStep(step, status) {
  const item = $(`.step[data-step="${step}"]`)
  if (!item) return
  item.classList.remove('is-ready', 'is-active', 'is-complete')
  item.classList.add(status === 'active' ? 'is-active' : status === 'complete' ? 'is-complete' : 'is-ready')
}

async function installPlugin() {
  installButton.disabled = true
  setStatus('正在安装到隔离 Harness', '真实执行 dsh plugin --profile web add，不修改系统默认 profile。', 'busy')
  try {
    const result = await fetchJson('/api/install', { method: 'POST' })
    setStatus('安装完成', '插件已写入隔离 Web profile；启动或刷新 Harness 即可看到效果。')
    showToast(result.message)
    $('#resultTitle').textContent = '插件已经安装到演示 Harness'
  } catch (error) {
    installButton.disabled = false
    setStatus('安装失败', error.message, 'error')
    showToast(error.message)
  }
}

async function copyInstallCommand() {
  if (!state.installCommand) return
  await navigator.clipboard.writeText(state.installCommand)
  showToast('安装命令已复制。')
}

function setStatus(title, detail, mode = 'ok') {
  $('#statusTitle').textContent = title
  $('#statusDetail').textContent = detail
  const dot = $('.status-dot')
  dot.style.background = mode === 'error' ? '#c75b5b' : mode === 'busy' ? 'var(--accent)' : '#579272'
}

let toastTimer
function showToast(message) {
  const toast = $('#toast')
  toast.textContent = message
  toast.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800)
}

async function fetchJson(url, options) {
  const response = await fetch(url, options)
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok === false) throw new Error(body.error ?? `请求失败：HTTP ${response.status}`)
  return body
}

function updateRange(input) {
  const value = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100
  input.style.background = `linear-gradient(90deg, var(--accent) 0 ${value}%, #dfe7ed ${value}% 100%)`
}

function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function formatBytes(bytes) { return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB` }
function luminance([r, g, b]) { return .2126 * r + .7152 * g + .0722 * b }
function saturation([r, g, b]) { return Math.max(r, g, b) - Math.min(r, g, b) }
function colorDistance(a, b) { return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2 }
function average(group) { return [0,1,2].map(channel => Math.round(group.reduce((sum, color) => sum + color[channel], 0) / group.length)) }
function rgbToHex(color) { return `#${color.map(value => value.toString(16).padStart(2, '0')).join('')}` }
function hexToRgb(hex) { return [1,3,5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) }

function normalizeThemeColor(rgb, { minSaturation, lightness }) {
  const [hue, saturationValue] = rgbToHsl(rgb)
  return hslToRgb([hue, Math.max(minSaturation, saturationValue), lightness])
}

function rgbToHsl([red, green, blue]) {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let hue = 0
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    hue /= 6
    if (hue < 0) hue += 1
  }
  const lightness = (max + min) / 2
  const saturationValue = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  return [hue, saturationValue, lightness]
}

function hslToRgb([hue, saturationValue, lightness]) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturationValue
  const segment = hue * 6
  const x = chroma * (1 - Math.abs(segment % 2 - 1))
  let rgb = [0, 0, 0]
  if (segment < 1) rgb = [chroma, x, 0]
  else if (segment < 2) rgb = [x, chroma, 0]
  else if (segment < 3) rgb = [0, chroma, x]
  else if (segment < 4) rgb = [0, x, chroma]
  else if (segment < 5) rgb = [x, 0, chroma]
  else rgb = [chroma, 0, x]
  const match = lightness - chroma / 2
  return rgb.map(value => Math.round((value + match) * 255))
}
