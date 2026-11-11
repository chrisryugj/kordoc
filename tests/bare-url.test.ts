/**
 * 글 속 맨 http(s) 주소 — GFM 확장 자동 링크로 읽히는 주소는 이스케이프하지 않는다(자동 링크 안 \ 는 글자라 링크 주소에 섞인다).
 * md-runs 는 그 주소를 강조로 읽지 않는다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { escapeGfm } from "../src/table/builder.js"
import { parseInlineMarkdown } from "../src/hwpx/md-runs.js"

const URL_ = "https://m.site.kr/~user/_next_/v?id=1|2&x=*y*"

describe("본문 URL", () => {
  it("GFM 이 링크로 읽는 주소는 그대로, 주소 밖 글은 종전대로 이스케이프", () => {
    assert.equal(escapeGfm(`안내 ${URL_} 끝 *강조 아님*`), `안내 ${URL_} 끝 \\*강조 아님\\*`)
    assert.equal(escapeGfm("(https://a.kr/x_(y)) 와 HTTPS://A.KR/~x."), "(https://a.kr/x_(y)) 와 HTTPS://A.KR/~x.")
  })

  it("GFM 이 링크로 읽지 않는 주소·링크 글 안 주소는 이스케이프", () => {
    // 호스트 밑줄·앞이 영문자면 GFM 자동 링크가 아니다 — 그대로 두면 ~x~ 가 취소선이 된다
    assert.equal(escapeGfm("https://a_b.kr/~x~ xhttps://a.kr/~x~"), "https://a_b.kr/\\~x\\~ xhttps://a.kr/\\~x\\~")
    // 링크 글 안은 자동 링크가 아니다(링크 안 링크 없음). 링크 주소부는 종전처럼 보호
    assert.equal(escapeGfm("[https://a.kr/~x](https://a.kr/~x)"), "[https://a.kr/\\~x](https://a.kr/~x)")
  })

  it("md-runs 는 맨 주소를 강조로 읽지 않는다 — escapeGfm 출력을 다시 읽으면 원문", () => {
    for (const md of [`안내 ${URL_} 와 https://a.kr/_x_/ *기울임*`, escapeGfm(`안내 ${URL_} 와 https://a.kr/_x_/`) + " *기울임*"]) {
      const spans = parseInlineMarkdown(md)
      assert.equal(spans.map(s => s.text).join(""), `안내 ${URL_} 와 https://a.kr/_x_/ 기울임`, md)
      assert.deepEqual(spans.filter(s => s.italic).map(s => s.text), ["기울임"], md)
    }
    for (const t of ["https://a_b.kr/~x~ 끝", "~~https://a.kr/~s~~", "`https://a.kr/*x*`"]) {
      assert.equal(parseInlineMarkdown(escapeGfm(t)).map(s => s.text).join(""), t, t)
    }
  })

  it("www. 주소도 GFM 과 같은 조건 — 줄 맨 앞·공백·( 뒤의 소문자 www. 만 링크", () => {
    assert.equal(escapeGfm("안내 www.a.kr/~x~ 와 (www.b.kr/_y_)"), "안내 www.a.kr/~x~ 와 (www.b.kr/_y_)")
    assert.equal(escapeGfm("주소:www.a.kr/~x~ WWW.A.KR/~x~ www.a_b.kr/~x~"), "주소:www.a.kr/\\~x\\~ WWW.A.KR/\\~x\\~ www.a_b.kr/\\~x\\~")
  })

  it("원문이 <…> 나 따옴표로 감싼 URL 은 이전처럼 이스케이프 — 감싸거나 꺾쇠를 더하지 않는다", () => {
    // 메인테이너 벤치 web067: xmlns 속성값·<출처: …> 안의 주소가 <…> 로 한 번 더 감싸였다
    assert.equal(escapeGfm('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">'), '\\<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">')
    assert.equal(escapeGfm("<출처: 국토부, https://a.kr/~x>"), "<출처: 국토부, https://a.kr/\\~x>")
    assert.equal(escapeGfm("\\<https://a.kr/x>"), "\\\\\\<https://a.kr/x>")
    // <u> 같은 kordoc 표지 뒤는 닫힌 태그라 보호한다
    assert.equal(escapeGfm("<u>https://a.kr/~x</u>"), "<u>https://a.kr/~x</u>")
  })
})
