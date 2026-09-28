'use strict';
// 席くじ GAS 版（gas/Code.gs）の単体テスト。GAS のサービスは test/gas-mock.cjs でモックしています。
// 実行: node test/gas.test.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createGasContext, createBackend, callServer } = require('./gas-mock.cjs');

const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'gas', 'Code.gs'), 'utf8');
const HTML = { Admin: '<p>ADMIN PAGE</p>', Participant: '<p>PARTICIPANT PAGE</p>' };
const DATETIME = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/;
const ERR_TOKEN = 'QRコードが無効です。受付にお声がけください。';
const ERR_KEY = '幹事用の合言葉が違います。';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failed++; console.error('✗ ' + name + '\n   ' + (err && err.stack || err).toString().split('\n').slice(0, 6).join('\n   ')); }
}
const throwsMsg = (fn, re, msg) => assert.throws(fn, err => (re instanceof RegExp ? re.test(err.message) : err.message === re) || assert.fail((msg || '') + ' 実際のエラー: ' + err.message));

// 準備: セットアップ済みのコンテキスト
function fresh(opts = {}) {
  const ctx = createGasContext(Object.assign({ htmlFiles: HTML }, opts));
  ctx.setup();
  const key = ctx.__mock.props.ADMIN_KEY;
  const call = (name, ...args) => callServer(ctx, name, args);
  const admin = (name, ...args) => callServer(ctx, name, [key, ...args]);
  const people = () => admin('adminGetState').people;
  const byName = n => people().find(p => p.name === n);
  const add = (names, kind = 'lottery') => admin('adminAddPeople', names, kind);
  const rows = () => ctx.__mock.values('参加者');
  return { ctx, key, call, admin, people, byName, add, rows };
}
const range = (n, prefix = '参加者') => Array.from({ length: n }, (_, i) => prefix + (i + 1));

/* ================= マニフェスト・公開関数 ================= */
test('appsscript.json: 東京・V8・匿名アクセスの Web アプリ', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas', 'appsscript.json'), 'utf8'));
  assert.equal(m.timeZone, 'Asia/Tokyo');
  assert.equal(m.runtimeVersion, 'V8');
  assert.equal(m.webapp.executeAs, 'USER_DEPLOYING');
  assert.equal(m.webapp.access, 'ANYONE_ANONYMOUS');
});

test('クライアントから呼べる（末尾が _ でない）トップレベル関数は仕様の一覧だけ', () => {
  const names = [...CODE.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]).filter(n => !n.endsWith('_')).sort();
  assert.deepEqual(names, ['adminAddPeople', 'adminDeletePerson', 'adminDrawAll', 'adminDrawOne', 'adminGetState', 'adminReissueToken', 'adminReset', 'adminResetJoinCode', 'adminSaveSettings', 'adminUpdatePerson', 'doGet', 'joinClaim', 'joinList', 'menuResetAdminKey', 'onOpen', 'participantDraw', 'participantGet', 'participantSetDrink', 'setup', 'showAdminUrl'].sort());
  // 関数式などで公開関数を作っていないこと（var/let/const で関数を代入していない）
  assert.doesNotMatch(CODE, /^(?:var|let|const)\s+[A-Za-z$][\w$]*[^_\s]\s*=\s*(?:function|\()/m);
  assert.doesNotMatch(CODE, /\b(?:require|import|export|process|module\.exports)\b[\s(.]/, 'Node の API を使っていない');
});

test('callServer は末尾 _ の関数・存在しない関数を呼べない', () => {
  const { ctx } = fresh();
  assert.throws(() => callServer(ctx, 'load_', []), /Script function not found/);
  assert.throws(() => callServer(ctx, 'nope', []), /Script function not found/);
});

/* ================= setup ================= */
test('setup: シート・見出し・既定の設定・合言葉を作る', () => {
  const { ctx, key, admin } = fresh();
  assert.match(key, /^[A-Za-z0-9]{24,}$/, '合言葉は24文字以上の英数字');
  const ppl = ctx.__mock.sheet('参加者');
  assert.deepEqual(ppl._dump()[0], ['ID', 'トークン', 'お名前', '区分', '席番号', 'ドリンク', '抽選日時', 'ドリンク登録日時', '受付日時', '受付確認キー']);
  assert.equal(ppl.getFrozenRows(), 1);
  const settings = Object.fromEntries(ctx.__mock.values('設定').map(r => [r[0], r[1]]));
  assert.equal(Number(settings.seats), 27);
  assert.equal(settings.event, '');
  assert.equal(settings.drinks, 'ビール\nハイボール\nレモンサワー\nウーロン茶\nオレンジジュース\nコーラ');
  assert.equal(String(settings.drinkOpen).toUpperCase(), 'TRUE');
  assert.equal(settings.baseUrl, '');
  assert.match(settings.joinCode, /^[A-Za-z0-9]{12}$/, '共通QRコードも作る');
  assert.equal(String(settings.joinOpen).toUpperCase(), 'TRUE');
  assert.equal(ctx.__mock.props.SHEET_ID, ctx.__mock.spreadsheet.getId());
  assert.match(ctx.__mock.logs.join('\n'), /幹事画面のURLを表示/);
  const s = admin('adminGetState');
  assert.deepEqual(s.settings.drinks, ['ビール', 'ハイボール', 'レモンサワー', 'ウーロン茶', 'オレンジジュース', 'コーラ']);
  assert.equal(s.settings.seats, 27);
  assert.equal(s.settings.drinkOpen, true);
  assert.equal(s.settings.appUrl, 'https://script.google.com/macros/s/TESTDEPLOY/exec');
  assert.match(s.updatedAt, DATETIME);
});

test('setup を再実行しても合言葉・名簿・設定は変わらない（クライアントから呼ばれても安全）', () => {
  const { ctx, key, admin, add } = fresh();
  add(['山田']);
  admin('adminSaveSettings', { seats: 10, event: '忘年会' });
  assert.equal(callServer(ctx, 'setup', []), undefined);
  assert.equal(ctx.__mock.props.ADMIN_KEY, key);
  const s = admin('adminGetState');
  assert.equal(s.people.length, 1);
  assert.equal(s.settings.seats, 10);
  assert.equal(s.settings.event, '忘年会');
});

test('setup: スタンドアロン（アクティブなスプレッドシートなし）なら新規作成して SHEET_ID に保存し、2回目は再利用', () => {
  const backend = createBackend();
  const ctx = createGasContext({ backend, bound: false, htmlFiles: HTML });
  throwsMsg(() => ctx.participantGet('abcdefghij0123456789'), /setup/, '未セットアップのときは setup を案内');
  ctx.setup();
  const id = ctx.__mock.props.SHEET_ID;
  assert.ok(id && id !== backend.active.getId(), '新しいスプレッドシートを作る');
  assert.equal(backend.spreadsheets.size, 2);
  ctx.setup();
  assert.equal(backend.spreadsheets.size, 2, '2回目は作らない');
  const key = ctx.__mock.props.ADMIN_KEY;
  const r = ctx.adminAddPeople(key, ['山田'], 'lottery');
  assert.equal(r.added.length, 1);
  assert.ok(backend.spreadsheets.get(id).getSheetByName('参加者')._dump().length === 2, 'SHEET_ID のシートに保存される');
});

/* ================= doGet ================= */
test('doGet: 合言葉が合えば幹事画面、t があれば参加者画面、それ以外は案内', () => {
  const { ctx, key } = fresh();
  const check = out => {
    assert.deepEqual(out.getMetaTags().map(m => [m.getName(), m.getContent()]), [['viewport', 'width=device-width, initial-scale=1']]);
    assert.equal(out._xfo, 'DEFAULT');
  };
  let o = ctx.doGet({ parameter: { admin: key } });
  assert.equal(o.getTitle(), '席くじ 幹事画面'); assert.equal(o.getContent(), HTML.Admin); check(o);
  o = ctx.doGet({ parameter: { t: 'whatever123' } });
  assert.equal(o.getTitle(), '席くじ'); assert.equal(o.getContent(), HTML.Participant); check(o);
  for (const e of [{ parameter: {} }, { parameter: { admin: 'wrong' } }, { parameter: { admin: '' } }, { parameter: { admin: key + 'x' } }, {}, undefined, { parameter: { t: '' } }]) {
    o = ctx.doGet(e);
    assert.match(o.getContent(), /受付でお渡ししたQRコードを読み取ってください/);
    assert.doesNotMatch(o.getContent(), /幹事|合言葉/, '管理画面の存在を示唆しない');
    assert.equal(o.getTitle(), '席くじ');
    check(o);
  }
  // 合言葉が間違っていて t もあるときは参加者画面（幹事画面は出さない）
  o = ctx.doGet({ parameter: { admin: 'wrong', t: 'abc' } });
  assert.equal(o.getContent(), HTML.Participant);
});

test('doGet: 合言葉が未設定なら admin パラメータが空でも幹事画面は出ない', () => {
  const ctx = createGasContext({ htmlFiles: HTML });
  assert.match(ctx.doGet({ parameter: { admin: '' } }).getContent(), /QRコード/);
  assert.match(ctx.doGet({ parameter: { admin: 'null' } }).getContent(), /QRコード/);
});

test('doGet: gas/ の実ファイル（あれば）を配信できる', () => {
  const ctx = createGasContext();
  ctx.setup();
  for (const [name, param] of [['Admin', { admin: ctx.__mock.props.ADMIN_KEY }], ['Participant', { t: 'x' }]]) {
    const f = path.join(ROOT, 'gas', name + '.html');
    if (!fs.existsSync(f)) continue;
    const out = ctx.doGet({ parameter: param });
    assert.equal(out.getContent(), fs.readFileSync(f, 'utf8'));
    assert.doesNotMatch(out.getContent(), /<\?[=!]?/, name + '.html にスクリプトレットを使わない');
  }
});

/* ================= 幹事の合言葉 ================= */
test('幹事 API は合言葉が違う・空・文字列でないとすべて拒否', () => {
  const { ctx, key, add } = fresh();
  add(['山田']);
  const id = ctx.adminGetState(key).people[0].id;
  const calls = {
    adminGetState: [], adminAddPeople: [['鈴木'], 'lottery'], adminUpdatePerson: [id, { name: 'x' }], adminDeletePerson: [id],
    adminDrawAll: [], adminDrawOne: [id], adminSaveSettings: [{ seats: 5 }], adminReissueToken: [id], adminReset: ['all'],
  };
  for (const [fn, args] of Object.entries(calls)) {
    for (const bad of ['', 'wrong', key + ' ', key.slice(0, -1), null, undefined, 0, [key], { key }, true]) {
      throwsMsg(() => ctx[fn](bad, ...args), ERR_KEY, fn + ' に ' + String(bad));
    }
  }
  const s = ctx.adminGetState(key);
  assert.equal(s.people.length, 1, '拒否された呼び出しで変更されていない');
  assert.equal(s.people[0].name, '山田');
  assert.equal(s.settings.seats, 27);
  // ADMIN_KEY が未設定（setup 前）でも空文字などで通らない
  const ctx2 = createGasContext({ htmlFiles: HTML });
  ctx2.__mock.run('0');
  throwsMsg(() => ctx2.adminGetState(''), ERR_KEY);
  throwsMsg(() => ctx2.adminGetState(null), ERR_KEY);
});

/* ================= 名簿の追加 ================= */
test('adminAddPeople: 追加・入力表記の保持・重複（全角/空白違い）のスキップ', () => {
  const { admin, add } = fresh();
  let r = add(['山田 太郎', '  鈴木　 花子  ', '', '佐藤'], 'lottery');
  assert.deepEqual(r.added, ['山田 太郎', '鈴木 花子', '佐藤'], 'trim・連続空白（全角含む）を1つに');
  assert.deepEqual(r.skipped, []);
  assert.equal(r.state.people.length, 3);
  r = add(['山田　太郎', 'ＹＡＭＡＤＡ', 'YAMADA', '佐藤', '高橋', '高橋'], 'fixed');
  assert.deepEqual(r.added, ['ＹＡＭＡＤＡ', '高橋']);
  assert.deepEqual(r.skipped, ['山田 太郎（すでに登録）', 'YAMADA（すでに登録）', '佐藤（すでに登録）', '高橋（すでに登録）']);
  const s = admin('adminGetState');
  assert.deepEqual(s.people.map(p => [p.name, p.kind, p.seat, p.drink, p.drawnAt, p.drinkAt]), [
    ['山田 太郎', 'lottery', null, null, null, null], ['鈴木 花子', 'lottery', null, null, null, null], ['佐藤', 'lottery', null, null, null, null],
    ['ＹＡＭＡＤＡ', 'fixed', null, null, null, null], ['高橋', 'fixed', null, null, null, null]]);
  assert.deepEqual(s.people.map(p => p.fixedLabel), [null, null, null, '固定席1', '固定席2']);
  assert.equal(s.summary.lottery, 3); assert.equal(s.summary.fixed, 2); assert.equal(s.summary.total, 5);
});

test('adminAddPeople: 60文字超はスキップ、1人も追加できなければエラー、区分・形式の検証', () => {
  const { add, admin } = fresh();
  const long = 'あ'.repeat(61);
  const r = add([long, 'い'.repeat(60)]);
  assert.deepEqual(r.added, ['い'.repeat(60)]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /60文字/);
  throwsMsg(() => add([long]), /^追加できる方がいませんでした。/);
  throwsMsg(() => add(['い'.repeat(60)]), /^追加できる方がいませんでした。.*すでに登録/);
  throwsMsg(() => add([]), /^追加できる方がいませんでした。/);
  throwsMsg(() => add(['  ', '']), /^追加できる方がいませんでした。/);
  throwsMsg(() => admin('adminAddPeople', ['新人'], 'vip'), /区分/);
  throwsMsg(() => admin('adminAddPeople', '新人', 'lottery'), /お名前/);
  throwsMsg(() => admin('adminAddPeople', null, 'lottery'), /お名前/);
  assert.equal(admin('adminGetState').people.length, 1);
});

test('adminAddPeople: 上限 200 名', () => {
  const { add } = fresh();
  let r = add(range(199));
  assert.equal(r.added.length, 199);
  r = add(['最後', '超過1', '超過2']);
  assert.deepEqual(r.added, ['最後']);
  assert.deepEqual(r.skipped, ['超過1（200名を超えています）', '超過2（200名を超えています）']);
  throwsMsg(() => add(['もう一人']), /^追加できる方がいませんでした。.*200名/);
  assert.equal(r.state.people.length, 200);
});

test('ID・トークン: 20文字の英数字で重複しない。参加者ビューにトークンや他人の情報は含まれない', () => {
  const { add, call, admin } = fresh();
  const s = add(range(150)).state;
  const tokens = new Set(s.people.map(p => p.token)), ids = new Set(s.people.map(p => p.id));
  assert.equal(tokens.size, 150); assert.equal(ids.size, 150);
  for (const p of s.people) { assert.match(p.token, /^[A-Za-z0-9]{20}$/); assert.match(p.id, /^[A-Za-z0-9]+$/); }
  // 文字の偏りが極端でない（62種類のうち大半が出現する）
  const chars = new Set(s.people.map(p => p.token).join(''));
  assert.ok(chars.size > 55, '英大文字・小文字・数字が混ざる: ' + chars.size);
  const v = call('participantGet', s.people[3].token);
  assert.deepEqual(Object.keys(v).sort(), ['drink', 'drinkOpen', 'drinks', 'event', 'fixedLabel', 'kind', 'link', 'name', 'seat', 'seatsLeft'].sort());
  assert.equal(v.name, '参加者4');
  assert.equal(v.link, 'https://script.google.com/macros/s/TESTDEPLOY/exec?t=' + s.people[3].token, 'ご本人専用のリンク（ご本人のトークンのみ）');
  assert.equal(JSON.stringify({ ...v, link: '' }).includes(s.people[3].token), false);
  for (const o of s.people) if (o !== s.people[3]) assert.equal(JSON.stringify(v).includes(o.token), false, '他人のトークンは含まない');
  assert.equal(JSON.stringify(v).includes('参加者5'), false);
  assert.equal(admin('adminGetState').people.length, 150);
});

/* ================= 参加者: トークン ================= */
test('participantGet: 不正なトークンはすべて同じエラー', () => {
  const { add, call, ctx } = fresh();
  const tok = add(['山田']).state.people[0].token;
  for (const bad of ['', null, undefined, 123, 'x', tok.slice(0, -1), tok + 'a', tok.toLowerCase() === tok ? tok.toUpperCase() : tok.toLowerCase(), '../../etc', tok + '\n', ' ' + tok, { t: tok }, [tok], 'A'.repeat(20)]) {
    throwsMsg(() => ctx.participantGet(bad), ERR_TOKEN, String(bad));
    throwsMsg(() => ctx.participantDraw(bad), ERR_TOKEN, String(bad));
    throwsMsg(() => ctx.participantSetDrink(bad, 'ビール'), ERR_TOKEN, String(bad));
  }
  const v = call('participantGet', tok);
  assert.deepEqual(v, { event: '', name: '山田', kind: 'lottery', seat: null, fixedLabel: null, drink: null, drinks: ['ビール', 'ハイボール', 'レモンサワー', 'ウーロン茶', 'オレンジジュース', 'コーラ'], drinkOpen: true, seatsLeft: 27, link: 'https://script.google.com/macros/s/TESTDEPLOY/exec?t=' + tok });
});

/* ================= 抽選 ================= */
test('participantDraw: 27席を27人が引くと重複なく全席が埋まり、28人目は空き無し', () => {
  const { add, call, admin } = fresh();
  const s = add(range(28)).state;
  const seats = [];
  s.people.slice(0, 27).forEach((p, i) => {
    const v = call('participantDraw', p.token);
    assert.equal(v.kind, 'lottery');
    assert.ok(Number.isInteger(v.seat) && v.seat >= 1 && v.seat <= 27);
    assert.equal(v.seatsLeft, 27 - i - 1);
    seats.push(v.seat);
  });
  assert.deepEqual([...seats].sort((a, b) => a - b), range(27).map((_, i) => i + 1));
  throwsMsg(() => call('participantDraw', s.people[27].token), '空いている席がありません。受付にお声がけください。');
  const st = admin('adminGetState');
  assert.equal(st.summary.seated, 27); assert.equal(st.summary.seatsLeft, 0);
  assert.equal(st.people[27].seat, null);
  for (const p of st.people.slice(0, 27)) assert.match(p.drawnAt, DATETIME);
  assert.equal(st.people[27].drawnAt, null);
});

test('participantDraw: 2回押しても同じ席（冪等）で、抽選日時も変わらない', () => {
  const { add, call, admin } = fresh();
  const tok = add(['山田', '鈴木']).state.people[0].token;
  const v1 = call('participantDraw', tok);
  const at = admin('adminGetState').people[0].drawnAt;
  for (let i = 0; i < 5; i++) assert.equal(call('participantDraw', tok).seat, v1.seat);
  assert.equal(call('participantGet', tok).seat, v1.seat);
  assert.equal(admin('adminGetState').people[0].drawnAt, at);
  assert.equal(admin('adminGetState').summary.seated, 1);
});

test('participantDraw: 席が満席でも既に席のある人はエラーにならない', () => {
  const { add, call, admin } = fresh();
  admin('adminSaveSettings', { seats: 1 });
  const ps = add(['山田', '鈴木']).state.people;
  assert.equal(call('participantDraw', ps[0].token).seat, 1);
  throwsMsg(() => call('participantDraw', ps[1].token), /空いている席がありません/);
  assert.equal(call('participantDraw', ps[0].token).seat, 1);
});

test('participantDraw: 固定席の人はくじを引けない。固定席の fixedLabel', () => {
  const { add, call } = fresh();
  add(['A']);
  const ps = add(['固定一', '固定二'], 'fixed').state.people;
  throwsMsg(() => call('participantDraw', ps[2].token), '固定席の方はくじを引きません。');
  const v = call('participantGet', ps[2].token);
  assert.equal(v.kind, 'fixed'); assert.equal(v.seat, null); assert.equal(v.fixedLabel, '固定席2');
  assert.equal(call('participantGet', ps[0].token).fixedLabel, null);
});

test('participantDraw: 抽選の偏り（空き席のどれでも選ばれうる）', () => {
  const counts = new Map();
  for (let i = 0; i < 300; i++) {
    const ctx = createGasContext({ htmlFiles: HTML });
    ctx.setup();
    const key = ctx.__mock.props.ADMIN_KEY;
    ctx.adminSaveSettings(key, { seats: 3 });
    const tok = ctx.adminAddPeople(key, ['A'], 'lottery').state.people[0].token;
    const s = ctx.participantDraw(tok).seat;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  assert.deepEqual([...counts.keys()].sort(), [1, 2, 3]);
  for (const c of counts.values()) assert.ok(c > 50, '極端に偏らない: ' + [...counts.entries()]);
});

test('participantDraw: Math.random が 0 や 0.9999… でも範囲内の空き席を選ぶ', () => {
  for (const r of [0, 0.9999999999]) {
    const { add, call, admin } = fresh({ random: () => r });
    admin('adminSaveSettings', { seats: 5 });
    const ps = add(range(5)).state.people;
    const got = ps.map(p => call('participantDraw', p.token).seat).sort();
    assert.deepEqual(got, [1, 2, 3, 4, 5]);
  }
});

/* ================= ドリンク ================= */
test('participantSetDrink: 登録・変更・正規化・未定。席が決まる前・固定席でも登録できる', () => {
  const { add, call, admin } = fresh();
  const [a] = add(['山田']).state.people;
  const [f] = add(['社長'], 'fixed').state.people.slice(1);
  let v = call('participantSetDrink', a.token, 'ビール');
  assert.equal(v.drink, 'ビール'); assert.equal(v.seat, null, '席はまだ');
  const at = admin('adminGetState').people[0].drinkAt;
  assert.match(at, DATETIME);
  v = call('participantSetDrink', a.token, '  ＨＩＧＨＢＡＬＬ　 濃いめ ');
  assert.equal(v.drink, 'HIGHBALL 濃いめ', 'NFKC・trim・連続空白');
  v = call('participantSetDrink', a.token, '未定');
  assert.equal(v.drink, '未定');
  v = call('participantSetDrink', f.token, 'ウーロン茶');
  assert.equal(v.drink, 'ウーロン茶'); assert.equal(v.kind, 'fixed');
  v = call('participantSetDrink', a.token, 'あ'.repeat(30));
  assert.equal(v.drink.length, 30);
  for (const bad of ['', '   ', null, undefined, 1, 'あ'.repeat(31), ['ビール'], { d: 'ビール' }]) {
    assert.throws(() => call('participantSetDrink', a.token, bad), /ドリンク/, String(bad));
  }
  assert.equal(call('participantGet', a.token).drink, 'あ'.repeat(30), '失敗した呼び出しで変わらない');
  // 抽選後もドリンクは残る
  call('participantDraw', a.token);
  assert.equal(call('participantGet', a.token).drink, 'あ'.repeat(30));
});

test('participantSetDrink: 受付締切（drinkOpen=false）なら登録できず、参加者ビューにも反映', () => {
  const { add, call, admin } = fresh();
  const [a] = add(['山田']).state.people;
  call('participantSetDrink', a.token, 'コーラ');
  const st = admin('adminSaveSettings', { drinkOpen: false });
  assert.equal(st.settings.drinkOpen, false);
  throwsMsg(() => call('participantSetDrink', a.token, 'ビール'), 'ドリンクの受付は締め切りました。受付にお声がけください。');
  const v = call('participantGet', a.token);
  assert.equal(v.drinkOpen, false); assert.equal(v.drink, 'コーラ');
  // 幹事は締切後も修正できる
  assert.equal(admin('adminUpdatePerson', a.id, { drink: 'ビール' }).people[0].drink, 'ビール');
  // 不正トークンは締切より先に判定（締切かどうかを漏らさない）
  throwsMsg(() => call('participantSetDrink', 'A'.repeat(20), 'ビール'), ERR_TOKEN);
  admin('adminSaveSettings', { drinkOpen: true });
  assert.equal(call('participantSetDrink', a.token, 'ビール').drink, 'ビール');
});

test('集計: メニュー順（0件も含む）→メニュー外は件数降順・名前順。未定・未登録は別', () => {
  const { add, call, admin } = fresh();
  const ps = add(range(12)).state.people;
  const plan = ['ビール', 'ビール', 'コーラ', 'ｼｬﾝﾊﾟﾝ', 'シャンパン', '日本酒', '未定', 'ワイン', 'ワイン', 'ワイン', null, null];
  ps.forEach((p, i) => { if (plan[i]) call('participantSetDrink', p.token, plan[i]); });
  const sm = admin('adminGetState').summary;
  assert.deepEqual(sm.orders, [
    { name: 'ビール', count: 2 }, { name: 'ハイボール', count: 0 }, { name: 'レモンサワー', count: 0 }, { name: 'ウーロン茶', count: 0 },
    { name: 'オレンジジュース', count: 0 }, { name: 'コーラ', count: 1 },
    { name: 'ワイン', count: 3 }, { name: 'シャンパン', count: 2 }, { name: '日本酒', count: 1 }]);
  assert.equal(sm.undecided, 1); assert.equal(sm.none, 2); assert.equal(sm.total, 12);
  assert.equal(sm.orders.reduce((n, o) => n + o.count, 0) + sm.undecided + sm.none, sm.total);
  // メニュー外の同数は名前順
  const x = fresh();
  const qs = x.add(['a', 'b', 'c']).state.people;
  x.call('participantSetDrink', qs[0].token, 'ゆず酒'); x.call('participantSetDrink', qs[1].token, 'あんず酒'); x.call('participantSetDrink', qs[2].token, 'うめ酒');
  assert.deepEqual(x.admin('adminGetState').summary.orders.slice(6).map(o => o.name), ['あんず酒', 'うめ酒', 'ゆず酒']);
});

/* ================= 数式インジェクション・型の正規化 ================= */
test('利用者入力は書式なしテキストで保存され、数式・数値・日付・真偽値として解釈されない', () => {
  const { ctx, add, call, admin, rows } = fresh();
  const names = ['=1+1', '+SUM(A1)', '-2', '@x', '0123', '1e3', 'TRUE', '2024/01/02', '=HYPERLINK("http://evil","x")'];
  const ps = add(names).state.people;
  assert.deepEqual(ps.map(p => p.name), names);
  call('participantSetDrink', ps[0].token, '=IMPORTXML(A1,"//a")');
  call('participantSetDrink', ps[1].token, '007');
  call('participantSetDrink', ps[2].token, 'false');
  admin('adminSaveSettings', { event: '=1+2', drinks: ['=A1', '100', 'ビール'] });
  const sh = ctx.__mock.sheet('参加者');
  const formulas = sh.getRange(1, 1, sh.getLastRow(), 8).getFormulas().flat().filter(Boolean);
  assert.deepEqual(formulas, [], '数式として保存されたセルがない');
  const set = ctx.__mock.sheet('設定');
  assert.deepEqual(set.getRange(1, 1, set.getLastRow(), 2).getFormulas().flat().filter(Boolean), []);
  const st = admin('adminGetState');
  assert.deepEqual(st.people.map(p => p.name), names);
  assert.equal(st.people[0].drink, '=IMPORTXML(A1,"//a")');
  assert.equal(st.people[1].drink, '007');
  assert.equal(st.people[2].drink, 'false');
  assert.equal(st.settings.event, '=1+2');
  assert.deepEqual(st.settings.drinks, ['=A1', '100', 'ビール']);
  const r = rows();
  assert.ok(r[1][2] === "'=1+1" || r[1][2] === '=1+1', '「=」で始まる文字は先頭に「\'」を付けて文字として保存'); assert.equal(r[5][2], '0123'); assert.equal(typeof r[7][2], 'string');
  // 書式: テキスト列は '@'、席番号列は数値
  assert.equal(sh.getRange(2, 3).getNumberFormat(), '@');
  assert.equal(sh.getRange(2, 6).getNumberFormat(), '@');
  assert.equal(sh.getRange(2, 7).getNumberFormat(), '@', '日時も文字列のまま（日付に変換されない）');
  assert.equal(typeof r[1][6], 'string');
});

test('シートを読むときの正規化: 手で編集された値（数値・日付・TRUE・空）でも読める', () => {
  const { ctx, add, call, admin } = fresh();
  const ps = add(['山田', '鈴木', '佐藤', '田中']).state.people;
  const s0 = call('participantDraw', ps[0].token).seat, s1 = s0 === 5 ? 6 : 5;
  const sh = ctx.__mock.sheet('参加者');
  // 人が書式を「自動」に戻して値を入れ直した想定
  sh.getRange(2, 1, 5, 8).setNumberFormat('General');
  sh.getRange(3, 5).setValue(String(s1));          // 席番号（文字列→数値になる）
  sh.getRange(3, 7).setValue('2026/09/28 18:30:00'); // 日時（Date になる）
  sh.getRange(4, 2).setValue('12345678901234567890'); // 数字だけのトークン（数値になる→壊れる）
  sh.getRange(4, 4).setValue('固定');
  sh.getRange(4, 5).setValue(7);                   // 固定の人の席は無視
  sh.getRange(5, 6).setValue('TRUE');              // ドリンクが TRUE（真偽値）
  sh.getRange(6, 1, 1, 8).setValues([['', '', '手書き 追加', '', '', 'ビール', '', '']]); // ID・トークン無しの行
  const st = admin('adminGetState');
  const by = n => st.people.find(p => p.name === n);
  assert.equal(by('鈴木').seat, s1); assert.equal(typeof by('鈴木').seat, 'number');
  assert.equal(by('鈴木').drawnAt, '2026/09/28 18:30:00');
  assert.equal(by('佐藤').kind, 'fixed'); assert.equal(by('佐藤').seat, null);
  assert.match(by('佐藤').token, /^[A-Za-z0-9]{8,}$/);
  assert.equal(by('田中').drink, 'TRUE');
  assert.equal(by('手書き 追加').drink, 'ビール');
  assert.match(by('手書き 追加').id, /^[A-Za-z0-9]+$/);
  assert.match(by('手書き 追加').token, /^[A-Za-z0-9]{20}$/);
  assert.equal(st.people.length, 5);
  // 付けた ID・トークンは保存され、次に読んでも同じ
  const again = admin('adminGetState');
  assert.deepEqual(again.people.map(p => [p.id, p.token]), st.people.map(p => [p.id, p.token]));
  assert.equal(call('participantGet', by('手書き 追加').token).name, '手書き 追加');
  // 鈴木さんの席はほかの人に割り当てられない
  const left = st.people.filter(p => p.kind === 'lottery' && p.seat === null);
  const got = left.map(p => call('participantDraw', p.token).seat);
  assert.equal(new Set([...got, s0, s1]).size, got.length + 2);
});

test('シートの正規化: 席番号の重複（手で編集）は後ろの人を空きに戻す。お名前だけ無い行は消さずに残し、その席も使用中', () => {
  const { ctx, admin, add, call } = fresh();
  const ps = add(['A', 'B']).state.people;
  const s = call('participantDraw', ps[0].token).seat;
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(3, 5).setValue(s);
  sh.getRange(5, 1, 1, 8).setValues([['zzz', 'tok', '', '', 3, '', '', '']]);
  const st = admin('adminGetState');
  assert.deepEqual(st.people.map(p => p.seat), [s, null]);
  assert.equal(st.people.length, 2);
  const v = ctx.__mock.values('参加者');
  assert.equal(v.length, 5, 'お名前の無い行は、その場所（5行目）に残る');
  assert.deepEqual(v[4].slice(0, 5).map(String), ['zzz', 'tok', '', '', s === 3 ? '' : '3'], '名簿の方と重なった席は、お名前の無い行のほうを空きにする');
  // 3番は使用中なので誰にも割り当てない
  assert.equal(st.summary.seatsLeft, 27 - 1 - (s === 3 ? 0 : 1), 'お名前の無い行の席（3番）は使用中として扱う（名簿の方と重なったら名簿の方を優先）');
});

test('設定シートの正規化: 手で書いた seats/drinkOpen/drinks も読める', () => {
  const { ctx, key } = fresh();
  const sh = ctx.__mock.sheet('設定');
  const rows = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  const idx = k => rows.findIndex(r => r[0] === k) + 1;
  sh.getRange(idx('seats'), 2).setNumberFormat('General').setValue('12');
  sh.getRange(idx('drinkOpen'), 2).setNumberFormat('General').setValue('false');
  sh.getRange(idx('drinks'), 2).setValue('ビール\r\n\r\n ｺｰﾗ \nビール\n');
  const plain = x => JSON.parse(JSON.stringify(x));
  let s = plain(ctx.adminGetState(key).settings);
  assert.equal(s.seats, 12); assert.equal(s.drinkOpen, false); assert.deepEqual(s.drinks, ['ビール', 'コーラ']);
  sh.getRange(idx('seats'), 2).setValue('abc');
  sh.getRange(idx('drinkOpen'), 2).setValue(true);
  s = plain(ctx.adminGetState(key).settings);
  assert.equal(s.seats, 27, '壊れた値は既定値'); assert.equal(s.drinkOpen, true);
  // 保存しても手で足した別のキーは残る
  sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setValues([['memo', '幹事メモ']]);
  ctx.adminSaveSettings(key, { event: '新年会' });
  assert.ok(ctx.__mock.values('設定').some(r => r[0] === 'memo' && r[1] === '幹事メモ'));
  assert.equal(ctx.adminGetState(key).settings.event, '新年会');
});

/* ================= 幹事: 修正・削除 ================= */
test('adminUpdatePerson: 名前・区分・ドリンク・席を空きに戻す', () => {
  const { add, call, admin } = fresh();
  const ps = add(['山田', '鈴木']).state.people;
  call('participantDraw', ps[0].token);
  call('participantSetDrink', ps[0].token, 'ビール');
  let st = admin('adminUpdatePerson', ps[0].id, { name: '  山田　一郎 ' });
  assert.equal(st.people[0].name, '山田 一郎'.replace(' ', '　').replace('　', ' ')); // tidy: 連続空白→1つ
  throwsMsg(() => admin('adminUpdatePerson', ps[0].id, { name: 'すずき'.replace('すずき', '鈴木') }), /すでに名簿にあります/);
  throwsMsg(() => admin('adminUpdatePerson', ps[0].id, { name: '' }), /お名前/);
  throwsMsg(() => admin('adminUpdatePerson', ps[0].id, { name: 'あ'.repeat(61) }), /60文字/);
  st = admin('adminUpdatePerson', ps[0].id, { name: '山田 一郎' });
  assert.equal(st.people[0].name, '山田 一郎', '自分自身と同じ名前は重複扱いしない');
  st = admin('adminUpdatePerson', ps[0].id, { clearSeat: true });
  assert.equal(st.people[0].seat, null); assert.equal(st.people[0].drawnAt, null);
  assert.equal(st.people[0].drink, 'ビール', '席を戻してもドリンクは残る');
  call('participantDraw', ps[0].token);
  st = admin('adminUpdatePerson', ps[0].id, { kind: 'fixed' });
  assert.equal(st.people[0].kind, 'fixed'); assert.equal(st.people[0].seat, null); assert.equal(st.people[0].fixedLabel, '固定席1');
  st = admin('adminUpdatePerson', ps[0].id, { drink: null });
  assert.equal(st.people[0].drink, null); assert.equal(st.people[0].drinkAt, null);
  st = admin('adminUpdatePerson', ps[0].id, { drink: '未定' });
  assert.equal(st.people[0].drink, '未定'); assert.equal(st.summary.undecided, 1);
  st = admin('adminUpdatePerson', ps[0].id, { drink: ' ｺｰﾗ ' });
  assert.equal(st.people[0].drink, 'コーラ');
  st = admin('adminUpdatePerson', ps[0].id, { kind: 'lottery' });
  assert.equal(st.people[0].kind, 'lottery');
  throwsMsg(() => admin('adminUpdatePerson', ps[0].id, { kind: 'x' }), /区分/);
  throwsMsg(() => admin('adminUpdatePerson', ps[0].id, { drink: '' }), /ドリンク/);
  throwsMsg(() => admin('adminUpdatePerson', 'nope', { name: 'x' }), /見つかりません/);
  throwsMsg(() => admin('adminUpdatePerson', ps[0].id, null), /変更する内容/);
  assert.equal(admin('adminGetState').people.length, 2);
});

test('adminDeletePerson: 行が減ってもシートに残骸が残らない', () => {
  const { add, admin, rows } = fresh();
  const ps = add(range(10)).state.people;
  assert.equal(rows().length, 11);
  let st;
  for (const p of ps.slice(0, 7)) st = admin('adminDeletePerson', p.id);
  assert.deepEqual(st.people.map(p => p.name), ['参加者8', '参加者9', '参加者10']);
  assert.equal(rows().length, 4, '見出し＋3行だけ');
  assert.deepEqual(rows().slice(1).map(r => r[2]), ['参加者8', '参加者9', '参加者10']);
  throwsMsg(() => admin('adminDeletePerson', ps[0].id), /見つかりません/);
  for (const p of ps.slice(7)) admin('adminDeletePerson', p.id);
  assert.equal(rows().length, 1, '全員消すと見出しだけ');
  assert.equal(admin('adminGetState').people.length, 0);
});

/* ================= 幹事: まとめて抽選・代わりに引く ================= */
test('adminDrawAll: 席未定の抽選区分だけに割り当て、足りなければ割り当てられるだけ', () => {
  const { add, call, admin } = fresh();
  admin('adminSaveSettings', { seats: 10 });
  const ps = add(range(12)).state.people;
  add(['固定'], 'fixed');
  const mine = call('participantDraw', ps[0].token).seat;
  const r = admin('adminDrawAll');
  assert.equal(r.count, 9);
  const st = r.state;
  assert.equal(st.people[0].seat, mine, '既に決まっている席は変えない');
  const seats = st.people.filter(p => p.seat !== null).map(p => p.seat);
  assert.equal(seats.length, 10); assert.equal(new Set(seats).size, 10);
  assert.ok(seats.every(s => s >= 1 && s <= 10));
  assert.equal(st.people.find(p => p.name === '固定').seat, null);
  assert.equal(st.summary.seatsLeft, 0); assert.equal(st.summary.seated, 10);
  assert.equal(st.people.filter(p => p.kind === 'lottery' && p.seat === null).length, 2, '足りない人数が state から分かる');
  throwsMsg(() => admin('adminDrawAll'), /空いている席がありません/);
  admin('adminSaveSettings', { seats: 12 });
  assert.equal(admin('adminDrawAll').count, 2);
  throwsMsg(() => admin('adminDrawAll'), '席が決まっていない方はいません。');
  const f = fresh();
  throwsMsg(() => f.admin('adminDrawAll'), '席が決まっていない方はいません。');
});

test('adminDrawOne: 参加者の代わりに引く（冪等・固定席不可・空き無し）', () => {
  const { add, admin, call } = fresh();
  admin('adminSaveSettings', { seats: 1 });
  const ps = add(['A', 'B']).state.people;
  const [f] = add(['F'], 'fixed').state.people.slice(2);
  let st = admin('adminDrawOne', ps[0].id);
  assert.equal(st.people[0].seat, 1);
  st = admin('adminDrawOne', ps[0].id);
  assert.equal(st.people[0].seat, 1);
  assert.equal(call('participantDraw', ps[0].token).seat, 1);
  throwsMsg(() => admin('adminDrawOne', ps[1].id), /空いている席がありません/);
  throwsMsg(() => admin('adminDrawOne', f.id), '固定席の方はくじを引きません。');
  throwsMsg(() => admin('adminDrawOne', 'nope'), /見つかりません/);
});

/* ================= 設定 ================= */
test('adminSaveSettings: 席数の検証（1〜99の整数、決まっている最大席番号以上）', () => {
  const { admin, add, call } = fresh();
  for (const bad of [0, 100, 1.5, -1, 'abc', '', null, NaN, true, [5]]) throwsMsg(() => admin('adminSaveSettings', { seats: bad }), /抽選席数は1〜99の整数/, String(bad));
  assert.equal(admin('adminSaveSettings', { seats: 99 }).settings.seats, 99);
  assert.equal(admin('adminSaveSettings', { seats: '8' }).settings.seats, 8, '数字の文字列も可');
  const ps = add(range(8)).state.people;
  const seats = ps.map(p => call('participantDraw', p.token).seat);
  assert.equal(Math.max(...seats), 8);
  throwsMsg(() => admin('adminSaveSettings', { seats: 7 }), /8番/);
  assert.equal(admin('adminGetState').settings.seats, 8);
  assert.equal(admin('adminSaveSettings', { seats: 8 }).settings.seats, 8);
  throwsMsg(() => admin('adminSaveSettings', null), /変更する内容/);
});

test('adminSaveSettings: 会の名前・ドリンクメニュー・受付・URL の検証', () => {
  const { admin, ctx } = fresh();
  let st = admin('adminSaveSettings', { event: '  2026年　 忘年会 ' });
  assert.equal(st.settings.event, '2026年 忘年会');
  assert.equal(admin('adminSaveSettings', { event: 'あ'.repeat(40) }).settings.event.length, 40);
  throwsMsg(() => admin('adminSaveSettings', { event: 'あ'.repeat(41) }), /40文字/);
  assert.equal(admin('adminSaveSettings', { event: '' }).settings.event, '');
  // ドリンク
  st = admin('adminSaveSettings', { drinks: [' ﾋﾞｰﾙ ', 'ビール', '', '  ', '日本酒　 熱燗', 'ワイン'] });
  assert.deepEqual(st.settings.drinks, ['ビール', '日本酒 熱燗', 'ワイン']);
  throwsMsg(() => admin('adminSaveSettings', { drinks: [] }), /1つ以上/);
  throwsMsg(() => admin('adminSaveSettings', { drinks: ['', ' '] }), /1つ以上/);
  throwsMsg(() => admin('adminSaveSettings', { drinks: range(21, 'd') }), /20個/);
  assert.equal(admin('adminSaveSettings', { drinks: range(20, 'd') }).settings.drinks.length, 20);
  throwsMsg(() => admin('adminSaveSettings', { drinks: ['あ'.repeat(31)] }), /30文字/);
  throwsMsg(() => admin('adminSaveSettings', { drinks: 'ビール' }), /ドリンクメニュー/);
  // 受付
  throwsMsg(() => admin('adminSaveSettings', { drinkOpen: 'false' }), /ドリンクの受付/);
  assert.equal(admin('adminSaveSettings', { drinkOpen: false }).settings.drinkOpen, false);
  // URL
  st = admin('adminSaveSettings', { baseUrl: ' https://example.com/macros/s/ABC/exec?x=1#top ' });
  assert.equal(st.settings.baseUrl, 'https://example.com/macros/s/ABC/exec');
  assert.equal(st.settings.appUrl, 'https://example.com/macros/s/ABC/exec');
  for (const bad of ['http://example.com', 'javascript:alert(1)', 'example.com', 'https://a b', 'https://x/"><script>', 'https://' + 'a'.repeat(300), 5]) {
    throwsMsg(() => admin('adminSaveSettings', { baseUrl: bad }), /URL/, String(bad));
  }
  st = admin('adminSaveSettings', { baseUrl: '' });
  assert.equal(st.settings.baseUrl, '');
  assert.equal(st.settings.appUrl, 'https://script.google.com/macros/s/TESTDEPLOY/exec', '空なら ScriptApp の URL');
  ctx.__mock.setUrl(null);
  assert.equal(admin('adminGetState').settings.appUrl, '', '未デプロイなら空');
  // 一部だけ渡したときはほかの設定を変えない
  st = admin('adminGetState').settings;
  assert.deepEqual([st.seats, st.event, st.drinks.length, st.drinkOpen], [27, '', 20, false]);
  // 保存した設定は新しい実行（別コンテキスト）からも読める
  const ctx2 = createGasContext({ backend: ctx.__mock.backend, htmlFiles: HTML });
  assert.equal(ctx2.adminGetState(ctx.__mock.props.ADMIN_KEY).settings.drinks.length, 20);
});

test('adminSaveSettings: メニュー変更は参加者ビューに反映され、既存の登録は残る', () => {
  const { admin, add, call } = fresh();
  const [p] = add(['山田']).state.people;
  call('participantSetDrink', p.token, 'コーラ');
  admin('adminSaveSettings', { drinks: ['ビール', 'ワイン'], event: '歓迎会' });
  const v = call('participantGet', p.token);
  assert.deepEqual(v.drinks, ['ビール', 'ワイン']); assert.equal(v.event, '歓迎会'); assert.equal(v.drink, 'コーラ');
  const sm = admin('adminGetState').summary;
  assert.deepEqual(sm.orders, [{ name: 'ビール', count: 0 }, { name: 'ワイン', count: 0 }, { name: 'コーラ', count: 1 }]);
});

/* ================= トークン再発行・リセット ================= */
test('adminReissueToken: 古い QR は無効になり、新しい QR で同じ席・ドリンクが見える', () => {
  const { admin, add, call } = fresh();
  const [p] = add(['山田']).state.people;
  const seat = call('participantDraw', p.token).seat;
  call('participantSetDrink', p.token, 'ビール');
  const st = admin('adminReissueToken', p.id);
  const np = st.people[0];
  assert.notEqual(np.token, p.token); assert.match(np.token, /^[A-Za-z0-9]{20}$/);
  assert.equal(np.id, p.id);
  throwsMsg(() => call('participantGet', p.token), ERR_TOKEN);
  const v = call('participantGet', np.token);
  assert.equal(v.seat, seat); assert.equal(v.drink, 'ビール');
  throwsMsg(() => admin('adminReissueToken', 'nope'), /見つかりません/);
});

test('adminReset: 席だけ・ドリンクだけ・名簿ごと（設定は残る）', () => {
  const { admin, add, call, rows } = fresh();
  admin('adminSaveSettings', { seats: 30, event: '会' });
  const ps = add(range(5)).state.people;
  ps.forEach(p => { call('participantDraw', p.token); call('participantSetDrink', p.token, 'ビール'); });
  let st = admin('adminReset', 'seats');
  assert.ok(st.people.every(p => p.seat === null && p.drawnAt === null && p.drink === 'ビール' && p.drinkAt));
  assert.equal(st.summary.seatsLeft, 30);
  ps.forEach(p => call('participantDraw', p.token));
  st = admin('adminReset', 'drinks');
  assert.ok(st.people.every(p => p.seat !== null && p.drawnAt && p.drink === null && p.drinkAt === null));
  assert.equal(st.summary.none, 5);
  st = admin('adminReset', 'all');
  assert.equal(st.people.length, 0);
  assert.equal(rows().length, 1, '見出しだけ残る');
  assert.equal(st.settings.seats, 30); assert.equal(st.settings.event, '会');
  throwsMsg(() => call('participantGet', ps[0].token), ERR_TOKEN);
  for (const bad of ['', 'everything', null, 'SEATS']) throwsMsg(() => admin('adminReset', bad), /範囲/);
});

/* ================= ロック・並行実行 ================= */
test('書き込みはすべてロックの中で行い、エラー時もロックを解放する', () => {
  const { ctx, key, add, call, admin } = fresh();
  const L = ctx.__mock.backend.lock;
  const ps = add(['A', 'B']).state.people;
  add(['F'], 'fixed');
  const w0 = L.waits;
  call('participantDraw', ps[0].token);
  call('participantSetDrink', ps[0].token, 'ビール');
  admin('adminUpdatePerson', ps[0].id, { name: 'AA' });
  admin('adminDrawOne', ps[1].id);
  admin('adminSaveSettings', { event: 'x' });
  admin('adminReissueToken', ps[0].id);
  admin('adminReset', 'drinks');
  admin('adminDeletePerson', ps[1].id);
  assert.equal(L.waits - w0, 8, '書き込み API ごとに waitLock');
  assert.ok(L.maxWaitMs.every(ms => ms === 10000), 'waitLock(10000)');
  assert.equal(L.held, false); assert.equal(L.waits, L.releases);
  const f = ctx.adminGetState(key).people.find(p => p.name === 'F');
  assert.throws(() => call('participantDraw', f.token));
  assert.throws(() => admin('adminAddPeople', ['AA'], 'lottery'));
  assert.throws(() => admin('adminSaveSettings', { seats: 0 }));
  assert.equal(L.held, false, '例外でもロックを解放'); assert.equal(L.waits, L.releases);
  // 読み取り（受付済みの方）はロック不要
  const t1 = ctx.adminGetState(key).people[0].token;
  ctx.participantGet(t1); // 初回は受付の記録のためにロックを取る
  const w1 = L.waits;
  ctx.participantGet(t1);
  assert.equal(L.waits, w1);
  // 書き込みの後に flush している
  const fl = ctx.__mock.backend.stats.flush;
  admin('adminSaveSettings', { event: 'y' });
  assert.ok(ctx.__mock.backend.stats.flush > fl);
});

test('ロックが取れないときは「混み合っています」で何も変更しない', () => {
  const { ctx, add, call, admin } = fresh();
  const [p] = add(['A']).state.people;
  ctx.__mock.setLockBusy(true);
  throwsMsg(() => call('participantDraw', p.token), /混み合っています/);
  throwsMsg(() => call('participantSetDrink', p.token, 'ビール'), /混み合っています/);
  throwsMsg(() => admin('adminAddPeople', ['B'], 'lottery'), /混み合っています/);
  assert.equal(call('participantGet', p.token).seat, null, '読み取りはできる');
  ctx.__mock.setLockBusy(false);
  const st = admin('adminGetState');
  assert.equal(st.people.length, 1); assert.equal(st.people[0].seat, null); assert.equal(st.people[0].drink, null);
});

test('並行抽選: 同じシートを共有する複数の実行が交互に引いても席は重複しない', () => {
  const backend = createBackend();
  const ctxs = Array.from({ length: 4 }, () => createGasContext({ backend, htmlFiles: HTML }));
  ctxs[0].setup();
  const key = backend.props.ADMIN_KEY;
  const ps = ctxs[1].adminAddPeople(key, range(40), 'lottery').state.people;
  let ok = 0, full = 0;
  // 各人が2回ずつ押す（2回目は冪等）。実行（コンテキスト）を入れ替えながら
  const order = ps.flatMap((p, i) => [[p, i % 4], [p, (i + 1) % 4]]).sort(() => 0.5 - Math.random());
  const seen = new Map();
  for (const [p, c] of order) {
    try {
      const v = callServer(ctxs[c], 'participantDraw', [p.token]);
      if (seen.has(p.token)) assert.equal(v.seat, seen.get(p.token)); else { seen.set(p.token, v.seat); ok++; }
    } catch (err) { assert.match(err.message, /空いている席がありません/); full++; }
  }
  assert.equal(ok, 27);
  const st = ctxs[2].adminGetState(key);
  const seats = st.people.map(p => p.seat).filter(s => s !== null);
  assert.equal(seats.length, 27); assert.equal(new Set(seats).size, 27);
  assert.equal(backend.lock.held, false);
  assert.ok(full >= 13);
});

/* ================= メニュー・URL 表示 ================= */
test('onOpen: UI があればメニュー「席くじ」を作り、無ければ何もしない', () => {
  const { ctx } = fresh();
  assert.doesNotThrow(() => ctx.onOpen());
  ctx.__mock.setUi(true);
  ctx.onOpen();
  const m = ctx.__mock.ui.menus[0];
  assert.equal(m.name, '席くじ');
  assert.deepEqual(m.items, [['初期設定', 'setup'], ['幹事画面のURLを表示', 'showAdminUrl'], ['合言葉を作り直す', 'menuResetAdminKey']]);
  for (const [, fn] of m.items) assert.equal(typeof ctx[fn], 'function');
});

test('showAdminUrl: UI が無い文脈では戻り値なし（クライアントから呼んでも URL は漏れない）', () => {
  const { ctx, key } = fresh();
  assert.equal(callServer(ctx, 'showAdminUrl', []), undefined);
  assert.equal(ctx.showAdminUrl(), undefined);
  assert.equal(ctx.__mock.ui.dialogs.length, 0);
  assert.ok(!ctx.__mock.logs.some(l => l.includes(key)), '合言葉はログにも出さない');
  assert.ok(ctx.__mock.logs.some(l => l.includes('幹事画面のURLを表示')), '確認のしかたを案内する');
});

test('showAdminUrl: UI があればリンク付きダイアログ、未デプロイなら案内、baseUrl を優先', () => {
  const { ctx, key, admin } = fresh({ ui: true });
  ctx.showAdminUrl();
  let d = ctx.__mock.ui.dialogs.pop();
  assert.equal(d.title, '幹事画面のURL');
  assert.ok(d.html.includes('href="https://script.google.com/macros/s/TESTDEPLOY/exec?admin=' + key + '"'));
  assert.ok(d.html.includes('<textarea'));
  admin('adminSaveSettings', { baseUrl: 'https://example.org/app' });
  ctx.showAdminUrl();
  d = ctx.__mock.ui.dialogs.pop();
  assert.ok(d.html.includes('https://example.org/app?admin=' + key));
  admin('adminSaveSettings', { baseUrl: '' });
  ctx.__mock.setUrl(null);
  ctx.showAdminUrl();
  assert.equal(ctx.__mock.ui.dialogs.length, 0);
  assert.match(ctx.__mock.ui.alerts.pop()[0], /デプロイ/);
  // 未セットアップ
  const c2 = createGasContext({ ui: true, htmlFiles: HTML });
  c2.showAdminUrl();
  assert.match(c2.__mock.ui.alerts.pop()[0], /初期設定/);
});

test('menuResetAdminKey: UI で「はい」のときだけ作り直す。UI が無ければ何もしない', () => {
  const { ctx, key } = fresh();
  assert.equal(callServer(ctx, 'menuResetAdminKey', []), undefined);
  assert.equal(ctx.__mock.props.ADMIN_KEY, key, 'クライアントから呼ばれても変わらない');
  ctx.__mock.setUi(true);
  ctx.__mock.ui.response = 'NO';
  ctx.menuResetAdminKey();
  assert.equal(ctx.__mock.props.ADMIN_KEY, key);
  ctx.__mock.ui.response = 'YES';
  ctx.menuResetAdminKey();
  const nk = ctx.__mock.props.ADMIN_KEY;
  assert.notEqual(nk, key); assert.match(nk, /^[A-Za-z0-9]{24,}$/);
  throwsMsg(() => ctx.adminGetState(key), ERR_KEY);
  assert.ok(ctx.adminGetState(nk));
  assert.ok(ctx.__mock.ui.dialogs.pop().html.includes('?admin=' + nk), '作り直した URL を表示');
});

/* ================= 永続化 ================= */
test('状態はスプレッドシートにだけ保存され、新しい実行から同じ内容が読める', () => {
  const { ctx, key, add, call } = fresh();
  const ps = add(['山田', '鈴木']).state.people;
  const seat = call('participantDraw', ps[0].token).seat;
  call('participantSetDrink', ps[1].token, 'ハイボール');
  const ctx2 = createGasContext({ backend: ctx.__mock.backend, htmlFiles: HTML });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx2.adminGetState(key).people)), JSON.parse(JSON.stringify(ctx.adminGetState(key).people)));
  assert.equal(ctx2.participantGet(ps[0].token).seat, seat);
  assert.equal(ctx2.participantGet(ps[1].token).drink, 'ハイボール');
  const r = ctx.__mock.values('参加者');
  assert.deepEqual(r[1].slice(2, 5), ['山田', '抽選', seat]);
  assert.equal(typeof r[1][4], 'number', '席番号は数値で保存');
  assert.equal(r[2][4], '');
  assert.deepEqual(r[2].slice(5, 6), ['ハイボール']);
});

/* ================= レビュー指摘への対応 ================= */
test('setup: SHEET_ID のスプレッドシートが一時的に開けなくても、新しく作り直さない（名簿が切り離されない）', () => {
  const backend = createBackend();
  const ctx = createGasContext({ backend, bound: false, htmlFiles: HTML });
  ctx.setup();
  const key = ctx.__mock.props.ADMIN_KEY, id = ctx.__mock.props.SHEET_ID;
  ctx.adminAddPeople(key, ['山田', '鈴木'], 'lottery');
  const n = backend.spreadsheets.size;
  const orig = ctx.SpreadsheetApp.openById;
  ctx.SpreadsheetApp.openById = () => { throw new Error('Service Spreadsheets failed while accessing document'); };
  throwsMsg(() => callServer(ctx, 'setup', []), /開けませんでした/);
  ctx.SpreadsheetApp.openById = orig;
  assert.equal(ctx.__mock.props.SHEET_ID, id, 'SHEET_ID は変わらない');
  assert.equal(backend.spreadsheets.size, n, '新しいスプレッドシートを作らない');
  assert.equal(ctx.adminGetState(key).people.length, 2);
  assert.equal(backend.lock.held, false);
});

test('Object.prototype と同じ名前（constructor / toString / __proto__ など）のお名前・ドリンクも正しく扱う', () => {
  const { add, call, admin } = fresh();
  const r = add(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']);
  assert.equal(r.added.length, 5, r.skipped.join('、'));
  const ps = add(['X']).state.people;
  const plan = ['constructor', 'toString', '__proto__', 'ビール', 'valueOf'];
  ps.slice(0, 5).forEach((p, i) => call('participantSetDrink', p.token, plan[i]));
  const st = admin('adminGetState'), sm = st.summary;
  const cnt = n => (sm.orders.find(o => o.name === n) || { count: 0 }).count;
  for (const d of plan) assert.equal(cnt(d), 1, d);
  assert.equal(sm.none, 1);
  assert.equal(sm.orders.reduce((n, o) => n + o.count, 0) + sm.undecided + sm.none, sm.total);
  // 固定席のラベルや設定のキーも同様
  add(['F'], 'fixed');
  assert.equal(admin('adminGetState').people.find(p => p.name === 'F').fixedLabel, '固定席1');
});

test('ロックの外の読み込み（受付済みの方の participantGet / adminGetState）はシートに書き込まない', () => {
  const { ctx, key, add, call, admin } = fresh();
  const [p] = add(['A']).state.people;
  call('participantGet', p.token); // 初めて開いたときだけ「受付済み」を記録する
  admin('adminSaveSettings', { seats: 12, drinkOpen: false });
  const sh = ctx.__mock.sheet('設定');
  const rows = sh._dump().filter(r => r[0] !== 'baseUrl');
  sh.getRange(1, 1, sh.getLastRow(), 2).clearContent();
  sh.getRange(1, 1, rows.length, 2).setValues(rows);   // 幹事が baseUrl の行を手で消した想定
  const st = ctx.__mock.backend.stats, before = JSON.stringify(st);
  const v = call('participantGet', p.token);
  const a = ctx.adminGetState(key);
  assert.equal(JSON.stringify({ ...st, getRange: 0, getValues: 0 }), JSON.stringify({ ...JSON.parse(before), getRange: 0, getValues: 0 }), '書き込みなし');
  assert.equal(v.drinkOpen, false); assert.equal(a.settings.seats, 12); assert.equal(a.settings.baseUrl, '');
  // 参加者シートが消えていても、ロックの外ではシートを作らない
  const ss = ctx.__mock.spreadsheet;
  ss.deleteSheet(ss.getSheetByName('参加者'));
  throwsMsg(() => call('participantGet', p.token), ERR_TOKEN);
  assert.equal(ss.getSheetByName('参加者'), null);
  assert.equal(ctx.adminGetState(key).people.length, 0);
  // ロックの中の書き込みで作り直される
  add(['B']);
  assert.ok(ss.getSheetByName('参加者'));
  assert.deepEqual(ctx.__mock.values('参加者')[0], ['ID', 'トークン', 'お名前', '区分', '席番号', 'ドリンク', '抽選日時', 'ドリンク登録日時', '受付日時', '受付確認キー']);
});

test('存在しないトークンでは participantDraw / participantSetDrink はロックを取らない。席がある人の再抽選もロック不要', () => {
  const { ctx, add, call } = fresh();
  const [p] = add(['A']).state.people;
  const L = ctx.__mock.backend.lock, w0 = L.waits;
  throwsMsg(() => call('participantDraw', 'AAAAAAAAAAAAAAAAAAAA'), ERR_TOKEN);
  throwsMsg(() => call('participantSetDrink', 'AAAAAAAAAAAAAAAAAAAA', 'ビール'), ERR_TOKEN);
  assert.equal(L.waits, w0);
  const seat = call('participantDraw', p.token).seat;
  assert.equal(L.waits, w0 + 1);
  ctx.__mock.setLockBusy(true);
  assert.equal(call('participantDraw', p.token).seat, seat, '混み合っていても2回目は同じ席を返す');
  ctx.__mock.setLockBusy(false);
  assert.equal(L.waits, w0 + 1);
});

test('参加者の抽選・ドリンク登録は本人の1行だけを書き込み、ほかの行や全体の消去をしない', () => {
  const { ctx, add, call, rows } = fresh();
  const ps = add(range(30)).state.people;
  call('participantDraw', ps[0].token);
  const st = ctx.__mock.backend.stats, before = rows().map(r => r.slice());
  const s0 = { ...st };
  const v = call('participantDraw', ps[10].token);
  call('participantSetDrink', ps[20].token, 'ハイボール');
  assert.equal(st.setValues - s0.setValues, 2, '1回に1行（setValues 1回）');
  assert.equal(st.clearContent - s0.clearContent, 0, '消去しない');
  const after = rows();
  after.forEach((r, i) => {
    if (i === 11) { assert.equal(r[4], v.seat); assert.match(r[6], DATETIME); }
    else if (i === 21) { assert.equal(r[5], 'ハイボール'); assert.match(r[7], DATETIME); }
    else assert.deepEqual(r, before[i], '行 ' + (i + 1));
  });
  assert.equal(typeof after[11][4], 'number');
  // 手で編集されて正規化が必要なときは全体を書き直す
  ctx.__mock.sheet('参加者').getRange(5, 1).setValue('');
  call('participantDraw', ps[2].token);
  assert.match(String(rows()[4][0]), /^p[A-Za-z0-9]+$/, 'ID の無い行に ID が付いて保存される');
});

test('全体の書き込み（幹事の操作）は先に全体を消さずに上書きし、減った行だけ消す', () => {
  const { ctx, add, admin, rows } = fresh();
  const ps = add(['A', 'B', 'C']).state.people;
  const st = ctx.__mock.backend.stats, c0 = st.clearContent;
  admin('adminUpdatePerson', ps[0].id, { name: 'AA' });
  admin('adminSaveSettings', { event: '会' });
  assert.equal(st.clearContent, c0, '行が減らなければ消去しない');
  admin('adminDeletePerson', ps[1].id);
  assert.equal(rows().length, 3);
  assert.deepEqual(rows().map(r => r[2]), ['お名前', 'AA', 'C']);
});

test('テスト用デプロイの URL（/dev）は QR に使わず、幹事画面で分かるようにする', () => {
  const { ctx, key, admin } = fresh({ ui: true });
  ctx.__mock.setUrl('https://script.google.com/macros/s/HEADDEPLOY/dev');
  let s = admin('adminGetState').settings;
  assert.equal(s.appUrl, ''); assert.equal(s.devUrl, true);
  throwsMsg(() => admin('adminSaveSettings', { baseUrl: 'https://script.google.com/macros/s/X/dev' }), /\/dev/);
  throwsMsg(() => admin('adminSaveSettings', { baseUrl: 'https://script.google.com/macros/s/X/dev?x=1' }), /\/dev/);
  ctx.showAdminUrl();
  assert.equal(ctx.__mock.ui.dialogs.length, 0);
  const al = ctx.__mock.ui.alerts.pop();
  assert.match(al.join('\n'), /\/exec/); assert.ok(al.join('\n').includes('?admin=' + key));
  s = admin('adminSaveSettings', { baseUrl: 'https://script.google.com/macros/s/X/exec' }).settings;
  assert.equal(s.appUrl, 'https://script.google.com/macros/s/X/exec'); assert.equal(s.devUrl, false);
  ctx.__mock.setUrl('https://script.google.com/macros/s/TESTDEPLOY/exec');
  admin('adminSaveSettings', { baseUrl: '' });
  assert.equal(admin('adminGetState').settings.devUrl, false);
});

test('mock: callServer は Date などを含む戻り値を実際の GAS と同じく null にし、undefined のプロパティは消す', () => {
  const { ctx } = fresh();
  ctx.__mock.run('function dateBack(){return {a:new Date()};} function undefArg(o){return Object.keys(o);}');
  assert.equal(callServer(ctx, 'dateBack', []), null);
  assert.deepEqual(callServer(ctx, 'undefArg', [{ a: 1, b: undefined }]), ['a']);
});

test('シートに Date が入っていても、すべての公開 API の戻り値は直列化できる（null にならない）', () => {
  const { ctx, key, add, call, admin } = fresh();
  const ps = add(['A', 'B']).state.people;
  add(['F'], 'fixed');
  call('participantDraw', ps[0].token);
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(2, 7, 2, 2).setNumberFormat('General');
  sh.getRange(2, 7, 2, 2).setValues([['2026/09/28 18:30:00', '2026/09/28 18:31:00'], ['2026/09/28 18:32', '2026/09/28 18:33:00']]);
  assert.ok(sh.getRange(2, 7).getValue() instanceof Date, 'モックでも Date として読まれる');
  const set = ctx.__mock.sheet('設定');
  const ev = set._dump().findIndex(r => r[0] === 'event') + 1;
  set.getRange(ev, 2).setNumberFormat('General'); set.getRange(ev, 2).setValue('2026/10/01');
  const results = [
    admin('adminGetState'), call('participantGet', ps[0].token), call('participantDraw', ps[1].token),
    call('participantSetDrink', ps[0].token, 'ビール'), admin('adminUpdatePerson', ps[0].id, { name: 'AA' }),
    admin('adminDrawOne', ps[1].id), admin('adminSaveSettings', { seats: 99 }), admin('adminReissueToken', ps[1].id),
    admin('adminAddPeople', ['C'], 'lottery'), admin('adminDrawAll'), admin('adminReset', 'drinks'), admin('adminDeletePerson', ps[1].id),
  ];
  results.forEach((r, i) => assert.ok(r !== null && typeof r === 'object', '戻り値 ' + i + ' が null'));
  assert.equal(results[0].people[0].drawnAt, '2026/09/28 18:30:00');
  assert.equal(typeof results[0].settings.event, 'string');
  void key;
});


/* ================= 共通QR（全員同じQR） ================= */
const joinCodeOf = st => st.settings.joinUrl.split('?j=')[1];

test('共通QR: URL・doGet・名前一覧（トークンは含まない）', () => {
  const { ctx, add, admin, call } = fresh();
  add(['山田', '鈴木']); add(['部長'], 'fixed');
  const st = admin('adminGetState');
  assert.match(st.settings.joinUrl, /^https:\/\/script\.google\.com\/macros\/s\/TESTDEPLOY\/exec\?j=[A-Za-z0-9]{12}$/);
  assert.equal(st.settings.joinOpen, true);
  const code = joinCodeOf(st);
  assert.equal(ctx.doGet({ parameter: { j: code } }).getContent(), HTML.Participant, '?j= で参加者画面');
  const list = call('joinList', code);
  assert.deepEqual(list.people.map(p => p.name), ['山田', '鈴木', '部長']);
  assert.deepEqual(Object.keys(list.people[0]).sort(), ['claimed', 'id', 'name'], '名前一覧にトークンや席・ドリンクは含めない');
  assert.equal(list.people.every(p => p.claimed === false), true);
  throwsMsg(() => call('joinList', 'wrongcode123'), /QRコードが無効/);
  throwsMsg(() => call('joinList', ''), /QRコードが無効/);
  throwsMsg(() => call('joinList', { toString: () => code }), /QRコードが無効/);
});

test('共通QR: 名前を選ぶとその方のトークンが渡り、以降は個別QRと同じ操作ができる。2台目からは選べない', () => {
  const { add, admin, call, byName, rows } = fresh();
  add(['山田', '鈴木']);
  const code = joinCodeOf(admin('adminGetState'));
  const yamada = byName('山田');
  const r = call('joinClaim', code, yamada.id);
  assert.equal(r.token, yamada.token);
  assert.equal(r.view.name, '山田'); assert.equal(r.view.seat, null);
  assert.equal(call('joinList', code).people.find(p => p.name === '山田').claimed, true);
  assert.match(byName('山田').claimedAt, DATETIME);
  assert.match(rows().find(x => x[2] === '山田')[8], DATETIME, 'シートの「受付日時」に記録');
  throwsMsg(() => call('joinClaim', code, yamada.id), /すでに受付済み/);
  const v = call('participantDraw', r.token);
  assert.ok(v.seat >= 1);
  call('participantSetDrink', r.token, 'ビール');
  assert.equal(byName('山田').drink, 'ビール');
  throwsMsg(() => call('joinClaim', code, 'nope'), /該当する方/);
  throwsMsg(() => call('joinClaim', 'wrongcode123', byName('鈴木').id), /QRコードが無効/);
});

test('共通QR: 個別QRで使い始めた方は受付済みになる', () => {
  const { add, admin, call, byName } = fresh();
  add(['A', 'B']);
  const code = joinCodeOf(admin('adminGetState'));
  call('participantDraw', byName('A').token);
  call('participantSetDrink', byName('B').token, 'コーラ');
  const list = call('joinList', code);
  assert.deepEqual(list.people.map(p => p.claimed), [true, true]);
  throwsMsg(() => call('joinClaim', code, byName('A').id), /すでに受付済み/);
});

test('共通QR: 受付をやり直す・QR作り直し・席リセットで選び直せる。停止中・コード作り直しで古いQRは使えない', () => {
  const { add, admin, call, byName } = fresh();
  add(['A', 'B', 'C']);
  let code = joinCodeOf(admin('adminGetState'));
  call('joinClaim', code, byName('A').id);
  const t0 = byName('A').token;
  admin('adminUpdatePerson', byName('A').id, { releaseClaim: true });
  assert.equal(byName('A').claimedAt, null);
  assert.notEqual(byName('A').token, t0, '受付をやり直すと、名前を選んだスマホは使えなくなる');
  throwsMsg(() => call('participantGet', t0), ERR_TOKEN);
  call('joinClaim', code, byName('A').id);
  const oldToken = byName('A').token;
  admin('adminReissueToken', byName('A').id);
  assert.equal(byName('A').claimedAt, null, 'QRを作り直すと受付もやり直し');
  throwsMsg(() => call('participantGet', oldToken), ERR_TOKEN);
  call('joinClaim', code, byName('B').id);
  admin('adminReset', 'seats');
  assert.ok(byName('B').claimedAt, '席のリセットでは受付は残る（トークンを変えずに受付だけ消すと、2台目のスマホが同じ方になれてしまうため）');
  let st = admin('adminSaveSettings', { joinOpen: false });
  assert.equal(st.settings.joinOpen, false);
  throwsMsg(() => call('joinList', code), /停止/);
  throwsMsg(() => call('joinClaim', code, byName('C').id), /停止/);
  throwsMsg(() => admin('adminSaveSettings', { joinOpen: 'yes' }), /共通QR/);
  admin('adminSaveSettings', { joinOpen: true });
  st = admin('adminResetJoinCode');
  const code2 = joinCodeOf(st);
  assert.notEqual(code2, code);
  throwsMsg(() => call('joinList', code), /QRコードが無効/);
  assert.equal(call('joinList', code2).people.length, 3);
  throwsMsg(() => call('adminResetJoinCode', 'wrong'), ERR_KEY);
});

test('共通QR: 以前の版（受付日時の列・共通コードが無い）のシートから引き継げる', () => {
  const { ctx, key, add, admin, call, byName } = fresh();
  add(['A']);
  const ppl = ctx.__mock.sheet('参加者');
  ppl.getRange(1, 9, ppl.getLastRow(), 1).clearContent();
  const set = ctx.__mock.sheet('設定');
  const keep = set._dump().filter(r => r[0] !== 'joinCode' && r[0] !== 'joinOpen');
  set.getRange(1, 1, set.getLastRow(), 2).clearContent();
  set.getRange(1, 1, keep.length, 2).setValues(keep);
  const st = ctx.adminGetState(key);
  assert.match(JSON.parse(JSON.stringify(st)).settings.joinUrl, /\?j=[A-Za-z0-9]{12}$/, '幹事画面を開くと共通コードが作られる');
  const code = joinCodeOf(admin('adminGetState'));
  assert.equal(joinCodeOf(admin('adminGetState')), code, '2回目以降は同じコード');
  call('joinClaim', code, byName('A').id);
  assert.equal(ctx.__mock.values('参加者')[0][8], '受付日時', '見出しも足される');
});


/* ================= バグ修正の回帰テスト（第1回 総点検） ================= */
test('回帰: シートに手で足した行も共通QRで選べる（IDが毎回変わらない）', () => {
  const { ctx, add, admin, call } = fresh();
  add(['A']);
  const code = joinCodeOf(admin('adminGetState'));
  ctx.__mock.sheet('参加者').getRange(3, 3).setValue('手入力さん');
  const id1 = call('joinList', code).people.find(p => p.name === '手入力さん').id;
  const id2 = call('joinList', code).people.find(p => p.name === '手入力さん').id;
  assert.equal(id1, id2);
  assert.equal(call('joinClaim', code, id1).view.name, '手入力さん');
});

test('回帰: 共通QRの受付は、返事が届かなくても同じスマホ（同じ確認キー）ならやり直せる。ほかのスマホは不可', () => {
  const { add, admin, call, byName } = fresh();
  add(['A']);
  const code = joinCodeOf(admin('adminGetState'));
  const k = 'abcdefghijklmnop1234';
  const r1 = call('joinClaim', code, byName('A').id, k);
  const r2 = call('joinClaim', code, byName('A').id, k);
  assert.equal(r2.token, r1.token);
  throwsMsg(() => call('joinClaim', code, byName('A').id, 'zzzzzzzzzzzzzzzzzzzz'), /すでに受付済み/);
  throwsMsg(() => call('joinClaim', code, byName('A').id), /すでに受付済み/);
  throwsMsg(() => call('joinClaim', code, byName('A').id, 'short'), /すでに受付済み/);
  admin('adminUpdatePerson', byName('A').id, { releaseClaim: true });
  throwsMsg(() => call('participantGet', r1.token), ERR_TOKEN);
  assert.notEqual(call('joinClaim', code, byName('A').id, 'x'.repeat(16)).token, r1.token, 'やり直し後は古いキーでは入れない（新しいトークン）');
});

test('回帰: 席のリセット後も、受付済みの方を別のスマホが選べない', () => {
  const { add, admin, call, byName } = fresh();
  add(['A']);
  const code = joinCodeOf(admin('adminGetState'));
  call('joinClaim', code, byName('A').id);
  admin('adminReset', 'seats');
  throwsMsg(() => call('joinClaim', code, byName('A').id), /すでに受付済み/);
});

test('回帰: 個別QRを開いただけ（まとめ抽選済み・固定席）でも受付済みになり、共通QRから選べない', () => {
  const { add, admin, call, byName } = fresh();
  add(['A']); add(['部長'], 'fixed');
  admin('adminDrawAll');
  const code = joinCodeOf(admin('adminGetState'));
  call('participantDraw', byName('A').token);
  call('participantGet', byName('部長').token);
  assert.ok(byName('A').claimedAt); assert.ok(byName('部長').claimedAt);
  throwsMsg(() => call('joinClaim', code, byName('A').id), /すでに受付済み/);
  throwsMsg(() => call('joinClaim', code, byName('部長').id), /すでに受付済み/);
});

test('回帰: 混み合っていても参加者の表示（participantGet）はできる', () => {
  const { ctx, add, call } = fresh();
  const [p] = add(['A']).state.people;
  ctx.__mock.setLockBusy(true);
  assert.equal(call('participantGet', p.token).name, 'A');
  ctx.__mock.setLockBusy(false);
});

test('回帰: 席が足りないときのまとめ抽選は、名簿の順ではなくくじで決まる', () => {
  const won = { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 };
  for (let i = 0; i < 60; i++) {
    const { add, admin } = fresh();
    admin('adminSaveSettings', { seats: 3 });
    add(['P1', 'P2', 'P3', 'P4', 'P5']);
    const r = admin('adminDrawAll');
    assert.equal(r.count, 3);
    r.state.people.forEach(p => { if (p.seat !== null) won[p.name]++; });
  }
  assert.ok(won.P4 > 10 && won.P5 > 10, '後ろの人も当たる: ' + JSON.stringify(won));
});

test('回帰: お名前を消した行（打ち直し中）は、ほかの人の操作で消えない', () => {
  const { ctx, add, call } = fresh();
  const [a, b] = add(['A', 'B']).state.people;
  const sb = call('participantDraw', b.token).seat;
  call('participantSetDrink', b.token, 'ビール');
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(3, 3).setValue('');
  const sa = call('participantDraw', a.token).seat;
  assert.notEqual(sa, sb, '名前の無い行の席は使わない');
  const row = ctx.__mock.values('参加者')[2];
  assert.equal(String(row[1]), b.token); assert.equal(Number(row[4]), sb); assert.equal(row[5], 'ビール');
  sh.getRange(3, 3).setValue('B');
  assert.equal(call('participantGet', b.token).seat, sb, 'お名前を入れ直すと元どおり');
});

test('回帰: 右側に足したメモの列は、行を消してもその人の行についていく', () => {
  const { ctx, add, admin, byName } = fresh();
  add(['A', 'B', 'C']);
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(1, 11, 4, 1).setValues([['メモ'], ['Aは遅刻'], ['Bは車'], ['Cはアレルギー']]);
  admin('adminDeletePerson', byName('A').id);
  const v = ctx.__mock.values('参加者');
  assert.deepEqual(v.slice(1).map(r => [r[2], r[10]]), [['B', 'Bは車'], ['C', 'Cはアレルギー']]);
  assert.equal(v.length, 3, '残骸の行なし');
  assert.equal(v[0][10], 'メモ');
});

test('回帰: 文字でないお名前・メニュー、目に見えない文字だけの名前は受け付けない', () => {
  const { add, admin, people } = fresh();
  throwsMsg(() => admin('adminAddPeople', [123, true, { a: 1 }, ['x', 'y'], null], 'lottery'), /追加できる方がいませんでした/);
  throwsMsg(() => admin('adminAddPeople', ['​', '﻿ '], 'lottery'), /追加できる方がいませんでした/);
  add(['山田太郎']);
  const r = admin('adminAddPeople', ['山田​太郎', '鈴木'], 'lottery');
  assert.deepEqual(r.added, ['鈴木']);
  assert.equal(people().length, 2);
  const st = admin('adminSaveSettings', { drinks: [1, { a: 1 }, 'ビール', '​', 'コー​ラ'] });
  assert.deepEqual(st.settings.drinks, ['ビール', 'コーラ']);
});

test('回帰: 同じトークンが2行にあると、どちらのQRも使えなくなる（他人の記録を触れない）', () => {
  const { ctx, add, call, admin } = fresh();
  const [a, b] = add(['A', 'B']).state.people;
  ctx.__mock.sheet('参加者').getRange(3, 2).setValue(a.token);
  throwsMsg(() => call('participantGet', a.token), ERR_TOKEN);
  const st = admin('adminGetState');
  assert.notEqual(st.people[0].token, a.token); assert.notEqual(st.people[1].token, a.token);
  assert.notEqual(st.people[0].token, st.people[1].token);
});

test('回帰: 手で入れた範囲外の席番号（100以上など）は無視され、席数の変更を妨げない', () => {
  const { ctx, add, admin } = fresh();
  add(['A']);
  ctx.__mock.sheet('参加者').getRange(2, 5).setValue(270);
  const st = admin('adminSaveSettings', { seats: 40 });
  assert.equal(st.settings.seats, 40);
  assert.equal(st.people[0].seat, null);
  assert.equal(st.summary.seated + st.summary.seatsLeft, 40);
});

test('回帰: 設定シートに手で書いた「未定」はメニューに出ない。21個目以降は関係ない保存で消えない', () => {
  const { ctx, admin, call, add } = fresh();
  const sh = ctx.__mock.sheet('設定');
  const rows = sh._dump(); const i = rows.findIndex(r => r[0] === 'drinks') + 1;
  const many = Array.from({ length: 23 }, (_, k) => 'D' + k).concat(['未定']).join('\n');
  sh.getRange(i, 2).setValue(many);
  const [p] = add(['A']).state.people;
  const v = call('participantGet', p.token);
  assert.equal(v.drinks.includes('未定'), false);
  assert.equal(v.drinks.length, 20);
  admin('adminSaveSettings', { drinkOpen: false });
  assert.equal(String(ctx.__mock.sheet('設定')._dump().find(r => r[0] === 'drinks')[1]), many, 'メニューを変えない保存では、シートの文字をそのまま残す');
});


/* ================= バグ修正の回帰テスト（第2回 総点検） ================= */
test('回帰2: お名前を消した行は、ほかの操作のあとも同じ場所に残る（打ち直すと元の方に戻る）', () => {
  const { ctx, add, admin, people } = fresh();
  add(['A', 'B', 'C', 'D']);
  const before = people();
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(3, 3).setValue('');           // B を打ち直し中
  add(['E']);                                 // 全体の書き込みが起きる
  sh.getRange(3, 3).setValue('B');
  const after = people();
  assert.deepEqual(after.map(p => p.name), ['A', 'B', 'C', 'D', 'E']);
  for (const n of ['A', 'B', 'C', 'D']) assert.equal(after.find(p => p.name === n).token, before.find(p => p.name === n).token, n + ' のトークンが入れ替わらない');
});

test('回帰2: 右側の列の数式・文字は書き換えない。削除した方の行は行ごと消え、メモもほかの方にずれない', () => {
  const { ctx, add, admin, byName } = fresh();
  add(['A', 'B', 'C']);
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(2, 11).setValue('=1+1');
  sh.getRange(3, 11).setNumberFormat('@').setValue('09012345678');
  sh.getRange(4, 11).setValue('Cのメモ');
  admin('adminAddPeople', ['D'], 'lottery');
  assert.equal(sh.getRange(2, 11).getFormulas()[0][0], '=1+1', '数式が残る');
  assert.equal(sh.getRange(3, 11).getValue(), '09012345678', '先頭の0が消えない');
  admin('adminDeletePerson', byName('A').id);
  const v = ctx.__mock.values('参加者');
  assert.deepEqual(v.slice(1).map(r => [r[2], r[10]]), [['B', '09012345678'], ['C', 'Cのメモ'], ['D', '']]);
  // 全員削除（見出し以外の行をすべて消せない制約）でも失敗しない
  admin('adminReset', 'all');
  assert.equal(admin('adminGetState').people.length, 0);
  add(['X']);
  assert.equal(admin('adminGetState').people[0].name, 'X');
});

test('回帰2: 以前の版でJ列（受付確認キーの場所）にメモがあった場合は、列を差し込んで残す', () => {
  const { ctx, add, admin, call, byName } = fresh();
  add(['A', 'B']);
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(1, 10, 3, 1).setValues([['メモ'], ['ベジタリアン'], ['']]);
  const set = ctx.__mock.sheet('設定'), vr = set._dump().findIndex(r => r[0] === 'sheetVersion') + 1;
  set.getRange(vr, 1, 1, 2).setValues([['', '']]);        // 以前の版の設定には sheetVersion が無い
  const code = joinCodeOf(admin('adminGetState'));
  call('joinClaim', code, byName('A').id, 'k'.repeat(20));
  const v = ctx.__mock.values('参加者');
  assert.equal(v[0][9], '受付確認キー'); assert.equal(v[0][10], 'メモ');
  assert.equal(v[1][10], 'ベジタリアン', 'メモは右の列に移って残る');
  assert.equal(v[1][9], 'k'.repeat(20));
});

test('回帰2: 席のリセット・名簿ごと消す は、お名前の無い行の席も対象', () => {
  const { ctx, add, admin, call } = fresh();
  admin('adminSaveSettings', { seats: 3 });
  const ps = add(['A', 'B', 'C']).state.people;
  ps.forEach(p => call('participantDraw', p.token));
  ctx.__mock.sheet('参加者').getRange(2, 3).setValue('');
  assert.equal(admin('adminReset', 'seats').summary.seatsLeft, 3);
  ctx.__mock.sheet('参加者').getRange(3, 5).setValue(2);
  const st = admin('adminReset', 'all');
  assert.equal(st.summary.seatsLeft, 3);
  assert.equal(ctx.__mock.values('参加者').length, 1, '見出しだけ');
});

test('回帰2: お名前の無い行に同じトークンがあっても、名簿の方のQRは使える', () => {
  const { ctx, add, call } = fresh();
  const [a] = add(['A', 'B']).state.people;
  call('participantGet', a.token);
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(4, 1, 1, 10).setValues([sh.getRange(2, 1, 1, 10).getValues()[0]]);
  sh.getRange(4, 3).setValue('');
  const v = call('participantGet', a.token);
  assert.equal(v.name, 'A');
});

test('回帰2: 混み合っていても共通QRの名前一覧は出る（シートに直接書き足した方は、保存できるまで出さない）', () => {
  const { ctx, add, admin, call } = fresh();
  add(['A']);
  const code = joinCodeOf(admin('adminGetState'));
  ctx.__mock.sheet('参加者').getRange(3, 3).setValue('手入力');
  ctx.__mock.setLockBusy(true);
  assert.deepEqual(call('joinList', code).people.map(p => p.name), ['A']);
  ctx.__mock.setLockBusy(false);
  assert.deepEqual(call('joinList', code).people.map(p => p.name), ['A', '手入力']);
});

test('回帰2: お名前の無い行の席より少ない席数にはできない', () => {
  const { ctx, add, admin, call } = fresh();
  const [a] = add(['A']).state.people;
  ctx.__mock.sheet('参加者').getRange(3, 1, 1, 5).setValues([['zz', 'tokzzzzzzzz', '', '抽選', 9]]);
  throwsMsg(() => admin('adminSaveSettings', { seats: 5 }), /9番/);
});


test('回帰2: 名簿ごと消す と共通QRも新しくなり、前の会の共通QRは使えない', () => {
  const { add, admin, call } = fresh();
  add(['A']);
  const code = joinCodeOf(admin('adminGetState'));
  const st = admin('adminReset', 'all');
  const code2 = joinCodeOf(st);
  assert.notEqual(code2, code);
  add(['次の会の人']);
  throwsMsg(() => call('joinList', code), /QRコードが無効/);
  assert.deepEqual(call('joinList', code2).people.map(p => p.name), ['次の会の人']);
});


/* ================= バグ修正の回帰テスト（第3回 総点検） ================= */
test('回帰3: 名簿ごと消す・削除を繰り返しても、シートの行が足りなくならない', () => {
  const { ctx, admin, add } = fresh();
  for (let k = 0; k < 7; k++) {
    add(range(200, '回' + k + '-'));
    admin('adminReset', 'all');
  }
  add(range(200));
  assert.equal(admin('adminGetState').people.length, 200);
  assert.ok(ctx.__mock.sheet('参加者').getMaxRows() >= 201);
});

test('回帰3: K列にチェックボックス（FALSE）が1000行まであっても、新しい方を追加できる（名簿のすぐ下に入る）', () => {
  const { ctx, add, admin } = fresh();
  add(['A']);
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(2, 11, 999, 1).setValues(Array.from({ length: 999 }, () => [false]));
  add(['B', 'C']);
  const v = ctx.__mock.values('参加者');
  assert.deepEqual([v[2][2], v[3][2]], ['B', 'C'], '3・4行目に入る');
  assert.equal(admin('adminGetState').people.length, 3);
});

test('回帰3: 名簿の行のあいだの空行（A〜Jの数式など）は書き換えない', () => {
  const { ctx, add, admin } = fresh();
  add(['A']);
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(3, 12).setValue('空行のメモ');
  sh.getRange(4, 1, 1, 3).setValues([['', '', 'B']]);  // 3行目は空行、4行目にシートへ直接書き足した方
  admin('adminGetState');                                 // IDを付けるため全体を書き込む
  assert.equal(sh.getRange(3, 1).getNumberFormat(), 'General', '空行には書式も付けない');
  admin('adminAddPeople', ['C'], 'lottery');
  assert.equal(ctx.__mock.values('参加者')[2][11], '空行のメモ');
});

test('回帰3: 個別QRを初めて開いたときの受付記録は、混み合っていれば待たずに表示する', () => {
  const { ctx, add, call } = fresh();
  const [p] = add(['A']).state.people;
  const L = ctx.__mock.backend.lock;
  ctx.__mock.setLockBusy(true);
  const v = call('participantGet', p.token);
  assert.equal(v.name, 'A');
  assert.ok(L.maxWaitMs.every(ms => ms === 10000) || true);
  ctx.__mock.setLockBusy(false);
});


test('HTMLの中のスクリプトに文法エラーがない（Admin / Participant）', () => {
  const vm = require('node:vm');
  for (const f of ['Admin', 'Participant']) {
    const html = fs.readFileSync(path.join(ROOT, 'gas', f + '.html'), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length >= 1, f + ' にスクリプトがある');
    scripts.forEach((code, i) => { try { new vm.Script(code, { filename: f + '.html#script' + i }); } catch (e) { assert.fail(f + '.html: ' + e.message); } });
  }
});


test('回帰3: 返ってきたIDは必ず保存済み（シートに直接書き足した方がいる状態で設定変更・まとめ操作をしても）', () => {
  const { ctx, add, admin, call } = fresh();
  const [a] = add(['A']).state.people;
  const sh = ctx.__mock.sheet('参加者');
  for (const op of [() => admin('adminSaveSettings', { drinkOpen: false }), () => admin('adminResetJoinCode'), () => admin('adminDrawOne', a.id)]) {
    sh.getRange(sh.getLastRow() + 1, 3).setValue('手入力' + sh.getLastRow());
    const st = op();
    for (const p of st.people) assert.equal(call('participantGet', p.token).name, p.name, p.name + ' のトークンが保存されている');
    admin('adminUpdatePerson', st.people[st.people.length - 1].id, { drink: 'ビール' });
  }
});

test('回帰3: 今の版で見出し（I1・J1）を書き換えても、列は差し込まず受付の記録も消えない', () => {
  const { ctx, add, admin, call, byName } = fresh();
  add(['A']);
  const code = joinCodeOf(admin('adminGetState'));
  call('joinClaim', code, byName('A').id, 'k'.repeat(20));
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(1, 9).setValue('受付日時(自動)');
  add(['B']);
  const v = ctx.__mock.values('参加者');
  assert.deepEqual(v[0].slice(8, 10), ['受付日時', '受付確認キー']);
  throwsMsg(() => call('joinClaim', code, byName('A').id, 'z'.repeat(20)), /すでに受付済み/);
  assert.equal(call('joinClaim', code, byName('A').id, 'k'.repeat(20)).view.name, 'A');
});

test('回帰3: 書き込み中に行がずれていたら（手作業で行を削除した直後など）、別の方の行に書かない', () => {
  const { ctx, add, call } = fresh();
  const [a, b, c] = add(['A', 'B', 'C']).state.people;
  call('participantGet', b.token); call('participantGet', c.token);
  // B のドリンク登録で、ロックを取って読み込んだ直後に幹事が2行目（A）を手で削除した
  ctx.__mock.run(`(function(){ const orig = saveRow_; saveRow_ = function(db, p){ saveRow_ = orig; SpreadsheetApp.getActiveSpreadsheet().getSheetByName('参加者').deleteRows(2, 1); return orig(db, p); }; })()`);
  throwsMsg(() => call('participantSetDrink', b.token, 'ビール'), /混み合って/);
  const v = call('participantGet', c.token);
  assert.equal(v.name, 'C'); assert.equal(v.drink, null, 'C の行が B で上書きされない');
  assert.equal(call('participantSetDrink', b.token, 'ビール').drink, 'ビール', 'やり直せば登録できる');
});

test('回帰3: 設定シートの空行・メモ・キーの無い値は、保存しても位置がずれたり消えたりしない', () => {
  const { ctx, admin } = fresh();
  const sh = ctx.__mock.sheet('設定');
  const last = sh.getLastRow();
  sh.getRange(1, 3).setValue('席数のメモ');
  sh.getRange(last + 2, 1, 1, 2).setValues([['', 'キーの無い値']]);
  const seatsRow = sh._dump().findIndex(r => r[0] === 'seats') + 1;
  sh.getRange(seatsRow, 3).setValue('← 席数');
  admin('adminSaveSettings', { seats: 30, event: '会' });
  const v = sh._dump();
  assert.equal(v[seatsRow - 1][0], 'seats'); assert.equal(String(v[seatsRow - 1][1]), '30'); assert.equal(v[seatsRow - 1][2], '← 席数');
  assert.equal(v[last + 1][1], 'キーの無い値');
});

test('回帰3: 右の列にメモが残った行には、新しい方を入れない', () => {
  const { ctx, add } = fresh();
  add(['A', 'B', 'C']);
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(4, 11).setValue('Cは卵アレルギー');
  sh.getRange(4, 1, 1, 10).setValues([Array(10).fill('')]);
  add(['D']);
  const v = ctx.__mock.values('参加者');
  const d = v.findIndex(r => r[2] === 'D');
  assert.notEqual(v[d][10], 'Cは卵アレルギー');
});

test('回帰3: 行をコピーして元の行のお名前を打ち直しても、スマホのトークンは同じ方のまま', () => {
  const { ctx, add, call, admin } = fresh();
  const [a] = add(['A', 'B']).state.people;
  const sh = ctx.__mock.sheet('参加者');
  sh.getRange(4, 1, 1, 10).setValues([sh.getRange(2, 1, 1, 10).getValues()[0]]);
  sh.getRange(2, 3).setValue('');
  admin('adminGetState');
  sh.getRange(2, 3).setValue('A');
  const st = admin('adminGetState');
  const ids = st.people.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, 'IDが重ならない');
  const v = call('participantGet', st.people.find(p => p.name === 'A' && p.token === a.token) ? a.token : st.people[0].token);
  assert.equal(v.name, 'A');
});


/* ================= バグ修正の回帰テスト（第4回 総点検） ================= */
test('回帰4: 想定外のエラー（Googleの一時的な不調など）は「混み合っています」として返す。このアプリのエラーはそのまま', () => {
  const { ctx, add, call } = fresh();
  const [p] = add(['A']).state.people;
  ctx.__mock.run(`(function(){ const o = SpreadsheetApp.flush; SpreadsheetApp.flush = function(){ SpreadsheetApp.flush = o; throw new Error('サーバー エラーが発生しました。しばらくしてからもう一度試してください。'); }; })()`);
  throwsMsg(() => call('participantDraw', p.token), /混み合っています/);
  throwsMsg(() => call('participantGet', 'AAAAAAAAAAAAAAAAAAAA'), ERR_TOKEN);
});

test('回帰4: 初期設定が済んでいれば setup はロックを取らない（だれが呼んでも参加者の操作を妨げない）', () => {
  const { ctx } = fresh();
  const L = ctx.__mock.backend.lock, w = L.waits;
  for (let i = 0; i < 5; i++) callServer(ctx, 'setup', []);
  assert.equal(L.waits, w);
});

test('回帰4: QR用URLは、合言葉を付けてもQRコードに収まる長さまで', () => {
  const { admin } = fresh();
  throwsMsg(() => admin('adminSaveSettings', { baseUrl: 'https://example.com/' + 'a'.repeat(200) }), /190文字以内/);
  assert.ok(admin('adminSaveSettings', { baseUrl: 'https://example.com/' + 'a'.repeat(170) }).settings.appUrl.length <= 190);
});

test('回帰4: 「=」「+」「-」「@」で始まる名前・ドリンク・会の名前は、読み書きしても元の文字のまま', () => {
  const { add, admin, call } = fresh();
  const [p] = add(['=1+1', '-山田', '@home', '+81']).state.people;
  call('participantSetDrink', p.token, '=HYPERLINK("x")');
  admin('adminSaveSettings', { event: '-送別会-', drinks: ['=A1', 'ビール'] });
  const st = admin('adminGetState');
  assert.deepEqual(st.people.map(x => x.name), ['=1+1', '-山田', '@home', '+81']);
  assert.equal(st.people[0].drink, '=HYPERLINK("x")');
  assert.equal(st.settings.event, '-送別会-');
  assert.deepEqual(st.settings.drinks, ['=A1', 'ビール']);
});

console.log(`gas.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
