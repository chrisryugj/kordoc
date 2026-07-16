/**
 * OLE2/CFB 섹터 레벨 스트림 교체 — 컨테이너 전체 재조립 없이 in-place 수술.
 *
 * 전체 재작성(SheetJS CFB.write 등)은 섹터 배치/FAT/디렉토리를 전부 다시 만들어
 * 한/글의 엄격한 OLE 파서가 거부할 수 있다. 이 모듈은 원본 파일 바이트를 그대로
 * 두고 다음만 수정한다:
 *  - 대상 스트림의 데이터 섹터 (재사용/추가 할당)
 *  - FAT/miniFAT의 해당 체인 엔트리
 *  - 디렉토리 엔트리의 start/size 8바이트
 *  - (필요 시) 파일 끝에 새 섹터 추가 + FAT/DIFAT/miniFAT 확장
 * 나머지 영역은 바이트 단위로 원본과 동일하게 유지된다.
 *
 * 지원: CFB v3 (512B 섹터). HWP 5.x는 전부 v3.
 */

const SECTOR = 512
const MINI_SECTOR = 64
const MINI_CUTOFF = 4096
const FREESECT = 0xffffffff
const ENDOFCHAIN = 0xfffffffe
const FATSECT = 0xfffffffd
const DIFSECT = 0xfffffffc

export class OleSurgeonError extends Error {}

interface DirEntry {
  /** 디렉토리 배열 내 인덱스 */
  index: number
  name: string
  type: number
  left: number
  right: number
  child: number
  start: number
  size: number
}

/**
 * OLE 컨테이너의 스트림 1개를 새 내용으로 교체한 새 버퍼를 반환.
 * @param file 원본 OLE 파일 전체
 * @param path "/" 구분 경로 (예: "BodyText/Section0")
 */
export function replaceOleStream(file: Buffer, path: string, newData: Buffer): Buffer {
  const surgeon = new Surgeon(file)
  surgeon.replace(path, newData)
  return surgeon.finish()
}

class Surgeon {
  private buf: Buffer
  private fat: number[] = []
  /** FAT 배열을 구성하는 섹터 번호들 (DIFAT 순서) */
  private fatSectors: number[] = []
  private miniFat: number[] = []
  private miniFatSectors: number[] = []
  private dirSectors: number[] = []
  private entries: DirEntry[] = []
  /** replace()가 FREESECT로 해제한 섹터 — finish()에서 재할당 안 된 것만 0으로 지움 (데이터 잔존 방지) */
  private freedSectors: number[] = []
  private freedMiniSectors: number[] = []

  constructor(file: Buffer) {
    if (file.length < SECTOR || file.readUInt32LE(0) !== 0xe011cfd0) {
      throw new OleSurgeonError("OLE 시그니처가 아닙니다")
    }
    if (file.readUInt16LE(26) !== 3 || file.readUInt16LE(30) !== 9) {
      throw new OleSurgeonError("CFB v3(512B 섹터)만 지원합니다")
    }
    // 섹터 경계로 패딩된 사본에서 작업
    const padded = Math.ceil((file.length - SECTOR) / SECTOR) * SECTOR + SECTOR
    this.buf = Buffer.alloc(padded)
    file.copy(this.buf)
    this.loadFat()
    this.loadMiniFat()
    this.loadDirectory()
  }

  // ── 로드 ──

  private loadFat(): void {
    const difat: number[] = []
    for (let i = 0; i < 109; i++) difat.push(this.buf.readUInt32LE(76 + i * 4))
    let difatSector = this.buf.readUInt32LE(68)
    let guard = 0
    while (difatSector !== ENDOFCHAIN && difatSector !== FREESECT && guard++ < 1_000_000) {
      const off = this.sectorOffset(difatSector)
      for (let i = 0; i < 127; i++) difat.push(this.buf.readUInt32LE(off + i * 4))
      difatSector = this.buf.readUInt32LE(off + 127 * 4)
    }
    this.fatSectors = difat.filter(s => s !== FREESECT)
    for (const s of this.fatSectors) {
      const off = this.sectorOffset(s)
      for (let i = 0; i < 128; i++) this.fat.push(this.buf.readUInt32LE(off + i * 4))
    }
  }

  private loadMiniFat(): void {
    const start = this.buf.readUInt32LE(60)
    this.miniFatSectors = start === ENDOFCHAIN || start === FREESECT ? [] : this.chain(start)
    for (const s of this.miniFatSectors) {
      const off = this.sectorOffset(s)
      for (let i = 0; i < 128; i++) this.miniFat.push(this.buf.readUInt32LE(off + i * 4))
    }
  }

  private loadDirectory(): void {
    this.dirSectors = this.chain(this.buf.readUInt32LE(48))
    for (let si = 0; si < this.dirSectors.length; si++) {
      const off = this.sectorOffset(this.dirSectors[si])
      for (let i = 0; i < 4; i++) {
        const e = off + i * 128
        const nameLen = this.buf.readUInt16LE(e + 64)
        const name = nameLen >= 2 ? this.buf.subarray(e, e + nameLen - 2).toString("utf16le") : ""
        this.entries.push({
          index: si * 4 + i,
          name,
          type: this.buf[e + 66],
          left: this.buf.readInt32LE(e + 68),
          right: this.buf.readInt32LE(e + 72),
          child: this.buf.readInt32LE(e + 76),
          start: this.buf.readUInt32LE(e + 116),
          size: this.buf.readUInt32LE(e + 120),
        })
      }
    }
  }

  // ── 헬퍼 ──

  private sectorOffset(n: number): number {
    const off = SECTOR + n * SECTOR
    if (n >= 0xfffffffa || off + SECTOR > this.buf.length) throw new OleSurgeonError(`섹터 범위 초과: ${n}`)
    return off
  }

  private chain(start: number): number[] {
    const out: number[] = []
    let s = start
    while (s !== ENDOFCHAIN) {
      if (s === FREESECT || s >= this.fat.length || out.length > this.fat.length) {
        throw new OleSurgeonError("FAT 체인 손상")
      }
      out.push(s)
      s = this.fat[s]
    }
    return out
  }

  private miniChain(start: number): number[] {
    const out: number[] = []
    let s = start
    while (s !== ENDOFCHAIN) {
      if (s === FREESECT || s >= this.miniFat.length || out.length > this.miniFat.length) {
        throw new OleSurgeonError("miniFAT 체인 손상")
      }
      out.push(s)
      s = this.miniFat[s]
    }
    return out
  }

  /** 디렉토리 트리에서 경로 해석 (형제 = L/R 이진 트리, 자식 = child) */
  private findEntry(path: string): DirEntry {
    const parts = path.replace(/^\//, "").split("/")
    let scope = this.entries[0]?.child ?? -1
    let current: DirEntry | undefined
    for (const part of parts) {
      // 빨강-검정 형제 트리를 순회해 이름이 일치하는 엔트리를 찾는다
      const search = (idx: number): DirEntry | undefined => {
        if (idx < 0 || idx >= this.entries.length) return undefined
        const e = this.entries[idx]
        return search(e.left) ?? (e.name === part ? e : undefined) ?? search(e.right)
      }
      current = search(scope)
      if (!current) throw new OleSurgeonError(`스트림 없음: ${path}`)
      scope = current.child
    }
    if (!current || current.type !== 2) throw new OleSurgeonError(`스트림이 아님: ${path}`)
    return current
  }

  private rootEntry(): DirEntry {
    return this.entries[0]
  }

  // ── 할당 ──

  /**
   * FAT에서 빈 섹터 n개 확보 (부족하면 파일 끝에 추가) — 섹터 번호 목록 반환.
   * 확보 즉시 ENDOFCHAIN으로 마킹해 같은 수술 내 중복 할당을 방지한다 (체인 링크는
   * 호출자가 덮어씀).
   */
  private allocSectors(n: number): number[] {
    const out: number[] = []
    for (let i = 0; i < this.fat.length && out.length < n; i++) {
      if (this.fat[i] !== FREESECT) continue
      // FAT가 파일보다 길게 패딩된 영역은 건너뜀 (백킹 바이트 없음)
      if (SECTOR + (i + 1) * SECTOR > this.buf.length) continue
      this.fat[i] = ENDOFCHAIN
      // 재사용 free 섹터는 즉시 0 초기화 — 부분 기록(mini stream 64B 단위 등) 시
      // 이전 스트림 바이트가 슬랙에 남는 remanence 방지
      const off = this.sectorOffset(i)
      this.buf.fill(0, off, off + SECTOR)
      out.push(i)
    }
    while (out.length < n) {
      // FAT 확장이 파일 끝에 FAT 섹터를 추가할 수 있으므로 인덱스는 확장 후 재계산
      this.ensureFatCapacity((this.buf.length - SECTOR) / SECTOR + 2)
      const idx = (this.buf.length - SECTOR) / SECTOR
      this.buf = Buffer.concat([this.buf, Buffer.alloc(SECTOR)])
      this.fat[idx] = ENDOFCHAIN
      out.push(idx)
    }
    return out
  }

  /** FAT 배열이 sectorCount개 엔트리를 담도록 확장 (FAT 섹터 추가 + DIFAT 갱신) */
  private ensureFatCapacity(sectorCount: number): void {
    while (this.fat.length < sectorCount) {
      // 새 FAT 섹터는 파일 끝에 추가 (할당 재귀 방지)
      const idx = (this.buf.length - SECTOR) / SECTOR
      this.buf = Buffer.concat([this.buf, Buffer.alloc(SECTOR)])
      for (let i = 0; i < 128; i++) this.fat.push(FREESECT)
      this.fat[idx] = FATSECT
      this.fatSectors.push(idx)
      // DIFAT 헤더 슬롯(109개)에 등록 — 초과(FAT 109섹터 ≈ 7MB)는 미지원
      const slot = this.fatSectors.length - 1
      if (slot >= 109) throw new OleSurgeonError("DIFAT 체인 확장은 미지원 (7MB 초과 컨테이너 성장)")
      this.buf.writeUInt32LE(idx, 76 + slot * 4)
      this.buf.writeUInt32LE(this.fatSectors.length, 44) // header fatSectors
    }
  }

  /** miniFAT에서 빈 미니섹터 n개 확보 (mini stream 용량/miniFAT 확장 포함) */
  private allocMiniSectors(n: number): number[] {
    const root = this.rootEntry()
    const rootChain = root.start === ENDOFCHAIN || root.size === 0 ? [] : this.chain(root.start)
    let capacity = rootChain.length * (SECTOR / MINI_SECTOR)

    const out: number[] = []
    // 빈 엔트리 재사용 — 백킹 바이트(root 체인 용량) 있는 범위만
    for (let i = 0; i < Math.min(this.miniFat.length, capacity) && out.length < n; i++) {
      if (this.miniFat[i] === FREESECT) { this.miniFat[i] = ENDOFCHAIN; out.push(i) }
    }
    let nextIdx = capacity
    while (out.length < n) {
      // miniFAT 엔트리 공간 확장
      if (nextIdx >= this.miniFat.length) {
        const [s] = this.allocSectors(1)
        if (this.miniFatSectors.length > 0) this.fat[this.miniFatSectors[this.miniFatSectors.length - 1]] = s
        else this.buf.writeUInt32LE(s, 60) // header miniFatStart
        this.miniFatSectors.push(s)
        this.buf.writeUInt32LE(this.miniFatSectors.length, 64) // header miniFatCnt
        for (let i = 0; i < 128; i++) this.miniFat.push(FREESECT)
      }
      // mini stream 데이터 용량 확장 (root 체인 연장)
      if (nextIdx >= capacity) {
        const [s] = this.allocSectors(1)
        if (rootChain.length > 0) this.fat[rootChain[rootChain.length - 1]] = s
        else { root.start = s }
        rootChain.push(s)
        capacity = rootChain.length * (SECTOR / MINI_SECTOR)
        root.size = Math.max(root.size, rootChain.length * SECTOR)
        this.writeDirEntry(root)
      }
      this.miniFat[nextIdx] = ENDOFCHAIN
      out.push(nextIdx)
      nextIdx++
    }
    return out
  }

  // ── 기록 ──

  private writeDirEntry(e: DirEntry): void {
    const sector = this.dirSectors[Math.floor(e.index / 4)]
    const off = this.sectorOffset(sector) + (e.index % 4) * 128
    this.buf.writeUInt32LE(e.start, off + 116)
    this.buf.writeUInt32LE(e.size, off + 120)
  }

  private flushFat(): void {
    for (let i = 0; i < this.fatSectors.length; i++) {
      const off = this.sectorOffset(this.fatSectors[i])
      for (let j = 0; j < 128; j++) {
        const idx = i * 128 + j
        this.buf.writeUInt32LE(idx < this.fat.length ? this.fat[idx] : FREESECT, off + j * 4)
      }
    }
    for (let i = 0; i < this.miniFatSectors.length; i++) {
      const off = this.sectorOffset(this.miniFatSectors[i])
      for (let j = 0; j < 128; j++) {
        const idx = i * 128 + j
        this.buf.writeUInt32LE(idx < this.miniFat.length ? this.miniFat[idx] : FREESECT, off + j * 4)
      }
    }
  }

  /** 미니섹터 k의 파일 내 바이트 오프셋 (root 체인 경유) */
  private miniOffset(k: number, rootChain: number[]): number {
    const within = k * MINI_SECTOR
    const sec = rootChain[Math.floor(within / SECTOR)]
    if (sec === undefined) throw new OleSurgeonError("mini stream 범위 초과")
    return this.sectorOffset(sec) + (within % SECTOR)
  }

  // ── 메인 ──

  replace(path: string, newData: Buffer): void {
    const entry = this.findEntry(path)

    // 1) 기존 체인 해제 — 해제 섹터는 기록해 finish()에서 바이트를 지운다 (삭제 전 데이터 잔존 방지)
    if (entry.size > 0 && entry.start !== ENDOFCHAIN) {
      if (entry.size < MINI_CUTOFF) {
        for (const s of this.miniChain(entry.start)) {
          this.miniFat[s] = FREESECT
          this.freedMiniSectors.push(s)
        }
      } else {
        for (const s of this.chain(entry.start)) {
          this.fat[s] = FREESECT
          this.freedSectors.push(s)
        }
      }
    }

    // 2) 새 체인 할당 + 데이터 기록
    if (newData.length < MINI_CUTOFF) {
      const count = Math.ceil(newData.length / MINI_SECTOR) || 1
      const sectors = this.allocMiniSectors(count)
      const rootChain = this.chain(this.rootEntry().start)
      for (let i = 0; i < sectors.length; i++) {
        this.miniFat[sectors[i]] = i + 1 < sectors.length ? sectors[i + 1] : ENDOFCHAIN
        const off = this.miniOffset(sectors[i], rootChain)
        this.buf.fill(0, off, off + MINI_SECTOR)
        newData.copy(this.buf, off, i * MINI_SECTOR, Math.min((i + 1) * MINI_SECTOR, newData.length))
      }
      entry.start = sectors[0]
    } else {
      const count = Math.ceil(newData.length / SECTOR)
      const sectors = this.allocSectors(count)
      for (let i = 0; i < sectors.length; i++) {
        this.fat[sectors[i]] = i + 1 < sectors.length ? sectors[i + 1] : ENDOFCHAIN
        const off = this.sectorOffset(sectors[i])
        this.buf.fill(0, off, off + SECTOR)
        newData.copy(this.buf, off, i * SECTOR, Math.min((i + 1) * SECTOR, newData.length))
      }
      entry.start = sectors[0]
    }
    entry.size = newData.length
    this.writeDirEntry(entry)
  }

  finish(): Buffer {
    this.wipeFreedSectors()
    this.flushFat()
    return this.buf
  }

  /** 해제 후 재할당되지 않고 남은 FREESECT 섹터의 바이트를 0으로 채움 (데이터 remanence 제거) */
  private wipeFreedSectors(): void {
    for (const s of this.freedSectors) {
      if (this.fat[s] !== FREESECT) continue // 새 체인에 재사용됨 — 이미 새 데이터 기록
      const off = this.sectorOffset(s)
      this.buf.fill(0, off, off + SECTOR)
    }
    if (this.freedMiniSectors.length > 0) {
      const root = this.rootEntry()
      const rootChain = root.start === ENDOFCHAIN || root.size === 0 ? [] : this.chain(root.start)
      for (const s of this.freedMiniSectors) {
        if (this.miniFat[s] !== FREESECT) continue
        const off = this.miniOffset(s, rootChain)
        this.buf.fill(0, off, off + MINI_SECTOR)
      }
    }
  }
}
