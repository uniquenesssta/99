// Explicit development entry; normal `npm run dev` keeps the current backend.
const { spawnSync } = require('node:child_process')
const path = require('node:path')
if (process.platform !== 'win32') throw Error('DirectWrite 试用需要 Windows 10/11 x64。')
const root = path.resolve(__dirname, '../..')
const build = spawnSync('cmd.exe', ['/d', '/c', 'native-src\\preview-renderer\\directwrite\\build-win.cmd'], { cwd: root, stdio: 'inherit' })
if (build.error || build.status !== 0) {
  console.error('DirectWrite 编译失败。请安装带 C++ 桌面开发及 Windows SDK 的 Visual Studio Build Tools。')
  process.exit(build.status || 1)
}
const dev = spawnSync('cmd.exe', ['/d', '/c', 'npm run dev'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, HFM_PREVIEW_BACKEND: 'directwrite-resident' },
})
process.exit(dev.status || (dev.error ? 1 : 0))
