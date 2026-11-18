#!/usr/bin/env node
// korea.kr 정책브리핑 보도자료 첨부파일 수집기 (robots.txt 허용 확인됨: Allow /)
// 사용법: node bench/collect-korea-kr.mjs [최대파일수] [출력서브디렉토리] [RSS피드명=pressrelease]
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDocBytes, dispositionName } from './collect-lib.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) kordoc-bench/3.0';
const outDir = new URL(`./corpus/${process.argv[3] ?? 'korea-kr'}/`, import.meta.url).pathname;
const MAX_FILES = Number(process.argv[2] ?? 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));

await mkdir(outDir, { recursive: true });
const existing = new Set(await readdir(outDir));
// 신규 서브디렉토리 수집 시 기본 디렉토리와의 문서 중복 방지
const baseDir = new URL('./corpus/korea-kr/', import.meta.url).pathname;
if (outDir !== baseDir) for (const f of await readdir(baseDir).catch(() => [])) existing.add(f);

// 응답 상태를 먼저 본다 — 오류 쪽 본문은 <item> 이 없어 「0건」 정상 종료와 구별되지 않는다
const rssRes = await fetch(`https://www.korea.kr/rss/${process.argv[4] ?? 'pressrelease'}.xml`, { headers: { 'User-Agent': UA } });
if (!rssRes.ok) { console.log(`! RSS HTTP ${rssRes.status}`); process.exit(1); }
const rss = await rssRes.text();
const items = [...rss.matchAll(/<item>(.*?)<\/item>/gs)].map(m => {
  const link = m[1].match(/<link>(?:<!\[CDATA\[)?\s*(.*?)\s*(?:\]\]>)?<\/link>/s)?.[1];
  const title = m[1].match(/<title>(?:<!\[CDATA\[)?\s*(.*?)\s*(?:\]\]>)?<\/title>/s)?.[1];
  return { link, title };
}).filter(x => x.link?.includes('newsId='));
console.log(`RSS 항목: ${items.length}건`);

let saved = 0;
const failed = [];
for (const { link, title } of items) {
  if (saved >= MAX_FILES) break;
  const newsId = link.match(/newsId=(\d+)/)?.[1];
  try {
    const page = await fetch(link, { headers: { 'User-Agent': UA } });
    if (!page.ok) { console.log(`  ! ${newsId} 보기 HTTP ${page.status}`); failed.push(newsId); continue; }
    const html = await page.text();
    const fileIds = [...new Set([...html.matchAll(/download\.do\?fileId=(\d+)&(?:amp;)?tblKey=GMN/g)].map(m => m[1]))];
    for (const fid of fileIds) {
      if (saved >= MAX_FILES) break;
      const url = `https://www.korea.kr/common/download.do?fileId=${fid}&tblKey=GMN`;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) { console.log(`  ! ${fid} HTTP ${res.status}`); continue; }
      let fname = dispositionName(res.headers.get('content-disposition') ?? '', `${fid}.bin`);
      if (!/\.(hwpx?|pdf)$/i.test(fname)) { continue; }
      fname = `${newsId}_${fname.replaceAll('/', '_')}`;
      if (existing.has(fname)) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) continue;
      if (!isDocBytes(buf, fname)) { console.log(`  ! ${fname} 문서가 아님 (${res.headers.get('content-type') ?? '형식 모름'}) 저장 안 함`); continue; }
      await writeFile(join(outDir, fname), buf);
      existing.add(fname);
      saved++;
      console.log(`  + [${saved}] ${fname} (${(buf.length / 1024).toFixed(0)}KB)`);
      await sleep(400);
    }
    await sleep(300);
  } catch (e) {
    console.log(`  ! ${newsId}: ${e.message}`);
    failed.push(newsId);
  }
}
console.log(`완료: ${saved}건 저장 → ${outDir}`);
if (failed.length) { console.log(`실패 보도자료 ${failed.length}건: ${failed.join(', ')}`); process.exitCode = 1; }
