/** 원본 글꼴 문자표와 정확히 일치한 윤곽만 식별한다. 글꼴 파일은 포함하지 않는다. */
import { createHash } from "node:crypto"
import { mapPuaText } from "../shared/pua.js"

export type OutlinePoint = [number, number, boolean]
export interface GlyphOutline { contours: OutlinePoint[][]; upm: number }

/** 지문을 확인한 글꼴 — PDF 글꼴 이름(PostScript 이름 또는 전체 이름) → 비트 */
const FACES: Record<string, number> = {
  "HCRDotum": 1, "HCRDotum-Bold": 2, "HCRBatang": 4, "HCRBatang-Bold": 8,
  "Haansoft Batang": 16, "Haansoft-Batang": 16, "Haansoft Dotum": 32, "Haansoft-Dotum": 32,
}
/**
 * sha256(JSON.stringify([upm, PDF advance(em1000), contours])) 앞 16자리 → [사설 코드, 그 지문이 cmap 에 있는 글꼴 비트].
 * HANDotum·HANDotumB·HANBatang·HANBatangB·HBatang·HDotum 글꼴의 번호 글리프 U+F0288~F029B·F02B0~F02CC
 * (원·네모 숫자와 두 자리 번호 조각 — shared/pua.ts), 네모 안 예 F00DA, 가운데점 F02EF, ⊟·⊞ F03A7·F03A8, ■ F031C,
 * 괘선 조각 F0806~F0810 의 지문이다. 원·네모의 일의 자리 숫자처럼 윤곽·폭이 같은 코드는 공용 정책 글도 같아 한 지문에 둔다.
 * F080F(━)는 쪽 머리·꼬리 장식 줄로 쪽마다 찍힌 문서가 있어(hwp3-sample11) Haansoft Batang 지문 하나만 넣는다(별표 분수 가로줄, 가축분뇨법 시행령 [별표 1]).
 */
const KNOWN: Record<string, [number, number]> = {
  "826331f96b451b13": [0xf00da, 3], // [예]
  "1f3219ba4989a5dd": [0xf00da, 12], // [예]
  "c4abdae02a0adcdc": [0xf00da, 16], // [예]
  "10d5c418739e1ee5": [0xf00da, 32], // [예]
  "25c7519ef8303490": [0xf0288, 3], // ⓪
  "7a4d4fc73a94fd6f": [0xf0288, 12], // ⓪
  "9ac1486abd17f333": [0xf0288, 16], // ⓪
  "70cd3f569bae37e4": [0xf0288, 32], // ⓪
  "f3fc6c0b35446527": [0xf0289, 3], // ①
  "c8b18f8b6909f7eb": [0xf0289, 12], // ①
  "8eb0a9d7ed539b5a": [0xf0289, 16], // ①
  "ea3a316f2ca28f88": [0xf0289, 32], // ①
  "56308212eb08ddc6": [0xf028a, 3], // ②
  "81526da89b2a83e7": [0xf028a, 12], // ②
  "57c21fc91bbd187a": [0xf028a, 16], // ②
  "0a9a9842c5859d24": [0xf028a, 32], // ②
  "95f624806225d322": [0xf028b, 3], // ③
  "22fcf5064c432ac5": [0xf028b, 12], // ③
  "845da0dfe52f7f75": [0xf028b, 16], // ③
  "b4b28c8f658fff6c": [0xf028b, 32], // ③
  "64ef43392a5f4907": [0xf028c, 3], // ④
  "e42417ac350732cd": [0xf028c, 12], // ④
  "0a7304ef03051e39": [0xf028c, 16], // ④
  "38ddce9cc21efe51": [0xf028c, 32], // ④
  "1b8460dc6e7b912c": [0xf028d, 3], // ⑤
  "5f2fe78b05094aec": [0xf028d, 12], // ⑤
  "0d490cbd51284f7e": [0xf028d, 16], // ⑤
  "59cdc6f9196deb3b": [0xf028d, 32], // ⑤
  "a9248e357c6d2f94": [0xf028e, 3], // ⑥
  "14fd2828f84314b2": [0xf028e, 12], // ⑥
  "a374bf3d8ac0390d": [0xf028e, 16], // ⑥
  "9dc030a3d48eab2d": [0xf028e, 32], // ⑥
  "3d4c8ecea5f954a2": [0xf028f, 3], // ⑦
  "011d2e114e023812": [0xf028f, 12], // ⑦
  "dccf0cd2cb2920de": [0xf028f, 16], // ⑦
  "aadf43754e54c718": [0xf028f, 32], // ⑦
  "19f7f2f56a38f6c7": [0xf0290, 3], // ⑧
  "c705ca51164a86fa": [0xf0290, 12], // ⑧
  "f0674c0791905a3b": [0xf0290, 16], // ⑧
  "4c1a5d0e7a2078a2": [0xf0290, 32], // ⑧
  "6171ffd64e69e3c0": [0xf0291, 3], // ⑨
  "7f8640f0b5f6962b": [0xf0291, 12], // ⑨
  "975feebe80392a7a": [0xf0291, 16], // ⑨
  "c713cb5f4a98611e": [0xf0291, 32], // ⑨
  "cadd7be654448e42": [0xf0292, 3], // 0
  "0b9ec49d497d3646": [0xf0292, 12], // 0
  "10a51e102f0306fb": [0xf0292, 16], // 0
  "48a15e77a884ffb3": [0xf0292, 32], // 0
  "c97025da583eb791": [0xf0293, 3], // 1
  "488c136219610b0a": [0xf0293, 12], // 1
  "213957f83bbb739f": [0xf0293, 16], // 1
  "ac809cda3e4a391a": [0xf0293, 32], // 1
  "9f4b5b579d0ba173": [0xf0294, 3], // 2
  "b4543f3d7b21dbed": [0xf0294, 12], // 2
  "cf4060ddff2fbf83": [0xf0294, 16], // 2
  "b05b6b801401474b": [0xf0294, 32], // 2
  "33342b2d368732ca": [0xf0295, 3], // 3
  "a57db9d367b280f1": [0xf0295, 12], // 3
  "cf9c97b8bdbd5dd1": [0xf0295, 16], // 3
  "f7089036b51172e6": [0xf0295, 32], // 3
  "823fc81e44f6c1dd": [0xf0296, 3], // 4
  "288164560efc93c2": [0xf0296, 12], // 4
  "b22de630fdeff95e": [0xf0296, 16], // 4
  "9ef89a7f302fe895": [0xf0296, 32], // 4
  "b37b1bc6f7c09d46": [0xf0297, 3], // 5
  "8189971df4593c4c": [0xf0297, 12], // 5
  "6d3bb5ffa7dc8373": [0xf0297, 16], // 5
  "c6d92fbb5f495527": [0xf0297, 32], // 5
  "254ac5477b752619": [0xf0298, 3], // 6
  "abb8ec7aff98cd65": [0xf0298, 12], // 6
  "b99e44219dddb1c3": [0xf0298, 16], // 6
  "8ae57f96227ded7b": [0xf0298, 32], // 6
  "79c4d7500ede6f6d": [0xf0299, 3], // 7
  "14052a8d421cc20c": [0xf0299, 12], // 7
  "26b8733c4f4cee0a": [0xf0299, 16], // 7
  "67cbd258ede1d1a1": [0xf0299, 32], // 7
  "823090b6d43f1253": [0xf029a, 3], // 8
  "270d964bb683d135": [0xf029a, 12], // 8
  "da8df7ffecee06e6": [0xf029a, 16], // 8
  "9425a73553094ef8": [0xf029a, 32], // 8
  "02e3297d2a71cf3f": [0xf029b, 3], // 9
  "cbdf54dd95a84117": [0xf029b, 12], // 9
  "cc92e0b3fa06d8a2": [0xf029b, 16], // 9
  "81d62c8e9242637b": [0xf029b, 32], // 9
  "18840c2b372836b1": [0xf02b0, 3], // ⓪
  "e2985a2dc2c729c1": [0xf02b0, 12], // ⓪
  "7c42aa23c1a68e32": [0xf02b0, 16], // ⓪
  "8bb6b32ba84d6ea0": [0xf02b0, 32], // ⓪
  "1b0a094dcfd7aefc": [0xf02b1, 3], // ①
  "75ad8123e5e01977": [0xf02b1, 12], // ①
  "8a4af2cf2dfe3238": [0xf02b1, 16], // ①
  "7828251a7a571442": [0xf02b1, 32], // ①
  "aae8317fb2a0107a": [0xf02b2, 3], // ②
  "b89bc7926f0c3f01": [0xf02b2, 12], // ②
  "7332dcab9d77002b": [0xf02b2, 16], // ②
  "8d74bcf8acd941a3": [0xf02b2, 32], // ②
  "8f24a5ed56b3bf1b": [0xf02b3, 3], // ③
  "4352941ed1545430": [0xf02b3, 12], // ③
  "e7cc725807eae1ae": [0xf02b3, 16], // ③
  "f6a21cbb2b062080": [0xf02b3, 32], // ③
  "9d4c236dfd7b8185": [0xf02b4, 3], // ④
  "04c4fa723908a3fd": [0xf02b4, 12], // ④
  "3956a9db6baa74ef": [0xf02b4, 16], // ④
  "4c850a0e2e079596": [0xf02b4, 32], // ④
  "de1c0ac7276ae7ae": [0xf02b5, 3], // ⑤
  "b153a10aa5d3636c": [0xf02b5, 12], // ⑤
  "8340732dc5f6a75a": [0xf02b5, 16], // ⑤
  "2cfe943ce9a12ec8": [0xf02b5, 32], // ⑤
  "520e685af87659bd": [0xf02b6, 3], // ⑥
  "142011df67c9b44f": [0xf02b6, 12], // ⑥
  "1412a79bd9ed7fdb": [0xf02b6, 16], // ⑥
  "ed6ad4f3954e8ceb": [0xf02b6, 32], // ⑥
  "0ef28db85f8cec3c": [0xf02b7, 3], // ⑦
  "67f0a679b7f2d027": [0xf02b7, 12], // ⑦
  "64760d2273d92363": [0xf02b7, 16], // ⑦
  "f35d358a18f7686a": [0xf02b7, 32], // ⑦
  "51a2cf4d6a635cb7": [0xf02b8, 3], // ⑧
  "a29075d7a2fb6d84": [0xf02b8, 12], // ⑧
  "eb19943ef67624e2": [0xf02b8, 16], // ⑧
  "97311736edcf72f5": [0xf02b8, 32], // ⑧
  "641fdd5b007be3ed": [0xf02b9, 3], // ⑨
  "3302bd6c6a89f170": [0xf02b9, 12], // ⑨
  "c70d5cf181c87ff3": [0xf02b9, 16], // ⑨
  "cfc718a620755cc7": [0xf02b9, 32], // ⑨
  "ace6bb494fed2822": [0xf02ba, 3], // ①
  "5e95e7c19a0a3252": [0xf02ba, 12], // ①
  "366c206a1a5eb7b3": [0xf02ba, 16], // ①
  "d774e0d5bf84b4eb": [0xf02ba, 32], // ①
  "3dd6397d43caff8a": [0xf02bb, 3], // ②
  "071ca79d1928ca6a": [0xf02bb, 12], // ②
  "f87edf8771950efc": [0xf02bb, 16], // ②
  "605e83b5db1c25e5": [0xf02bb, 32], // ②
  "d1b6e256036e3c3b": [0xf02bc, 3], // ③
  "d3b776f144feaeab": [0xf02bc, 12], // ③
  "2df1cac0085b70ea": [0xf02bc, 16], // ③
  "75a76c9c0c4f1c4b": [0xf02bc, 32], // ③
  "6ff861ec8f16dbfd": [0xf02bd, 3], // ④
  "0a8f9fca0df85993": [0xf02bd, 12], // ④
  "c499cc2964bd0779": [0xf02bd, 16], // ④
  "e205b0387cab87cf": [0xf02bd, 32], // ④
  "0363c022091ead97": [0xf02be, 3], // ⑤
  "f273353f24dc13b3": [0xf02be, 12], // ⑤
  "d654e7a8fe433226": [0xf02be, 16], // ⑤
  "9e7de3de310828d5": [0xf02be, 32], // ⑤
  "cfa634873e746a80": [0xf02bf, 3], // ⑥
  "95548e9f1f188c06": [0xf02bf, 12], // ⑥
  "137c82933241676c": [0xf02bf, 16], // ⑥
  "0c65ceb7ea70c76e": [0xf02bf, 32], // ⑥
  "a628f9637b3e16c6": [0xf02c0, 3], // ⑦
  "f7da31a2bd1a4fcb": [0xf02c0, 12], // ⑦
  "04eb03456ade3835": [0xf02c0, 16], // ⑦
  "3e2f588ec93a8c1a": [0xf02c0, 32], // ⑦
  "08dbe26d5e2215e3": [0xf02c1, 3], // ⑧
  "fb2fb5d7159da4e1": [0xf02c1, 12], // ⑧
  "fc5b77fcf4ba7625": [0xf02c1, 16], // ⑧
  "3a43e9161faff052": [0xf02c1, 32], // ⑧
  "9d96ee04f1fee34a": [0xf02c2, 3], // ⑨
  "620c1fe6557dc2e1": [0xf02c2, 12], // ⑨
  "ca04c951be8e90a0": [0xf02c2, 16], // ⑨
  "1a8d0f130913b394": [0xf02c2, 32], // ⑨
  "08f95e2d8f93e79c": [0xf02c3, 16], // 0
  "7753a030002921f3": [0xf02c3, 32], // 0
  "4afc19da05acec69": [0xf02c4, 32], // 1
  "57a8e8356417989d": [0xf02c5, 32], // 2
  "baf0a674c0ead6e8": [0xf02c6, 32], // 3
  "b5d1475bbd0f3664": [0xf02c7, 16], // 4
  "f11aec151661b94c": [0xf02c7, 32], // 4
  "85966b97f6841cea": [0xf02c8, 32], // 5
  "a8bea1990c0d2da7": [0xf02c9, 32], // 6
  "6cf70b1be4cb338a": [0xf02ca, 32], // 7
  "25a2a23bf0916876": [0xf02cb, 32], // 8
  "08c28287d2e5ca4a": [0xf02cc, 32], // 9
  "bb7a2a3ab48d5bfd": [0xf02ef, 3], // ·
  "0def640ab8b3d0dd": [0xf02ef, 12], // ·
  "92cde1460f8b9741": [0xf02ef, 16], // ·
  "bf4a39ce21068bca": [0xf02ef, 32], // ·
  "88bc8d90af006b6e": [0xf031c, 15], // ■
  "aa4c7212192186fa": [0xf031c, 48], // ■
  "4d42e9990c15cced": [0xf03a7, 15], // ⊟
  "6857a6fa443ea10a": [0xf03a7, 48], // ⊟
  "f1aba8be3af5e204": [0xf03a8, 15], // ⊞
  "941878859ff9044f": [0xf03a8, 48], // ⊞
  "0f4a7a4e4706126d": [0xf0806, 15], // ┌
  "75c326411cb5667d": [0xf0806, 48], // ┌
  "dda10d803b819e44": [0xf0807, 15], // ┬
  "5c3d963f00d6c0eb": [0xf0807, 48], // ┬
  "a8ff5c3ff51cfd3d": [0xf0808, 15], // ┐
  "8500249727d63a45": [0xf0808, 48], // ┐
  "8c4b57517c58ee56": [0xf080c, 15], // └
  "a42ba1e406489654": [0xf080c, 48], // └
  "442960c8dfd5e763": [0xf080e, 15], // ┘
  "f1d0f30f61e84248": [0xf080e, 48], // ┘
  "65d24bb2fe5dcf5a": [0xf0810, 15], // │
  "5644629ab371a597": [0xf0810, 48], // │
  "e5a11875a73dba10": [0xf080f, 16], // ━ (함초롬바탕 계열 Haansoft Batang 만 — 분수 가로줄. 쪽 장식 줄 문서의 글꼴은 넣지 않는다)
}
/** 확인한 글꼴의 지문이면 그 글리프의 사설 코드 */
export function knownFontPua(name: string | undefined, outline: GlyphOutline, width: unknown): number | null {
  const face = FACES[name?.replace(/^[A-Z]{6}\+/, "") ?? ""]
  if (!face) return null
  const hit = KNOWN[createHash("sha256").update(JSON.stringify([outline.upm, width, outline.contours])).digest("hex").slice(0, 16)]
  return hit && hit[1] & face ? hit[0] : null
}
export function knownFontGlyph(name: string | undefined, outline: GlyphOutline, width: unknown): string | null {
  const code = knownFontPua(name, outline, width)
  return code === null ? null : mapPuaText(String.fromCodePoint(code))
}
