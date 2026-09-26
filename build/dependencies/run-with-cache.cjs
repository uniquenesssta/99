const path = require('node:path')
const { spawnSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '../..')
// Anchored to the project, never to the caller's working directory or a machine path.
function dependencyCacheEnv(root = projectRoot, inherited = process.env) {
  const cache = path.resolve(root, '../.hfm-deps')
  return {
    ...inherited,
    npm_config_cache: path.join(cache, 'npm'),
    npm_config_prefer_offline: 'true',
    electron_config_cache: path.join(cache, 'electron'),
    ELECTRON_BUILDER_CACHE: path.join(cache, 'electron-builder'),
    CARGO_HOME: path.join(cache, 'cargo'),
  }
}
module.exports = { dependencyCacheEnv, projectRoot }

if (require.main === module) {
  const [kind, ...args] = process.argv.slice(2)
  let command, childArgs
  if (kind === 'npm') {
    if (!process.env.npm_execpath) throw Error('Run through npm, for example: npm run deps:install')
    command = process.execPath
    childArgs = [process.env.npm_execpath, ...args]
  } else if (kind === 'node') {
    command = process.execPath
    childArgs = args
  } else {
    throw Error('Expected npm or node command')
  }
  const result = spawnSync(command, childArgs, { cwd: projectRoot, env: dependencyCacheEnv(), stdio: 'inherit', shell: false })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}
