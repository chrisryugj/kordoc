#!/usr/bin/env node
// 서울 정보소통광장 결재문서 첨부 수집기 — 연구목적 저속 수집 (1~2초 간격)
// 사용법: node bench/collect-opengov.mjs [최대파일수] [시작페이지] [출력서브디렉토리] [추가쿼리] [제목필터] [제목제외]
// 예: node bench/collect-opengov.mjs 60 1 seoul-old "startDate=2014-01-01&endDate=2016-12-31"
// 예: node bench/collect-opengov.mjs 40 1 review "" "계획|방침|보고" "근무일지|일지"
//
// 2026-07 사이트 개편 대응: 상세 페이지 다운로드 링크에서 dname= 파라미터가 사라지고
// 파일명이 <p class="title-down"> 텍스트로 이동 — 첨부 <li> 블록 단위로 (파일명, 원문
// 다운로드 링크)를 짝지어 추출한다. 구형 dname= 링크도 폴백으로 유지.
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'kordoc-bench/3.0 (research; contact: ryuseungin@gmail.com)';
const BASE = 'https://opengov.seoul.go.kr';
// fileURLToPath — URL.pathname은 Windows에서 "/C:/…"를 내 mkdir가 "C:\C:\…"로 죽는다
const outDir = fileURLToPath(new URL(`./corpus/${process.argv[4] ?? 'seoul'}/`, import.meta.url));
const MAX_FILES = Number(process.argv[2] ?? 60);
const START_PAGE = Number(process.argv[3] ?? 1);
const EXTRA_QUERY = process.argv[5] ? `&${process.argv[5]}` : '';
const TITLE_INCLUDE = process.argv[6] ? new RegExp(process.argv[6]) : null;
const TITLE_EXCLUDE = process.argv[7] ? new RegExp(process.argv[7]) : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => 1000 + Math.random() * 1000;
const headers = { 'User-Agent': UA, Referer: `${BASE}/sanction/list` };

/** 목록 HTML → [{nid, title}] (제목은 앵커 뒤 텍스트에서 태그 제거) */
function parseList(html) {
  const items = [];
  const seen = new Set();
  for (const m of html.matchAll(/href="\/sanction\/(\d{6,})"[^>]*>([\s\S]{0,120}?)<\/a>/g)) {
    const nid = m[1];
    if (seen.has(nid)) continue;
    seen.add(nid);
    const title = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/^제목\s*:\s*/, '').trim();
    items.push({ nid, title });
  }
  return items;
}

/** 상세 HTML → [{fname, link}] — 신형(li 블록) 우선, 구형(dname=) 폴백 */
function parseAttachments(html) {
  const out = [];
  // 신형: <li> … <p class="title-down">파일명.hwpx … href="/og/com/download.php?nid=…&rid=…"
  for (const li of html.split(/<li\b/).slice(1)) {
    const fname = li.match(/class="title-down"[^>]*>\s*([^<]+?\.(?:hwpx?|pdf))\s*</i)?.[1]?.trim();
    if (!fname) continue; // 비공개(다운로드 불가)는 파일명이 txt-gray 스팬 안에만 있음
    const link = li.match(/href="(\/og\/com\/download\.php\?[^"]*rid=[^"]*)"/)?.[1]?.replaceAll('&amp;', '&');
    if (!link) continue;
    out.push({ fname, link });
  }
  if (out.length > 0) return out;
  // 구형: 링크 쿼리의 dname= 에 파일명
  for (const m of html.matchAll(/href="(\/og\/com\/download\.php\?[^"]+)"/g)) {
    const link = m[1].replaceAll('&amp;', '&');
    const dname = decodeURIComponent(link.match(/dname=([^&]+)/)?.[1] ?? '');
    if (/\.(hwpx?|pdf)$/i.test(dname)) out.push({ fname: dname, link });
  }
  return out;
}

await mkdir(outDir, { recursive: true });
const existing = new Set(await readdir(outDir));

let saved = 0;
for (let page = START_PAGE; page < START_PAGE + 30 && saved < MAX_FILES; page++) {
  const listUrl = `${BASE}/sanction/list?items_per_page=50&page=${page}${EXTRA_QUERY}`;
  const html = await (await fetch(listUrl, { headers })).text();
  let items = parseList(html);
  if (TITLE_INCLUDE) items = items.filter(it => TITLE_INCLUDE.test(it.title));
  if (TITLE_EXCLUDE) items = items.filter(it => !TITLE_EXCLUDE.test(it.title));
  console.log(`page ${page}: 문서 ${items.length}건 (필터 후)`);
  await sleep(jitter());

  for (const { nid, title } of items) {
    if (saved >= MAX_FILES) break;
    try {
      const detail = await (await fetch(`${BASE}/sanction/${nid}`, { headers })).text();
      const atts = parseAttachments(detail).filter(a => /\.(hwpx?|pdf)$/i.test(a.fname));
      for (const { fname: dname, link } of atts) {
        if (saved >= MAX_FILES) break;
        const fname = `${nid}_${dname.replaceAll('/', '_')}`;
        if (existing.has(fname)) continue;
        const res = await fetch(BASE + link, { headers });
        if (!res.ok) { console.log(`  ! ${nid} HTTP ${res.status}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1000 || buf.subarray(0, 200).toString().includes('<!DOCTYPE')) continue;
        await writeFile(join(outDir, fname), buf);
        existing.add(fname);
        saved++;
        console.log(`  + [${saved}] ${fname} (${(buf.length / 1024).toFixed(0)}KB) — ${title.slice(0, 40)}`);
        await sleep(jitter());
      }
      await sleep(jitter());
    } catch (e) {
      console.log(`  ! ${nid}: ${e.message}`);
    }
  }
}
console.log(`완료: ${saved}건 저장 → ${outDir}`);
