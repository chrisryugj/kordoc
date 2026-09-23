/**
 * 생성 section XML 을 텍스트로 조회하기 쉬운 모양으로 접는 테스트 헬퍼.
 *
 * v5 공문서는 항목부호를 따로 된 run(부호 + <hp:tab/>, 내어쓰기용 자동 탭)으로 내보낸다. 이것을 뒤따르는 내용
 * run 앞 "부호 " 로 접어 부호·내용이 한 <hp:t> 에 있던 모양으로 되돌린다 — "<hp:t>□ 제목" 조회와 charPr 검사
 * (내용 run 의 장평·자간)가 그대로 된다. 묶음 빈칸(<hp:nbSpace/>)은 공백.
 */
export function flatSec(sec: string): string {
  return sec
    // 섹션 첫 문단은 부호 run 이 구역 정의(secPr·ctrl)도 나른다 — 그 머리는 합친 run 에 그대로 둔다
    .replace(/<hp:run charPrIDRef="\d+">((?:(?!<hp:t>|<\/hp:run>)[\s\S])*?)<hp:t>([^<]*)<hp:tab [^>]*\/><\/hp:t><\/hp:run><hp:run charPrIDRef="(\d+)"><hp:t>/g, '<hp:run charPrIDRef="$3">$1<hp:t>$2 ')
    .replace(/<hp:nbSpace\/>/g, " ")
}
