/* oxlint-disable no-bitwise -- Java modified UTF-8 packs code-unit bits into wire bytes. */

const CONTINUATION_MASK = 0xc0
const CONTINUATION_VALUE = 0x80

const isContinuation = (value: number): boolean => (value & CONTINUATION_MASK) === CONTINUATION_VALUE

const invalidModifiedUtf8 = (offset: number): TypeError =>
  new TypeError(`invalid Java modified UTF-8 at byte offset ${String(offset)}`)

/** Encode the UTF-16 code units used by Java's DataOutput.writeUTF. */
export const encodeModifiedUtf8 = (value: string): Uint8Array => {
  let length = 0
  for (const codeUnit of value) {
    const codePoint = codeUnit.codePointAt(0)!
    if (codePoint === 0) {
      length += 2
    } else if (codePoint <= 0x7f) {
      length += 1
    } else if (codePoint <= 0x7ff) {
      length += 2
    } else {
      length += codePoint > 0xffff ? 6 : 3
    }
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit === 0) {
      bytes[offset] = 0xc0
      bytes[offset + 1] = 0x80
      offset += 2
      continue
    }
    if (codeUnit <= 0x7f) {
      bytes[offset] = codeUnit
      offset += 1
      continue
    }
    if (codeUnit <= 0x7ff) {
      bytes[offset] = 0xc0 | (codeUnit >> 6)
      bytes[offset + 1] = CONTINUATION_VALUE | (codeUnit & 0x3f)
      offset += 2
      continue
    }
    bytes[offset] = 0xe0 | (codeUnit >> 12)
    bytes[offset + 1] = CONTINUATION_VALUE | ((codeUnit >> 6) & 0x3f)
    bytes[offset + 2] = CONTINUATION_VALUE | (codeUnit & 0x3f)
    offset += 3
  }
  return bytes
}

/** Decode the UTF-16 code units accepted by Java's DataInput.readUTF. */
export const decodeModifiedUtf8 = (bytes: Uint8Array): string => {
  let value = ''
  for (let offset = 0; offset < bytes.length; ) {
    const first = bytes[offset]!

    if (first >= 0x01 && first <= 0x7f) {
      value += String.fromCharCode(first)
      offset += 1
      continue
    }

    if ((first & 0xe0) === 0xc0) {
      const second = bytes[offset + 1]
      if (second === undefined || !isContinuation(second)) throw invalidModifiedUtf8(offset)
      const codeUnit = ((first & 0x1f) << 6) | (second & 0x3f)
      if (codeUnit !== 0 && codeUnit < 0x80) throw invalidModifiedUtf8(offset)
      value += String.fromCharCode(codeUnit)
      offset += 2
      continue
    }

    if ((first & 0xf0) === 0xe0) {
      const second = bytes[offset + 1]
      const third = bytes[offset + 2]
      if (
        second === undefined ||
        third === undefined ||
        !isContinuation(second) ||
        !isContinuation(third)
      ) {
        throw invalidModifiedUtf8(offset)
      }
      const codeUnit = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
      if (codeUnit < 0x800) throw invalidModifiedUtf8(offset)
      value += String.fromCharCode(codeUnit)
      offset += 3
      continue
    }

    throw invalidModifiedUtf8(offset)
  }
  return value
}
