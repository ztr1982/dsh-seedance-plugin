/**
 * 测试夹具：把 index.js + lib 拷到临时目录，并在旁边放最小 SDK stub。
 * 这样插件源码目录里不会残留 node_modules，避免链接安装后解析到假 SDK。
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fixture = join(here, '.fixture')

export function prepareFixture() {
  rmSync(fixture, { recursive: true, force: true })
  mkdirSync(join(fixture, 'node_modules', '@deepseek-ai'), { recursive: true })

  cpSync(join(root, 'index.js'), join(fixture, 'index.js'))
  cpSync(join(root, 'lib'), join(fixture, 'lib'), { recursive: true })

  for (const pkg of ['dsh-tools', 'schemastery']) {
    cpSync(join(here, 'stubs', pkg), join(fixture, 'node_modules', '@deepseek-ai', pkg), { recursive: true })
  }

  return pathToFileURL(join(fixture, 'index.js')).href
}

export function removeFixture() {
  rmSync(fixture, { recursive: true, force: true })
}
