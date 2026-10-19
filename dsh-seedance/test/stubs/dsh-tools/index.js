// 本地验收用的最小 stub：只校验必需字段，不做真实 schema 编译。
export function defineTool(definition) {
  if (!definition || typeof definition.name !== 'string' || !definition.name) {
    throw new Error('defineTool: name is required')
  }
  if (typeof definition.execute !== 'function') {
    throw new Error(`defineTool(${definition.name}): execute is required`)
  }
  return definition
}
