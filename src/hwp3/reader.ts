/**
 * HWP3 binary stream reader.
 * Buffer 기반 cursor 로 little-endian primitive 를 순차 read 한다.
 * 부족한 데이터에선 InsufficientData 를 throw 해서 상위 try/catch 가 partial-parse 모드로 전환할 수 있게 한다.
 */

export class InsufficientDataError extends Error {
  constructor(public requested: number, public available: number) {
    super(`HWP3: insufficient data (need ${requested}, have ${available})`)
    this.name = "InsufficientDataError"
  }
}

export class Reader {
  private pos: number

  constructor(private readonly buf: Buffer, start = 0) {
    this.pos = start
  }

  position(): number {
    return this.pos
  }

  remaining(): number {
    return this.buf.length - this.pos
  }

  eof(): boolean {
    return this.pos >= this.buf.length
  }

  skip(n: number): void {
    this.ensure(n)
    this.pos += n
  }

  private ensure(n: number) {
    if (this.pos + n > this.buf.length) {
      throw new InsufficientDataError(n, this.buf.length - this.pos)
    }
  }

  readU8(): number {
    this.ensure(1)
    const v = this.buf[this.pos]
    this.pos += 1
    return v
  }

  readU16(): number {
    this.ensure(2)
    const v = this.buf.readUInt16LE(this.pos)
    this.pos += 2
    return v
  }

  readU32(): number {
    this.ensure(4)
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }

  readBytes(n: number): Buffer {
    this.ensure(n)
    const slice = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return slice
  }

  /** 남은 모든 바이트를 새 Buffer 로 반환 (커서를 끝으로 이동). */
  readToEnd(): Buffer {
    const slice = this.buf.subarray(this.pos)
    this.pos = this.buf.length
    return slice
  }
}
