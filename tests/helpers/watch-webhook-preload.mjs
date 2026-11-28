// 시험 전용 --import 훅 — webhook 요청을 HOOK_PORT 의 로컬 서버로 돌린다.
// 사설 주소 webhook 은 차단되므로, 풀리지 않는 .invalid 호스트에 문서용 주소(TEST-NET-3)를 돌려준 뒤 연결만 가로챈다.
import http from "node:http"
import dns from "node:dns/promises"
import { syncBuiltinESMExports } from "node:module"

dns.lookup = async () => [{ address: "203.0.113.1", family: 4 }]
const request = http.request
http.request = (_url, options, callback) =>
  request({ host: "127.0.0.1", port: Number(process.env.HOOK_PORT), path: "/", method: options.method, headers: options.headers }, callback)
syncBuiltinESMExports()
