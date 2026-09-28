'use strict';
// 席決めくじ v2 の自動テスト。Chrome での見た目・操作は別途ブラウザで確認する。
// 実行: node work/test.cjs （chr ディレクトリで）
const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');

// ---- 最低限の DOM とストレージ ----
class El {
  constructor() { this.style = {}; this.value = ''; this.children = []; this.hidden = false; this.disabled = false; this.textContent = ''; this.attrs = {}; this.open = false; }
  append(...x) { this.children.push(...x); }
  replaceChildren(...x) { this.children = x; }
  querySelector() { return new El(); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  focus() {} click() {} select() {} dispatchEvent() {} addEventListener() {}
  showModal() { this.open = true; } close() { this.open = false; }
}
const els = new Map(), mem = new Map();
const el = id => { if (!els.has(id)) els.set(id, new El()); return els.get(id); };
const bulkKind = new El(); bulkKind.value = 'lottery';
el('addform').addkind = { value: 'lottery' };
let lastCsv = '', lastEl = null, printed = 0;
const ctx = {
  document: { getElementById: el, createElement: () => (lastEl = new El()), createTextNode: t => t, querySelector: () => bulkKind, querySelectorAll: () => [] },
  localStorage: { getItem: k => mem.get(k), setItem: (k, v) => mem.set(k, v) },
  navigator: {}, window: { addEventListener() {}, print() { printed++; } },
  TextEncoder, TextDecoder, btoa: t => globalThis.btoa(t), atob: t => globalThis.atob(t),
  crypto: require('node:crypto').webcrypto, Uint32Array,
  Blob: class { constructor(parts) { lastCsv = parts.join(''); } },
  URL: { createObjectURL: () => 'blob:csv', revokeObjectURL() {} },
  setTimeout: () => 0,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('work/app-check.js', 'utf8'), ctx);

const run = code => vm.runInContext(code, ctx);
const KEY = 'sekigime.v2', OLDKEY = 'sekigime27.v1';
const saved = () => JSON.parse(mem.get(KEY));
const names = () => saved().people.map(p => p.name);
const person = name => saved().people.find(p => p.name === name);
const idOf = name => run(`state.people.find(p=>p.name===${JSON.stringify(name)}).id`);
const seed = data => { mem.set(KEY, JSON.stringify(data)); run('state=read();broken=false;selected=null;render()'); };
const fresh = (seats = 27) => seed({ version: 2, seats, people: [], history: [] });
const roster = (list, kind = 'lottery') => { el('bulk').value = list.join('\n'); bulkKind.value = kind; run("$('bulkadd').onclick()"); };
const pick = name => run(`selected=${JSON.stringify(idOf(name))};render()`);
const draw = name => { pick(name); return run("$('draw').onclick()"); };

(async () => {
  // ===== 名簿 =====
  fresh();
  el('bulk').value = '山田 太郎\n鈴木 花子、佐藤 次郎\t田中 四郎;高橋 五郎';
  bulkKind.value = 'lottery';
  run("$('bulkadd').onclick()");
  assert.deepEqual(names(), ['山田 太郎', '鈴木 花子', '佐藤 次郎', '田中 四郎', '高橋 五郎'], '改行・読点・タブ・セミコロン区切りで一括登録できる');
  assert.equal(saved().people.every(p => p.kind === 'lottery' && p.seat === null && p.drink === null), true);

  roster(['山田 太郎', 'ＹＡＭＡＤＡ', '  鈴木　 花子  '], 'lottery');
  assert.deepEqual(names().slice(5), ['ＹＡＭＡＤＡ'], '既に名簿にある名前（全角・空白違いを含む）は追加しない。入力した表記はそのまま残す');
  assert.match(el('bulkstate').textContent, /すでに登録/);

  roster(['転出 一郎', '転出 二郎'], 'fixed');
  assert.equal(saved().people.filter(p => p.kind === 'fixed').length, 2, '固定席の人数は名簿で決まる（3人固定ではない）');

  el('bulk').value = '  \n 、 ';
  run("$('bulkadd').onclick()");
  assert.match(el('bulkstate').textContent, /読み取れませんでした/);

  // 追加ダイアログ（受付中の飛び込み）
  run("$('addperson').onclick()");
  el('addname').value = '飛び込み 太郎'; el('addform').addkind.value = 'lottery';
  run("$('addform').onsubmit({preventDefault(){}})");
  assert.equal(!!person('飛び込み 太郎'), true, '名簿にない方をその場で追加できる');
  assert.equal(run('selected'), idOf('飛び込み 太郎'), '追加した方がそのまま選択される');
  run("$('addperson').onclick()");
  el('addname').value = '飛び込み 太郎';
  run("$('addform').onsubmit({preventDefault(){}})");
  assert.match(el('adderror').textContent, /すでに名簿にあります/);
  assert.equal(el('adddialog').open, true, '失敗したときはダイアログを閉じない');
  run("$('addcancel').onclick()");

  // ===== 抽選 =====
  const before = person('山田 太郎').seat;
  assert.equal(before, null);
  draw('山田 太郎');
  const seat = person('山田 太郎').seat;
  assert.equal(Number.isInteger(seat) && seat >= 1 && seat <= 27, true, 'くじで1〜27番が決まる');
  assert.match(el('notice').textContent, new RegExp('山田 太郎さんの席は ' + seat + '番'));
  draw('山田 太郎');
  assert.equal(person('山田 太郎').seat, seat, '決まっている方は引き直せない');
  assert.match(el('error').textContent, /すでに/);
  draw('転出 一郎');
  assert.equal(person('転出 一郎').seat, null, '固定席の方はくじを引けない');
  assert.match(el('error').textContent, /固定席です/);

  // 全席を引いても重複しない／空きが無くなったら止まる
  fresh(27);
  roster(Array.from({ length: 28 }, (_, i) => '参加者' + i));
  for (let i = 0; i < 27; i++) draw('参加者' + i);
  const seats = saved().people.filter(p => p.seat !== null).map(p => p.seat).sort((a, b) => a - b);
  assert.deepEqual(seats, Array.from({ length: 27 }, (_, i) => i + 1), '27席が重複なく埋まる');
  assert.equal(el('warn').hidden, false, '席より人数が多いときは警告が出る');
  assert.match(el('warn').textContent, /1人分の席が足りません/);
  draw('参加者27');
  assert.equal(person('参加者27').seat, null);
  assert.match(el('error').textContent, /空いている席がありません/);

  // ===== ドリンク =====
  fresh();
  roster(['のみ 太郎', 'のみ 花子', 'のみ 次郎']);
  roster(['転出 一郎'], 'fixed');
  draw('のみ 太郎');
  run(`saveDrink(${JSON.stringify(idOf('のみ 太郎'))},'ビール')`);
  assert.equal(person('のみ 太郎').drink, 'ビール');
  run(`saveDrink(${JSON.stringify(idOf('のみ 花子'))},'ﾋﾞｰﾙ')`);
  assert.equal(person('のみ 花子').drink, 'ビール', '半角カナは正規化して同じドリンクにまとめる');
  run(`saveDrink(${JSON.stringify(idOf('のみ 次郎'))},'未定')`);
  run(`saveDrink(${JSON.stringify(idOf('転出 一郎'))},'　ハイボール　')`);
  assert.equal(person('転出 一郎').drink, 'ハイボール', '前後の空白は取り除く');
  let s = run('JSON.stringify(summary())'); s = JSON.parse(s);
  assert.equal(s.orders.find(o => o.name === 'ビール').count, 2);
  assert.equal(s.undecided, 1);
  assert.equal(s.none, 0);
  assert.equal(s.total, 4, '固定席の方も集計に入る');
  // NFKC で伸びる名前は保存させない（保存後に記録が読めなくなるのを防ぐ）
  assert.throws(() => run(`apply('x',d=>{d.people[0].drink=checkDrink('㍿'.repeat(16))})`), /1〜60文字/);
  run(`saveDrink(${JSON.stringify(idOf('のみ 太郎'))},'㍿'.repeat(15))`);
  assert.equal(person('のみ 太郎').drink.length, 60);
  assert.equal(run('read().people[0].drink.length'), 60, '60文字ちょうどは保存でき、読み直せる');

  // ===== 席数の設定 =====
  fresh(27);
  roster(['席 太郎']);
  draw('席 太郎');
  const taken = person('席 太郎').seat;
  el('seats').value = String(taken - 1 || 1);
  if (taken > 1) {
    run("$('seatssave').onclick()");
    assert.equal(saved().seats, 27, '決まっている席番号より小さくはできない');
    assert.match(el('error').textContent, new RegExp(taken + '席以上'));
  }
  el('seats').value = '99'; run("$('seatssave').onclick()");
  assert.equal(saved().seats, 99);
  el('seats').value = '100'; run("$('seatssave').onclick()");
  assert.equal(saved().seats, 99);
  el('seats').value = '0'; run("$('seatssave').onclick()");
  assert.equal(saved().seats, 99);
  el('seats').value = 'あ'; run("$('seatssave').onclick()");
  assert.equal(saved().seats, 99);
  assert.match(el('error').textContent, /1〜99の整数/);
  el('seats').value = '30'; run("$('seatssave').onclick()");
  assert.equal(saved().seats, 30, '席数はいつでも変えられる');

  // ===== 修正（名前・区分・ドリンク） =====
  fresh();
  roster(['修正 太郎', '修正 花子']);
  draw('修正 太郎');
  const drawn = person('修正 太郎').seat;
  run(`openEdit(${JSON.stringify(idOf('修正 太郎'))})`);
  assert.equal(el('editname').value, '修正 太郎');
  el('editname').value = '修正 花子'; el('editkind').value = 'lottery'; el('editdrink').value = 'ビール';
  run("$('editform').onsubmit({preventDefault(){}})");
  assert.match(el('editerror').textContent, /すでに名簿にあります/, '名前の重複は修正でも拒否する');
  el('editname').value = '修正 太郎（営業）';
  run("$('editform').onsubmit({preventDefault(){}})");
  assert.equal(person('修正 太郎（営業）').drink, 'ビール', '（）などの全角文字は入力どおりに保存する');
  assert.equal(person('修正 太郎（営業）').seat, drawn);
  // 抽選席 → 固定席にすると席が空きに戻る
  run(`openEdit(${JSON.stringify(idOf('修正 太郎（営業）'))})`);
  el('editkind').value = 'fixed';
  run("$('editform').onsubmit({preventDefault(){}})");
  assert.equal(person('修正 太郎（営業）').kind, 'fixed');
  assert.equal(person('修正 太郎（営業）').seat, null, '固定席にすると席は空きに戻る');
  // ドリンクを未登録に戻せる
  run(`openEdit(${JSON.stringify(idOf('修正 太郎（営業）'))})`);
  el('editdrink').value = '';
  run("$('editform').onsubmit({preventDefault(){}})");
  assert.equal(person('修正 太郎（営業）').drink, null);

  // ===== 取り消し =====
  fresh();
  roster(['取消 太郎', '取消 花子']);
  draw('取消 太郎');
  assert.match(el('undodesk').textContent, /取り消す：取消 太郎さんの抽選/, '何を取り消すのか表示する');
  run("$('undodesk').onclick()");
  assert.equal(person('取消 太郎').seat, null, '間違えて引いた抽選を取り消せる');
  assert.match(el('notice').textContent, /取り消しました/);
  // ドリンク・削除・リセット・席数変更も取り消せる
  draw('取消 太郎');
  const seatAgain = person('取消 太郎').seat;
  run(`saveDrink(${JSON.stringify(idOf('取消 太郎'))},'コーラ')`);
  run("$('undodesk').onclick()");
  assert.equal(person('取消 太郎').drink, null);
  run(`openEdit(${JSON.stringify(idOf('取消 花子'))});$('editdelete').onclick()`);
  assert.equal(names().includes('取消 花子'), false);
  run("$('undodesk').onclick()");
  assert.equal(names().includes('取消 花子'), true, '名簿からの削除も取り消せる');
  run("$('resetseats').onclick()");
  assert.equal(saved().people.every(p => p.seat === null && p.drink === null), true);
  assert.equal(saved().people.length, 2, '席とドリンクのリセットでは名簿は消えない');
  run("$('undodesk').onclick()");
  assert.equal(person('取消 太郎').seat, seatAgain, 'リセットも取り消せる');
  run("$('resetall').onclick()");
  assert.equal(saved().people.length, 0);
  run("$('undolist').onclick()");
  assert.equal(saved().people.length, 2, '名簿ごとのリセットも取り消せる');
  // 履歴は10件まで、なくなれば押せない
  for (let i = 0; i < 12; i++) { el('seats').value = String(30 + i); run("$('seatssave').onclick()"); }
  assert.equal(saved().history.length, 10);
  for (let i = 0; i < 10; i++) run("$('undodesk').onclick()");
  assert.equal(saved().history.length, 0);
  assert.equal(el('undodesk').disabled, true);
  assert.match(el('undodesk').textContent, /取り消せる操作はありません/);

  // ===== 記録の保護 =====
  const okRecord = { version: 2, seats: 27, people: [{ id: 'a', name: 'A', kind: 'lottery', seat: 1, drink: 'ビール' }], history: [] };
  const broken = {
    'JSONでない': '{壊れ',
    'version違い': JSON.stringify({ ...okRecord, version: 3 }),
    '席数0': JSON.stringify({ ...okRecord, seats: 0 }),
    '席数100': JSON.stringify({ ...okRecord, seats: 100 }),
    '席番号が範囲外': JSON.stringify({ version: 2, seats: 27, people: [{ id: 'a', name: 'A', kind: 'lottery', seat: 28, drink: null }], history: [] }),
    '席番号の重複': JSON.stringify({ version: 2, seats: 27, people: [{ id: 'a', name: 'A', kind: 'lottery', seat: 1, drink: null }, { id: 'b', name: 'B', kind: 'lottery', seat: 1, drink: null }], history: [] }),
    'idの重複': JSON.stringify({ version: 2, seats: 27, people: [{ id: 'a', name: 'A', kind: 'lottery', seat: 1, drink: null }, { id: 'a', name: 'B', kind: 'lottery', seat: 2, drink: null }], history: [] }),
    '固定席に席番号': JSON.stringify({ version: 2, seats: 27, people: [{ id: 'a', name: 'A', kind: 'fixed', seat: 1, drink: null }], history: [] }),
    '区分が不正': JSON.stringify({ version: 2, seats: 27, people: [{ id: 'a', name: 'A', kind: 'other', seat: null, drink: null }], history: [] }),
    '名前が空白のみ': JSON.stringify({ version: 2, seats: 27, people: [{ id: 'a', name: '  ', kind: 'lottery', seat: null, drink: null }], history: [] }),
    '名前61文字': JSON.stringify({ version: 2, seats: 27, people: [{ id: 'a', name: 'あ'.repeat(61), kind: 'lottery', seat: null, drink: null }], history: [] }),
    'ドリンクが空文字': JSON.stringify({ version: 2, seats: 27, people: [{ id: 'a', name: 'A', kind: 'lottery', seat: null, drink: '' }], history: [] }),
    'ドリンク61文字': JSON.stringify({ version: 2, seats: 27, people: [{ id: 'a', name: 'A', kind: 'lottery', seat: null, drink: 'あ'.repeat(61) }], history: [] }),
    '201人': JSON.stringify({ version: 2, seats: 27, people: Array.from({ length: 201 }, (_, i) => ({ id: 'i' + i, name: 'N' + i, kind: 'lottery', seat: null, drink: null })), history: [] }),
    'peopleが配列でない': JSON.stringify({ version: 2, seats: 27, people: {}, history: [] }),
    '履歴11件': JSON.stringify({ ...okRecord, history: Array.from({ length: 11 }, () => ({ label: 'x', seats: 27, people: [] })) }),
    '履歴の中身が不正': JSON.stringify({ ...okRecord, history: [{ label: 'x', seats: 27, people: [{ id: 'a', name: 'A', kind: 'lottery', seat: 99, drink: null }] }] }),
  };
  for (const [name, raw] of Object.entries(broken)) {
    mem.set(KEY, raw);
    assert.throws(() => run('read()'), /保存された記録を読み込めません/, '壊れた記録を検出する：' + name);
  }
  mem.set(KEY, JSON.stringify({ version: 2, seats: 99, people: [{ id: 'a', name: 'あ'.repeat(60), kind: 'lottery', seat: 99, drink: 'あ'.repeat(60) }], history: [] }));
  assert.equal(run('read().people[0].seat'), 99, '境界値（99席・60文字）は読める');
  mem.set(KEY, JSON.stringify({ version: 2, seats: 27, people: [] }));
  assert.equal(run('read().history.length'), 0, '履歴が無い記録も読める');

  // 旧版（v1）からの移行
  mem.delete(KEY);
  mem.set(OLDKEY, JSON.stringify({
    version: 1,
    entries: [{ seat: 5, name: '旧 太郎', drink: 'ビール' }, { seat: 12, name: '旧 花子' }, { seat: 9, name: '', drink: null }, { seat: 5, name: '席重複 太郎', drink: 'コーラ' }],
    fixed: [{ id: 'fixed1', name: '転出 一郎', drink: '未定' }, { id: 'fixed2', name: '', drink: null }],
  }));
  const moved = JSON.parse(run('JSON.stringify(read())'));
  assert.deepEqual(moved.people.map(p => [p.name, p.kind, p.seat, p.drink]), [
    ['旧 太郎', 'lottery', 5, 'ビール'],
    ['旧 花子', 'lottery', 12, '未定'],
    ['席重複 太郎', 'lottery', null, 'コーラ'],
    ['転出 一郎', 'fixed', null, '未定'],
  ], '旧版の記録を引き継ぐ（名前なしは除き、席の重複は未抽選に戻す）');
  assert.equal(moved.seats, 27);
  assert.equal(!!mem.get(OLDKEY), true, '旧版の記録は残したまま（保険）');
  mem.delete(OLDKEY);

  // 壊れた記録からリセットで復旧できる
  mem.set(KEY, '{壊れたJSON');
  el('seats').value = '27';
  run("$('seatssave').onclick()");
  assert.equal(run('broken'), true);
  assert.match(el('error').textContent, /保存された記録を読み込めません/, '壊れた記録でも日本語で案内する');
  assert.equal(el('draw').disabled, true);
  assert.equal(el('reset').disabled, false, '壊れていてもリセットは押せる');
  run("$('resetall').onclick()");
  assert.equal(run('broken'), false, 'リセットすれば復旧して使い続けられる');
  assert.equal(el('draw').disabled, false);
  assert.deepEqual(saved(), { version: 2, seats: 27, site: '', event: '', people: [], history: [{ label: 'すべてのリセット', seats: 27, people: [] }] });
  roster(['復旧 太郎']);
  draw('復旧 太郎');
  assert.equal(Number.isInteger(person('復旧 太郎').seat), true, '復旧後はふつうに使える');

  // 保存できないときは記録を壊さない
  const realSet = ctx.localStorage.setItem;
  ctx.localStorage.setItem = () => { throw Error('quota'); };
  const keep = mem.get(KEY);
  roster(['保存失敗 太郎']);
  assert.equal(mem.get(KEY), keep, '保存に失敗しても記録は変わらない');
  assert.match(el('error').textContent, /記録を保存できませんでした/);
  ctx.localStorage.setItem = realSet;
  roster(['保存失敗 太郎']);
  assert.equal(names().includes('保存失敗 太郎'), true, '失敗のあとにやり直せる');

  // ===== スマホ配布（会の名前・公開URL） =====
  fresh();
  roster(['スマホ 太郎', 'スマホ 花子']);
  roster(['転出 一郎'], 'fixed');
  el('eventname').value = '送別会';
  run("$('eventsave').onclick()");
  assert.equal(saved().event, '送別会');
  el('eventname').value = 'あ'.repeat(41);
  run("$('eventsave').onclick()");
  assert.equal(saved().event, '送別会', '41文字の会名は保存しない');
  assert.match(el('error').textContent, /40文字まで/);
  el('site').value = 'https://example.com/seat/#古いハッシュ';
  run("$('sitesave').onclick()");
  assert.equal(saved().site, 'https://example.com/seat/', 'URLの#以降は取り除く');
  el('site').value = 'ftp://example.com/';
  run("$('sitesave').onclick()");
  assert.equal(saved().site, 'https://example.com/seat/', 'http(s) 以外は保存しない');
  assert.match(el('error').textContent, /https:\/\/ で始まる/);
  el('site').value = 'https://example.com/' + 'b'.repeat(290);
  run("$('sitesave').onclick()");
  assert.equal(saved().site, 'https://example.com/seat/', '長すぎるURLは保存しない');
  assert.equal(run('read().site'), 'https://example.com/seat/', '設定は記録に残る');
  assert.equal(run('read().event'), '送別会');
  // 壊れた設定は記録ごと読み込まない
  const okSite = { version: 2, seats: 27, site: '', event: '', people: [], history: [] };
  for (const [name, bad] of Object.entries({
    'siteが文字列でない': JSON.stringify({ ...okSite, site: 5 }),
    'siteが301文字': JSON.stringify({ ...okSite, site: 'x'.repeat(301) }),
    'eventが41文字': JSON.stringify({ ...okSite, event: 'あ'.repeat(41) }),
  })) {
    mem.set(KEY, bad);
    assert.throws(() => run('read()'), /保存された記録を読み込めません/, '壊れた設定を検出する：' + name);
  }

  // ===== 席のまとめ抽選 =====
  fresh(5);
  roster(['ま 太郎', 'ま 花子', 'ま 次郎', 'ま 三郎', 'ま 四郎', 'ま 五郎']);
  run("$('drawall').onclick()");
  assert.match(el('error').textContent, /空いている席がありません/, '人数が席数を超えるときは1人も決めない');
  assert.equal(saved().people.every(p => p.seat === null), true, '途中まで決めて中断しない');
  el('seats').value = '6';
  run("$('seatssave').onclick()");
  run("$('drawall').onclick()");
  const bulkSeats = saved().people.map(p => p.seat).sort((a, b) => a - b);
  assert.deepEqual(bulkSeats, [1, 2, 3, 4, 5, 6], 'まとめ抽選でも席は重複しない');
  assert.match(el('undodesk').textContent, /席のまとめ抽選（6人）/);
  run("$('undodesk').onclick()");
  assert.equal(saved().people.every(p => p.seat === null), true, 'まとめ抽選も取り消せる');
  run("$('drawall').onclick()");

  // ===== 配布リンクとテキスト =====
  el('site').value = 'https://example.com/seat/';
  run("$('sitesave').onclick()");
  el('eventname').value = '送別会';
  run("$('eventsave').onclick()");
  const target = saved().people[0];
  const link = run(`linkFor(state.people[0])`);
  assert.equal(link.startsWith('https://example.com/seat/#'), true);
  const payload = link.split('#')[1];
  const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.deepEqual(json, { n: target.name, s: target.seat, e: '送別会' }, 'リンクに名前・席・会の名前が入る');
  assert.equal(/[+/=]/.test(payload), false, 'URLに使える文字だけを使う');
  assert.equal(run(`textFor(state.people[0])`), '送別会／' + target.name + 'さんのお席は ' + target.seat + '番 です');
  run("$('linkcsv').onclick()");
  const linkLines = lastCsv.replace('﻿', '').split('\r\n');
  assert.equal(linkLines[0], '"お名前","席番号","リンク"');
  assert.equal(linkLines.length, 7, '席が決まった6人分のリンクを書き出す');
  assert.equal(lastEl.download, '席くじリンク一覧.csv');
  // 席が決まっていない方・URL未設定のときはリンクを作らない
  el('site').value = '';
  run("$('sitesave').onclick()");
  assert.equal(run(`linkFor(state.people[0])`), '', 'URL未設定ならリンクは空');
  el('site').value = 'https://example.com/seat/';
  run("$('sitesave').onclick()");

  // ===== 印刷シート =====
  printed = 0;
  run("$('printsheetbtn').onclick()");
  assert.equal(printed, 1, '印刷を呼び出す');
  assert.equal(el('printsheet').children.length, 6, '席が決まった人数ぶんのカードを作る');

  // ===== QRコード =====
  // ブラウザの BarcodeDetector で実際に読み取れることを確認済みの出力を、変化検知用に固定する
  const golden = ['111111101100101111111', '100000100001001000001', '101110100101001011101', '101110101001001011101',
    '101110101110101011101', '100000101001001000001', '111111101010101111111', '000000001001100000000',
    '100010111111011111001', '000100001011100001111', '001111110011011010010', '111110001100010000000',
    '111110101010101100110', '000000001010111101011', '111111101110101011010', '100000100101110110011',
    '101110101101011000110', '101110100100100011011', '101110100111000111000', '100000100001010000000',
    '111111101111111110101'].join('');
  // 型番ごとの符号語数（データ＋誤り訂正）が規格どおりか
  const TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  const ecTable = JSON.parse(run('JSON.stringify(QR_EC)'));
  for (let v = 1; v <= 10; v++) {
    const [ec, b1, d1, b2, d2] = ecTable[v];
    assert.equal(ec * (b1 + b2) + b1 * d1 + b2 * d2, TOTAL[v], '型番' + v + 'の符号語数が規格どおり');
  }
  const hello = JSON.parse(run("JSON.stringify({size:qrEncode('HELLO WORLD').size,bits:Array.from(qrEncode('HELLO WORLD').modules).join('')})"));
  assert.equal(hello.size, 21, 'ASCII 11文字は型番1に収まる');
  assert.equal(hello.bits, golden, '生成したQRコードが以前と同じ（読み取り確認済みの出力）');
  assert.equal(run("qrSvg('HELLO WORLD')===qrSvg('HELLO WORLD')"), true, '同じ内容なら同じQRになる');
  assert.match(run("qrSvg('HELLO WORLD')"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/, '余白4モジュールを付ける');
  // 型番ごとの大きさ
  for (const [bytes, size] of [[16, 21], [28, 25], [44, 29], [64, 33], [86, 37], [108, 41], [124, 45], [154, 49], [182, 53], [213, 57]])
    assert.equal(run(`qrEncode('a'.repeat(${bytes - 3})).size`), size, bytes + 'バイト級は' + size + 'モジュール');
  assert.throws(() => run("qrEncode('a'.repeat(214))"), /収まりません/, '入りきらない長さは断る');
  // 書き込んだ内容を読み戻す（マスク・フォーマット情報・分割・インタリーブの検証）
  const readBack = text => {
    const g = JSON.parse(run(`(()=>{const q=qrEncode(${JSON.stringify(text)});return JSON.stringify({size:q.size,m:Array.from(q.modules)})})()`));
    const size = g.size, m = g.m, at = (r, c) => m[r * size + c];
    const seq = [];
    for (let i = 0; i <= 5; i++) seq.push(at(i, 8));
    seq.push(at(7, 8), at(8, 8), at(8, 7));
    for (let i = 9; i < 15; i++) seq.push(at(8, 14 - i));
    let bits = 0;
    for (let i = 0; i < 15; i++) bits |= seq[i] << i;
    const raw = bits ^ 0x5412, ec = (raw >> 13) & 3, mask = (raw >> 10) & 7;
    const fixed = new Uint8Array(size * size), mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) fixed[r * size + c] = 1; };
    for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(br + dr, bc + dc);
    for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
    for (let i = 0; i <= 8; i++) { mark(8, i); mark(i, 8); }
    for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
    const version = (size - 17) / 4;
    for (const ar of JSON.parse(run('JSON.stringify(QR_ALIGN)'))[version])
      for (const ac of JSON.parse(run('JSON.stringify(QR_ALIGN)'))[version]) {
        if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(ar + dr, ac + dc);
      }
    if (version >= 7) for (let i = 0; i < 18; i++) { mark(size - 11 + i % 3, Math.floor(i / 3)); mark(Math.floor(i / 3), size - 11 + i % 3); }
    const fn = [(r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
      (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0][mask];
    const words = [];
    let acc = 0, n = 0, up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let i = 0; i < size; i++) {
        const row = up ? size - 1 - i : i;
        for (const c of [col, col - 1]) {
          if (fixed[row * size + c]) continue;
          let v = at(row, c);
          if (fn(row, c)) v ^= 1;
          acc = (acc << 1) | v;
          if (++n === 8) { words.push(acc); acc = 0; n = 0; }
        }
      }
      up = !up;
    }
    // 複数ブロックのときは交互に書き込まれているので、元の順に戻す
    const table = JSON.parse(run('JSON.stringify(QR_EC)'))[version];
    const sizes = [...Array(table[1]).fill(table[2]), ...Array(table[3]).fill(table[4])];
    const blocks = sizes.map(() => []);
    let k = 0;
    for (let i = 0; i < Math.max(...sizes); i++)
      for (let b = 0; b < sizes.length; b++)
        if (i < sizes[b]) blocks[b].push(words[k++]);
    return { ec, mask, words: [].concat(...blocks) };
  };
  const back = readBack('HELLO WORLD');
  assert.equal(back.ec, 0, '誤り訂正レベルMとして書かれている');
  assert.equal(back.words.slice(0, 16).map(x => x.toString(16).padStart(2, '0')).join(' '),
    '40 b4 84 54 c4 c4 f2 05 74 f5 24 c4 40 ec 11 ec', '書き込んだ内容を読み戻せる（マスクと配置が合っている）');
  const jp = '送別会／山田 太郎さんのお席は 12番 です';
  const jpBack = readBack(jp);
  const jpBytes = Array.from(new TextEncoder().encode(jp));
  assert.equal(jpBack.ec, 0);
  assert.equal(jpBack.words[0] >> 4, 4, 'バイトモードで書く');
  assert.equal(((jpBack.words[0] & 15) << 4) | (jpBack.words[1] >> 4), jpBytes.length, '文字数（バイト数）が入っている');
  const decoded = [];
  for (let i = 0; i < jpBytes.length; i++) decoded.push(((jpBack.words[i + 1] & 15) << 4) | (jpBack.words[i + 2] >> 4));
  assert.deepEqual(decoded, jpBytes, '日本語はUTF-8のまま書き込む');

  // ===== 参加者用ページ（席くじ-スマホ用.html） =====
  const phoneSrc = fs.readFileSync('outputs/席くじ-スマホ用.html', 'utf8').match(/<script>\n([\s\S]*)\n<\/script>/)[1];
  const openPhone = (hash, hidden) => {
    const pels = new Map();
    const pel = id => { if (!pels.has(id)) pels.set(id, new El()); return pels.get(id); };
    for (const id of ['intro', 'result', 'bad', 'again']) pel(id).hidden = true; // HTMLの初期状態に合わせる
    const store = new Map(), timers = [];
    const pctx = {
      document: { getElementById: pel, createElement: () => new El(), createTextNode: t => t, hidden: !!hidden },
      location: { hash },
      localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) },
      atob: t => globalThis.atob(t), TextDecoder, Uint8Array,
      setInterval: () => 0, clearInterval() {}, setTimeout: fn => { timers.push(fn); return 0; },
    };
    vm.createContext(pctx);
    vm.runInContext(phoneSrc, pctx);
    return { el: pel, store, flush: () => timers.splice(0).forEach(fn => fn()) };
  };
  const linkHash = '#' + run(`linkFor(state.people[0]).split('#')[1]`);
  const who = saved().people[0];
  let phone = openPhone(linkHash);
  assert.equal(phone.el('bad').hidden, true, '正しいリンクならエラー表示にしない');
  assert.equal(phone.el('intro').hidden, false, '開く前は「くじを引く」画面');
  assert.equal(phone.el('name').textContent, who.name + ' さん');
  assert.equal(phone.el('event').textContent, '送別会');
  phone.el('draw').onclick();
  assert.equal(phone.el('result').hidden, false);
  assert.equal(phone.el('number').children.length, 0, '押した直後は番号を見せない（引く演出）');
  phone.flush();
  assert.equal(phone.el('number').children[0], String(who.seat), '演出のあとに自分の席が出る');
  assert.equal(phone.el('name2').textContent, who.name + ' さんのお席');
  assert.equal(phone.store.get('sekikuji.opened.' + linkHash.slice(1)), '1', '開封したことを覚える');
  // 開封済みで開き直すと、すぐに席が出る
  const again = openPhone(linkHash);
  again.store.set('sekikuji.opened.' + linkHash.slice(1), '1');
  const reopened = openPhone(linkHash);
  reopened.store.set('sekikuji.opened.' + linkHash.slice(1), '1');
  // 画面が隠れていても最後まで表示する（スマホでアプリを切り替えたとき）
  const hiddenPhone = openPhone(linkHash, true);
  hiddenPhone.el('draw').onclick();
  assert.equal(hiddenPhone.el('number').children[0], String(who.seat), '画面が裏に回っていても、待たずに席を表示する');
  // 壊れたリンクは受付に案内する
  for (const [name, hash] of Object.entries({
    'ハッシュなし': '',
    '中身が壊れている': '#zzzz',
    '席がない': '#' + globalThis.btoa('{"n":"A"}'),
    '名前がない': '#' + globalThis.btoa('{"s":5}'),
    '席が0': '#' + globalThis.btoa('{"n":"A","s":0}'),
    '席が1000': '#' + globalThis.btoa('{"n":"A","s":1000}'),
    '名前が空': '#' + globalThis.btoa('{"n":"","s":3}'),
  })) {
    const bad = openPhone(hash);
    assert.equal(bad.el('bad').hidden, false, '壊れたリンクを案内する：' + name);
    assert.equal(bad.el('intro').hidden, true);
  }
  // 名前にHTMLが入っていても、文字として表示する
  const xss = '#' + Buffer.from(JSON.stringify({ n: '<img src=x onerror=alert(1)>', s: 5 }), 'utf8').toString('base64');
  const safe = openPhone(xss);
  assert.equal(safe.el('name').textContent, '<img src=x onerror=alert(1)> さん', 'HTMLは文字として扱う');

  // ===== CSV =====
  fresh();
  roster(['=SUM(A1)', '"引用" 太郎', '未抽選 花子']);
  roster(['-マイナス 太郎'], 'fixed');
  draw('=SUM(A1)');
  const injected = person('=SUM(A1)').seat;
  run(`saveDrink(${JSON.stringify(idOf('=SUM(A1)'))},'+コーラ')`);
  draw('"引用" 太郎');
  run("$('csv').onclick()");
  const lines = lastCsv.replace('﻿', '').split('\r\n');
  assert.equal(lastCsv.startsWith('﻿'), true, 'Excel 用に BOM を付ける');
  assert.equal(lines[0], '"席番号","区分","お名前","1杯目のドリンク"');
  assert.equal(lines.length, 5, '見出し＋抽選席3人＋固定席1人');
  assert.equal(lines.some(l => l.includes('"\'=SUM(A1)"') && l.includes('"\'+コーラ"')), true, '数式として解釈されないようにする');
  assert.equal(lines.some(l => l.includes('"""引用"" 太郎"')), true, '引用符をエスケープする');
  assert.equal(lines.some(l => l.startsWith('"未抽選","抽選席","未抽選 花子","未登録"')), true);
  assert.equal(lines[4], '"固定席1","固定席","\'-マイナス 太郎","未登録"');
  assert.equal(lines[1].startsWith('"' + Math.min(injected, person('"引用" 太郎').seat) + '"'), true, '席番号順に並べる');

  console.log('PASS: 参加者用ページ（リンクの読み取り・開封の記憶・壊れたリンクの案内・HTMLの無害化）、スマホ配布（会の名前・公開URLの検証と保存、まとめ抽選と取り消し、リンク／テキストの組み立て、リンクCSV、印刷シート、QRコードの生成と読み戻し）、名簿の一括登録／飛び込み追加／重複・上限、名前を選んでからの抽選（27席ユニーク・固定席は引けない・空席なし）、'
    + 'ドリンクの正規化と集計（固定席を含む）、席数の変更と検証、名前や区分の修正、取り消し（抽選・ドリンク・削除・リセット・席数／履歴10件）、'
    + '壊れた記録17パターンの検出とリセットでの復旧、v1からの移行、保存失敗の保護、CSV出力。');
})();
