/** redactText PII 탐지·마스킹 순수 로직 단위 테스트 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { redactText, DEFAULT_REDACT_RULES } from "../src/redact.js"

describe("redactText", () => {
  describe("rrn 주민등록번호", () => {
    it("유효한 주민번호 — 앞 6자리 유지, 뒤 7자리 전부 마스크", () => {
      const r = redactText("주민등록번호 900101-2345678 입니다")
      assert.equal(r.text, "주민등록번호 900101-●●●●●●● 입니다")
      assert.deepEqual(r.hits, [
        { rule: "rrn", masked: "900101-●●●●●●●", index: 7, length: 14 },
      ])
    })

    it("유니코드 대시 변형(– en dash) 허용", () => {
      const r = redactText("900101–2345678")
      assert.equal(r.text, "900101–●●●●●●●")
      assert.equal(r.hits[0].rule, "rrn")
    })

    it("뒷자리 첫 숫자 9 → 미탐", () => {
      const r = redactText("900101-9234567")
      assert.equal(r.hits.length, 0)
    })

    it("잘못된 생년월일(999999) → 미탐", () => {
      const r = redactText("999999-1234567")
      assert.equal(r.hits.length, 0)
    })

    it("앞뒤 숫자 연속 시 미탐 (부분매치 방지)", () => {
      const r = redactText("0900101-23456789")
      assert.equal(r.hits.filter((h) => h.rule === "rrn").length, 0)
    })
  })

  describe("phone 전화번호", () => {
    it("휴대폰 010 — 가운데 자리만 마스크", () => {
      const r = redactText("연락처 010-1234-5678")
      assert.equal(r.text, "연락처 010-●●●●-5678")
      assert.equal(r.hits[0].rule, "phone")
    })

    it("서울 02 (가운데 3자리)", () => {
      const r = redactText("02-123-4567")
      assert.equal(r.text, "02-●●●-4567")
    })

    it("지역번호 031 + 온점 구분자", () => {
      const r = redactText("031.234.5678")
      assert.equal(r.text, "031.●●●.5678")
    })

    it("인터넷전화 070 + 공백 구분자", () => {
      const r = redactText("070 7777 1234")
      assert.equal(r.text, "070 ●●●● 1234")
    })

    it("대표번호 1588 — 뒤 4자리 마스크", () => {
      const r = redactText("고객센터 1588-1234")
      assert.equal(r.text, "고객센터 1588-●●●●")
    })

    it("무구분 휴대폰 11자리", () => {
      const r = redactText("01012345678")
      assert.equal(r.text, "010●●●●5678")
    })

    it("혼합 구분자(010.1234-5678) → 미탐", () => {
      const r = redactText("010.1234-5678", { rules: ["phone"] })
      assert.equal(r.hits.length, 0)
    })
  })

  describe("email 이메일", () => {
    it("로컬파트 첫 글자만 남기고 마스크, 도메인 유지", () => {
      const r = redactText("문의: ryuseungin@naver.com")
      assert.equal(r.text, "문의: r●●●●●●●●●@naver.com")
      assert.equal(r.hits[0].rule, "email")
    })

    it("숫자 포함 로컬파트가 phone에 오탐되지 않음 (email 우선)", () => {
      const r = redactText("kim01012345678@example.com")
      assert.equal(r.hits.length, 1)
      assert.equal(r.hits[0].rule, "email")
      assert.equal(r.text, "k●●●●●●●●●●●●●@example.com")
    })
  })

  describe("card 카드번호", () => {
    it("Luhn 유효 카드 — 가운데 8자리 마스크", () => {
      const r = redactText("4111-1111-1111-1111")
      assert.equal(r.text, "4111-●●●●-●●●●-1111")
      assert.equal(r.hits[0].rule, "card")
    })

    it("공백 구분자", () => {
      const r = redactText("4111 1111 1111 1111")
      assert.equal(r.text, "4111 ●●●● ●●●● 1111")
    })

    it("Luhn 실패 → card 미탐", () => {
      const r = redactText("1234-5678-9012-3456", { rules: ["card"] })
      assert.equal(r.hits.length, 0)
    })

    it("Luhn 실패 카드는 기본 룰셋에서 account로 폴백 마스킹 (계약 명시)", () => {
      const r = redactText("1234-5678-9012-3456")
      assert.equal(r.hits.length, 1)
      assert.equal(r.hits[0].rule, "account")
    })

    it("무구분 16자리 → 미탐 (오탐 높아 제외)", () => {
      const r = redactText("4111111111111111")
      assert.equal(r.hits.length, 0)
    })
  })

  describe("account 계좌번호", () => {
    it("3그룹 12자리 — 마지막 그룹 빼고 전부 마스크", () => {
      const r = redactText("입금계좌 110-234-567890")
      assert.equal(r.text, "입금계좌 ●●●-●●●-567890")
      assert.equal(r.hits[0].rule, "account")
    })

    it("사업자등록번호(123-45-67890)는 10자리라 걸린다 (계약 명시)", () => {
      const r = redactText("사업자등록번호 123-45-67890")
      assert.equal(r.hits.length, 1)
      assert.equal(r.hits[0].rule, "account")
      assert.equal(r.text, "사업자등록번호 ●●●-●●-67890")
    })

    it("날짜 2026-07-16 → 미탐 (총 자릿수 미달)", () => {
      const r = redactText("시행일: 2026-07-16")
      assert.equal(r.hits.length, 0)
    })

    it("문서번호 행정-2026-123 → 미탐 (숫자 2그룹뿐)", () => {
      const r = redactText("문서번호 행정-2026-123")
      assert.equal(r.hits.length, 0)
    })

    it("법령 조문번호 → 미탐", () => {
      const r = redactText("「행정업무의 운영 및 혁신에 관한 규정」 제10조제2항 및 별표 3")
      assert.equal(r.hits.length, 0)
    })
  })

  describe("passport 여권번호 (기본 OFF)", () => {
    it("기본 룰셋에서는 미탐", () => {
      const r = redactText("여권번호 M12345678")
      assert.equal(r.hits.length, 0)
    })

    it("룰 켜면 첫 글자만 남기고 마스크", () => {
      const r = redactText("여권번호 M12345678", { rules: ["passport"] })
      assert.equal(r.text, "여권번호 M●●●●●●●●")
      assert.equal(r.hits[0].rule, "passport")
    })

    it("단어 경계 — 영문 단어 내부는 미탐", () => {
      const r = redactText("ROOM12345678", { rules: ["passport"] })
      assert.equal(r.hits.length, 0)
    })
  })

  describe("driver 운전면허 (기본 OFF)", () => {
    it("기본 룰셋에서는 account로 잡힌다 (12자리 4그룹 포섭)", () => {
      const r = redactText("12-34-567890-12")
      assert.equal(r.hits[0]?.rule, "account")
    })

    it("룰 켜면 뒷 8자리 마스크, account보다 우선", () => {
      const r = redactText("면허번호 12-34-567890-12", { rules: ["driver", "account"] })
      assert.equal(r.text, "면허번호 12-34-●●●●●●-●●")
      assert.deepEqual(r.hits.map((h) => h.rule), ["driver"])
    })
  })

  describe("룰 우선순위 겹침", () => {
    it("휴대폰이 account 패턴에 포섭돼도 phone 우선", () => {
      const r = redactText("010-1234-5678")
      assert.equal(r.hits.length, 1)
      assert.equal(r.hits[0].rule, "phone")
      assert.equal(r.text, "010-●●●●-5678")
    })

    it("Luhn 유효 카드가 account보다 우선", () => {
      const r = redactText("4111-1111-1111-1111")
      assert.deepEqual(r.hits.map((h) => h.rule), ["card"])
    })
  })

  describe("마스킹 서식 보존", () => {
    it("마스킹 전후 텍스트 길이 동일 (구분자·자릿수 유지)", () => {
      const input =
        "성명 홍길동 (900101-2345678)\n연락처 010-1234-5678 / kim@corp.co.kr\n계좌 110-234-567890 카드 4111-1111-1111-1111"
      const r = redactText(input)
      assert.equal(r.text.length, input.length)
      assert.equal(r.hits.length, 5)
    })

    it("hits는 index 오름차순 + 오프셋으로 원문 위치 복원 가능", () => {
      const input = "전화 010-1234-5678 주민 900101-2345678"
      const r = redactText(input)
      assert.deepEqual(r.hits.map((h) => h.rule), ["phone", "rrn"])
      for (const h of r.hits) {
        assert.equal(r.text.slice(h.index, h.index + h.length), h.masked)
      }
    })

    it("hits에 원본 PII 필드 없음 — rule·masked·index·length만", () => {
      const r = redactText("900101-2345678")
      assert.deepEqual(Object.keys(r.hits[0]).sort(), ["index", "length", "masked", "rule"])
      assert.ok(!r.hits[0].masked.includes("2345678"))
    })
  })

  describe("옵션·경계값", () => {
    it("빈 문자열 → 그대로 + 빈 hits", () => {
      assert.deepEqual(redactText(""), { text: "", hits: [] })
    })

    it("rules: [] → 아무것도 안 바꿈", () => {
      const r = redactText("900101-2345678", { rules: [] })
      assert.equal(r.text, "900101-2345678")
      assert.equal(r.hits.length, 0)
    })

    it("maskChar 교체", () => {
      const r = redactText("900101-2345678", { maskChar: "*" })
      assert.equal(r.text, "900101-*******")
    })

    it("maskChar 검증 — 2글자·영숫자·빈 문자열은 throw", () => {
      assert.throws(() => redactText("x", { maskChar: "**" }))
      assert.throws(() => redactText("x", { maskChar: "a" }))
      assert.throws(() => redactText("x", { maskChar: "5" }))
      assert.throws(() => redactText("x", { maskChar: "" }))
    })

    it("DEFAULT_REDACT_RULES — passport·driver 제외 5종", () => {
      assert.deepEqual([...DEFAULT_REDACT_RULES].sort(), [
        "account",
        "card",
        "email",
        "phone",
        "rrn",
      ])
    })
  })
})
