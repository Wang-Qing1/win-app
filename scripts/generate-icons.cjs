/**
 * 生成应用图标：SVG 源文件 → 各尺寸 PNG → Windows .ico（附一张放大对照图）
 *
 *   npm run icons
 *
 * 为什么用 Electron 栅格化而不是 sharp / svg2png：
 *   Chromium 本来就是这套 SVG 要运行的地方，用它的渲染结果就是「所见即所得」，
 *   而且不需要引入带原生编译的重依赖（Windows 上装 sharp 的坑不少）。
 *   代价是必须逐尺寸渲染，不能一次导出，但图标总共有几个尺寸而已。
 *
 * 小尺寸另起一份简版 SVG（icon-small.svg），不是靠等比缩小：
 * 大图里的文字线只有 9/256 粗，缩到 16px 是 0.56 像素，只会糊成一层灰雾。
 *
 * 输出：
 *   build/icon.png            512x512，给 electron-builder 与开发时的窗口图标
 *   build/icon.ico            多尺寸，Windows 应用图标
 *   build/icons/<size>.png    逐尺寸位图，便于单独核对
 *   build/icons/contact-sheet.png  放大对照图，用来目视判断小尺寸是否还读得清
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const BUILD_DIR = join(ROOT, 'build')
const ICONS_DIR = join(BUILD_DIR, 'icons')

/** 每个尺寸用哪份源文件。分界线在 48：32px 以下简版才读得清 */
const SMALL_SIZES = [16, 20, 24, 32]
const LARGE_SIZES = [48, 64, 128, 256]
/** 额外导出的位图，供 electron-builder 与开发时窗口图标使用 */
const MASTER_SIZE = 512
const ALL_SIZES = [...SMALL_SIZES, ...LARGE_SIZES]

// 固定设备像素比：capturePage 的返回尺寸要等于请求尺寸，
// 否则在高 DPI 屏上会得到 1.5 倍大的图，写进 .ico 就全错位了
app.commandLine.appendSwitch('force-device-scale-factor', '1')
// 虚拟机 / 远程桌面里 GPU 不可用时会有各种诡异渲染结果，图标生成不需要 GPU
app.disableHardwareAcceleration()

const WINDOW_SIZE = 700
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** 把内联 SVG 铺满 stage，stage 尺寸由调用方按像素指定 */
function svgPage(svgMarkup) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
#stage{position:absolute;top:0;left:0}
#stage svg{display:block;width:100%;height:100%}
</style></head><body><div id="stage">${svgMarkup}</div></body></html>`
}

const sheetStyles = `
html,body{margin:0;padding:0;overflow:hidden;background:#ffffff;font-family:Consolas,monospace}
.band{padding:10px 12px}
.band--light{background:#f3f3f3;color:#1b1b1b}
.band--dark{background:#1f1f1f;color:#f0f0f0}
.row{display:flex;align-items:flex-end;gap:14px}
.cell{display:flex;flex-direction:column;align-items:center;gap:4px}
.cell span{font-size:10px;white-space:nowrap}
img{display:block;image-rendering:pixelated}
`

async function main() {
  const large = readFileSync(join(BUILD_DIR, 'icon.svg'), 'utf8')
  const small = readFileSync(join(BUILD_DIR, 'icon-small.svg'), 'utf8')

  const win = new BrowserWindow({
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false }
  })

  // 隐藏窗口的合成会被 Chromium 节流，capturePage 会拿到陈旧的第一帧
  // （这个坑在冒烟测试里踩过一次）。先亮出来，再截图。
  win.showInactive()
  await delay(300)

  async function captureRect(html, rect, transparentPage, setup) {
    await win.loadURL(
      dataUrl(
        transparentPage
          ? html
          : `<!doctype html><html><head><meta charset="utf-8"><style>${sheetStyles}</style></head><body>${html}</body></html>`
      )
    )
    // 加载完必须先把布局摆好再截图。漏了这一步，stage 会停在 SVG 的固有尺寸
    // （256），于是 256 那一张是对的、其余尺寸截到的都是画布角落的空白
    if (setup !== undefined) {
      await win.webContents.executeJavaScript(setup)
    }
    await delay(200)
    const image = await win.webContents.capturePage(rect)
    const actual = image.getSize()
    if (actual.width !== rect.width || actual.height !== rect.height) {
      throw new Error(
        `尺寸不符：请求 ${rect.width}x${rect.height}，实得 ${actual.width}x${actual.height}`
      )
    }
    return image
  }

  const captured = new Map()

  async function captureVariant(svgMarkup, sizes) {
    for (const size of sizes) {
      const image = await captureRect(
        svgPage(svgMarkup),
        { x: 0, y: 0, width: size, height: size },
        true,
        `(() => {
          const stage = document.getElementById('stage')
          stage.style.width = '${size}px'
          stage.style.height = '${size}px'
          return true
        })()`
      )
      const png = image.toPNG()
      captured.set(size, png)
      console.log(`  ${String(size).padStart(3)}px  ${png.length} 字节`)
    }
  }

  console.log('渲染图标：')
  await captureVariant(small, SMALL_SIZES)
  await captureVariant(large, [...LARGE_SIZES, MASTER_SIZE])

  // 圆角之外必须是透明的。丢了 alpha 的话图标四角会变成白块，
  // 在最上面一层尤其明显 —— 这里主动验一次，别等装上才发现
  const cornerAlpha = nativeImage.createFromBuffer(captured.get(256)).toBitmap()[3]
  if (cornerAlpha !== 0) {
    throw new Error(`圆角外没有透明（角落 alpha=${cornerAlpha}），窗口的 transparent 没生效`)
  }
  console.log('透明度校验：圆角外 alpha = 0（通过）')

  writeFileSync(join(BUILD_DIR, 'icon.png'), captured.get(MASTER_SIZE))
  console.log(`写出 build/icon.png（${MASTER_SIZE}x${MASTER_SIZE}）`)

  mkdirSync(ICONS_DIR, { recursive: true })
  for (const [size, png] of captured) {
    if (size === MASTER_SIZE) continue
    writeFileSync(join(ICONS_DIR, `${size}.png`), png)
  }

  const ico = buildIco(ALL_SIZES.map((size) => ({ size, png: captured.get(size) })))
  writeFileSync(join(BUILD_DIR, 'icon.ico'), ico)
  console.log(`写出 build/icon.ico（${ALL_SIZES.join(' / ')}，共 ${ico.length} 字节）`)

  await writeContactSheet(captured, captureRect)
  console.log('写出 build/icons/contact-sheet.png')

  win.destroy()
  app.exit(0)
}

/**
 * 放大对照图。
 *
 * 单看一张 16x16 的 PNG 判断不了它能不能认出来 —— 得放到 4 倍、铺在浅色和
 * 深色两种底上，才知道小尺寸下还剩多少信息。放大时用 pixelated，
 * 看到的才是真实像素，而不是被平滑过的假象。
 */
async function writeContactSheet(captured, captureRect) {
  const zoom = (size, factor) => {
    const png = captured.get(size).toString('base64')
    return `<div class="cell"><img src="data:image/png;base64,${png}" width="${size * factor}" height="${size * factor}"><span>${size}px ×${factor}</span></div>`
  }

  const rowA = [16, 24, 32, 48].map((size) => zoom(size, 4)).join('')
  const rowB = [64, 128, 256].map((size) => zoom(size, size <= 64 ? 2 : 1)).join('')

  const body = `
<div class="band band--light"><div class="row">${rowA}</div></div>
<div class="band band--light"><div class="row">${rowB}</div></div>
<div class="band band--dark"><div class="row">${rowA}</div></div>
<div class="band band--dark"><div class="row">${rowB}</div></div>`

  const image = await captureRect(body, { x: 0, y: 0, width: 700, height: 660 }, false)
  writeFileSync(join(ICONS_DIR, 'contact-sheet.png'), image.toPNG())
}

/**
 * 拼一个 PNG 压缩的 ICO。
 *
 * 结构是「6 字节文件头 + 每张图 16 字节目录项 + 各张 PNG 原样拼接」。
 * Vista 以后 Windows 支持目录项直接放 PNG，不需要再转成 DIB ——
 * 否则 256x256 那一张得手动拼 BMP 头与反序的行数据，还得自己压缩。
 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(entries.length * 16)
  let offset = 6 + entries.length * 16

  entries.forEach((entry, index) => {
    const at = index * 16
    // 256 在这个字段里写 0 —— 一个字节放不下 256
    const dimension = entry.size >= 256 ? 0 : entry.size
    directory.writeUInt8(dimension, at)
    directory.writeUInt8(dimension, at + 1)
    directory.writeUInt8(0, at + 2) // 调色板数量：真彩色填 0
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // color planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

app.whenReady().then(main).catch((error) => {
  console.error('图标生成失败：', error)
  app.exit(1)
})
