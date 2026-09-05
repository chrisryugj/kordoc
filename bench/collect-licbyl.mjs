#!/usr/bin/env node
// 법제처 별표·서식(licbyl) 코퍼스 수집기 — 연구목적 저속 수집 (1~2초 간격)
// 국가법령정보 공동활용 OpenAPI: lawSearch.do?target=licbyl (별표서식 목록, XML) →
// <별표서식파일링크>(HWP5) + <별표서식PDF파일링크>(PDF) 를 쌍으로 내려받는다.
//
// 사용법: node bench/collect-licbyl.mjs [최대서식수] [출력서브디렉토리] [OC] [--seed=N] [--knd=2] [--exclude=licbyl,...]
// 예: node bench/collect-licbyl.mjs 300 licbyl ryuseungin
//
// 표본: 전체 목록(display=100, 알파벳순)에서 페이지를 균등 보폭으로 고르고 페이지 안에서
// 결정적 의사난수로 3건씩 뽑아 부처·법령·서식명이 겹치지 않게 한다 (같은 법령은 최대 2건).
// 파일명: {별표일련번호}_{법령명}_{별표명}.hwp|pdf — 파일시스템 금지문자만 치환.
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'kordoc-bench/4.13 (research; contact: ryuseungin@gmail.com)';
const BASE = 'https://www.law.go.kr';
const args = process.argv.slice(2);
const pos = args.filter(a => !a.startsWith('--'));
const flag = (k, d) => (args.find(a => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d;
const MAX = Number(pos[0] ?? 300);
const outDir = fileURLToPath(new URL(`./corpus/${pos[1] ?? 'licbyl'}/`, import.meta.url));
const OC = pos[2] ?? process.env.LAW_OC ?? 'ryuseungin';
const SEED = Number(flag('seed', 20260905));
const KND = flag('knd', '2'); // 2 = 서식 (1 = 별표)
const KIND = KND === '1' ? '별표' : '서식';
const PER_PAGE_PICK = 3;
const DISPLAY = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => 1000 + Math.random() * 1000;
const headers = { 'User-Agent': UA };

// 결정적 LCG — 같은 seed 면 같은 표본 (기기 간 코퍼스 재현)
let s = SEED >>> 0;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
  return m ? m[1].trim() : '';
};
const safeName = t => t.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);

async function fetchList(page) {
  const url = `${BASE}/DRF/lawSearch.do?OC=${OC}&target=licbyl&type=XML&knd=${KND}&display=${DISPLAY}&page=${page}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`목록 HTTP ${res.status} page=${page}`);
  const xml = await res.text();
  const total = Number(tag(xml, 'totalCnt'));
  const items = [...xml.matchAll(/<licbyl id="\d+">([\s\S]*?)<\/licbyl>/g)].map(m => {
    const x = m[1];
    return {
      seq: tag(x, '별표일련번호'),
      name: tag(x, '별표명'),
      law: tag(x, '관련법령명'),
      kind: tag(x, '별표종류'),
      dept: tag(x, '소관부처명'),
      hwp: tag(x, '별표서식파일링크'),
      pdf: tag(x, '별표서식PDF파일링크'),
    };
  });
  return { total, items };
}

async function download(link, dest) {
  const res = await fetch(`${BASE}${link}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error(`too small (${buf.length}B)`);
  await writeFile(dest, buf);
  return buf;
}

await mkdir(outDir, { recursive: true });
const have = new Set((await readdir(outDir)).map(f => f.split('_')[0]));
// --exclude=licbyl,licbyl2 : 형제 코퍼스 폴더의 별표일련번호도 중복 제외 (2차 수집)
for (const ex of flag('exclude', '').split(',').filter(Boolean)) {
  const dir = fileURLToPath(new URL(`./corpus/${ex}/`, import.meta.url));
  for (const f of await readdir(dir).catch(() => [])) have.add(f.split('_')[0]);
}
const first = await fetchList(1);
const pages = Math.ceil(first.total / DISPLAY);
const wanted = Math.ceil(MAX / PER_PAGE_PICK);
const stride = Math.max(1, pages / wanted);
console.log(`총 ${first.total}건 / ${pages}페이지 — ${wanted}페이지 × ${PER_PAGE_PICK}건 표본 (stride ${stride.toFixed(1)}, seed ${SEED})`);

const lawCount = new Map();
const manifest = [];
let got = 0, skipped = 0;
for (let k = 0; k < wanted && got < MAX; k++) {
  const page = Math.min(pages, 1 + Math.floor(k * stride + rnd() * stride));
  let list;
  try { list = page === 1 ? first : await fetchList(page); }
  catch (e) { console.warn(`  ! 목록 실패 p${page}: ${e.message}`); await sleep(jitter()); continue; }
  // '삭제 <2014.10.29.>'·'[별지 제6호서식]으로 이동' 은 서식이 아니라 자리표시 문서 — 표본에서 제외
  const pool = list.items.filter(it => it.kind === KIND && it.hwp && it.pdf && !have.has(it.seq) && !/^삭제|으로 이동/.test(it.name));
  // 페이지 안에서 결정적 셔플 후 앞 N건 (같은 법령 2건 상한)
  const order = pool.map(it => ({ it, r: rnd() })).sort((a, b) => a.r - b.r).map(x => x.it);
  let picked = 0;
  for (const it of order) {
    if (picked >= PER_PAGE_PICK || got >= MAX) break;
    if ((lawCount.get(it.law) ?? 0) >= 2) continue;
    const stem = `${it.seq}_${safeName(it.law)}_${safeName(it.name)}`;
    try {
      const hwp = await download(it.hwp, join(outDir, `${stem}.hwp`));
      await sleep(jitter());
      await download(it.pdf, join(outDir, `${stem}.pdf`));
      const magic = hwp.subarray(0, 4).toString('hex');
      manifest.push({ ...it, stem, hwpMagic: magic });
      lawCount.set(it.law, (lawCount.get(it.law) ?? 0) + 1);
      got++; picked++;
      console.log(`  [${got}/${MAX}] p${page} ${it.dept} · ${it.law} · ${it.name}`);
    } catch (e) {
      skipped++;
      console.warn(`  ! 실패 ${it.seq} ${it.name}: ${e.message}`);
    }
    await sleep(jitter());
  }
  await sleep(jitter());
}
await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`완료: ${got}건 수집, ${skipped}건 실패 → ${outDir}`);
