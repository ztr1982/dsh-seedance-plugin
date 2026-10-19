// 本地验收用的最小 stub：支持 .default() 链式调用与 object()。
class Field {
  constructor(kind, value) {
    this.kind = kind
    this.value = value
  }

  default(value) {
    this.value = value
    return this
  }

  description() {
    return this
  }
}

const Schema = {
  string: (value = '') => new Field('string', value),
  number: (value = 0) => new Field('number', value),
  boolean: (value = false) => new Field('boolean', value),
  object: (shape) => ({ kind: 'object', shape }),
}

export default Schema
