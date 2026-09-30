'use strict';
// GAS 版の通しテスト（Playwright / Chromium）。
// gas/Code.gs を test/gas-mock.cjs で Node 上に動かし、doGet が返す HTML を小さな HTTP サーバーで配信します。
// ページには偽の google.script（url.getLocation / run）を入れ、run の呼び出しは page.exposeFunction 経由で
// Node 側の公開関数（末尾「_」以外）に橋渡しします。実行: node test/gas-e2e.cjs
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createGasContext, callServer } = require('./gas-mock.cjs');

let playwright;
try { playwright = require('/opt/node22/lib/node_modules/playwright'); } catch (e) { playwright = require('playwright'); }

const SHOTS = process.env.SHOTS_DIR || '/tmp/claude-0/-home-user-seat-lottery/147f18ee-7494-58a3-a367-a902b44fa4fa/scratchpad/shots';
fs.mkdirSync(SHOTS, { recursive: true });

/* ---------- GAS（Node 側） ---------- */
const ctx = createGasContext();
ctx.setup();
const KEY = ctx.__mock.props.ADMIN_KEY;
assert.ok(typeof KEY === 'string' && KEY.length >= 24, 'setup() で ADMIN_KEY が作られる');
const calls = [];
const state = () => callServer(ctx, 'adminGetState', [KEY]);
const byName = name => { const p = state().people.find(x => x.name === name); assert.ok(p, name + ' が名簿にいる'); return p; };
// シート「参加者」の行（見出しを除く）をトークンで探す
const sheetRow = token => {
  const rows = ctx.__mock.values('参加者');
  const r = rows.slice(1).find(x => String(x[1]) === token);
  assert.ok(r, 'シートに行がある: ' + token);
  return { name: r[2], kind: r[3], seat: r[4] === '' ? null : Number(r[4]), drink: r[5] === '' ? null : String(r[5]), drawnAt: r[6], drinkAt: r[7] };
};

/* ---------- 配信サーバー（doGet を呼ぶ） ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/exec') { res.writeHead(204); res.end(); return; }
  const parameter = {}, parameters = {};
  for (const [k, v] of u.searchParams) { if (!(k in parameter)) parameter[k] = v; (parameters[k] = parameters[k] || []).push(v); }
  let out;
  try { out = ctx.doGet({ parameter, parameters, queryString: u.search.slice(1), contextPath: '', contentLength: -1 }); } catch (e) { res.writeHead(500); res.end(String(e && e.message)); return; }
  let html = out.getContent();
  // 実際の GAS は外側のページに viewport とタイトルを付けて iframe で表示する。ここでは同じ文書に入れる
  const meta = out.getMetaTags().map(m => '<meta name="' + m.getName() + '" content="' + m.getContent() + '">').join('');
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, h => h + meta) : meta + html;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-gas-title': encodeURIComponent(out.getTitle()) });
  res.end(html);
});

// ページ側の偽 google.script。run は非同期（実際の GAS 同様、呼び出し後に別タスクで結果が返る）
const FAKE_GOOGLE = `(() => {
  const loc = () => { const parameter = {}, parameters = {}; for (const [k, v] of new URLSearchParams(location.search)) { if (!(k in parameter)) parameter[k] = v; (parameters[k] = parameters[k] || []).push(v); } return { parameter, parameters, hash: '' }; };
  const mk = (ok, ng, user) => new Proxy({}, { get(_, p) {
    if (p === 'withSuccessHandler') return h => mk(h, ng, user);
    if (p === 'withFailureHandler') return h => mk(ok, h, user);
    if (p === 'withUserObject') return o => mk(ok, ng, o);
    if (typeof p !== 'string' || p === 'then' || p === 'toJSON') return undefined;
    return (...args) => {
      const json = JSON.stringify(args); // 実際の GAS と同じく、オブジェクトの undefined のプロパティは送られない
      setTimeout(() => {
        window.__gasCall(p, json).then(r => setTimeout(() => {
          if (r.ok) { if (ok) ok(r.result === undefined ? undefined : JSON.parse(r.result), user); }
          // 実際の GAS（V8）ではメッセージの先頭に「Error: 」が付いて届くことがあるので、画面側で取り除けているかを確かめるため付けておく
          else if (ng) { const e = new Error('Error: ' + r.message); e.name = 'ScriptError'; ng(e, user); }
          else console.warn('unhandled GAS failure: ' + r.message);
        }, 30 + Math.floor(Math.random() * 60)));
      }, 0);
    };
  } });
  window.google = { script: { run: mk(null, null, undefined), url: { getLocation: cb => setTimeout(() => cb(loc()), 0) }, host: { close() {}, setHeight() {}, setWidth() {}, editor: {} }, history: { push() {}, replace() {}, setChangeHandler() {} } } };
})();`;

/* ---------- ブラウザまわり ---------- */
const problems = [];
const faults = [];
let base;
async function newPage(browser, label, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await context.exposeFunction('__gasCall', async (name, argsJson) => {
    calls.push({ label, name });
    // 障害の再現：{ label?, name, mode: 'fail'（実行せず失敗）| 'lost'（実行したが返事が失われる）| 'hang'（返事が来ない）| 'delay' | 'delayfail'（待ってから失敗）| 'late'（実行してから返事が遅れる）, message?, ms? }
    const i = faults.findIndex(f => f.name === name && (!f.label || f.label === label));
    const f = i >= 0 ? faults.splice(i, 1)[0] : null;
    if (f && f.mode === 'fail') return { ok: false, message: f.message || 'NetworkError: Connection failure due to HTTP 0' };
    if (f && f.mode === 'hang') return new Promise(() => {});
    if (f && f.mode === 'delay') await new Promise(r => setTimeout(r, f.ms || 1500));
    if (f && f.mode === 'delayfail') { await new Promise(r => setTimeout(r, f.ms || 1500)); return { ok: false, message: 'NetworkError: Connection failure due to HTTP 0' }; }
    try {
      const result = callServer(ctx, name, JSON.parse(argsJson));
      if (f && f.mode === 'late') await new Promise(r => setTimeout(r, f.ms || 1500)); // 読んだあと、返事だけ遅れる
      if (f && f.mode === 'lost') return { ok: false, message: f.message || 'NetworkError: Connection failure due to HTTP 0' };
      return { ok: true, result: result === undefined ? undefined : JSON.stringify(result) };
    } catch (e) { return { ok: false, message: e.message }; }
  });
  await context.addInitScript(FAKE_GOOGLE);
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning' && /unhandled GAS/.test(m.text())) problems.push(label + ' console.' + m.type() + ': ' + m.text()); });
  page.on('pageerror', e => problems.push(label + ' pageerror: ' + e.message));
  page.on('requestfailed', r => problems.push(label + ' requestfailed: ' + r.url()));
  page.on('dialog', d => { problems.push(label + ' unexpected native dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  page.setDefaultTimeout(8000);
  return page;
}
const open = (page, params) => page.goto(base + '/exec?' + new URLSearchParams(params).toString());
const shot = (page, name, fullPage = true) => page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage });
const noHScroll = async (page, label) => {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(sw <= iw, label + ': 横スクロールが出ない (scrollWidth ' + sw + ' > ' + iw + ')');
};
const text = (page, sel) => page.locator(sel).innerText();
// 幹事画面：通信が終わってステータスに文言が出るまで待つ
async function waitStatus(page, re) { await page.waitForFunction(r => new RegExp(r).test(document.getElementById('status').textContent), re.source); }

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(['ok', name]); console.log('ok   ' + name + ' (' + (Date.now() - t0) + 'ms)'); }
  catch (e) { results.push(['NG', name]); console.log('NG   ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n     ')); throw e; }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch();
  let failed = false;
  try {
    const LOTTERY = ['山田 太郎', '鈴木 花子', '佐藤 次郎', '田中 美咲', '高橋 健'];
    const FIXED = '部長 伊藤';
    let admin;

    await step('1) 幹事画面：読み込み・名簿登録・会の名前と席数・QR表示', async () => {
      admin = await newPage(browser, 'admin-pc', { width: 1280, height: 900 });
      await open(admin, { admin: KEY });
      await admin.locator('#view-drinks').waitFor({ state: 'visible' });
      assert.equal(await admin.title(), '席くじ 幹事画面');
      assert.match(await text(admin, '#drinkrows'), /まだ名簿がありません/);
      await admin.click('#tab-setup');
      await admin.locator('#view-setup').waitFor({ state: 'visible' });
      // くじを引く方 5 名（改行・読点・カンマ混在）
      await admin.fill('#bulk', LOTTERY.slice(0, 3).join('\n') + '、' + LOTTERY[3] + ',' + LOTTERY[4]);
      await admin.check('input[name=bulkkind][value=lottery]');
      await admin.click('#bulkadd');
      await admin.waitForFunction(() => /5人を名簿に追加しました/.test(document.getElementById('bulkstate').textContent));
      // 固定席 1 名
      await admin.fill('#bulk', FIXED);
      await admin.check('input[name=bulkkind][value=fixed]');
      await admin.click('#bulkadd');
      await admin.waitForFunction(() => /1人を名簿に追加しました/.test(document.getElementById('bulkstate').textContent));
      // 重複はスキップされる
      await admin.fill('#bulk', LOTTERY[0]);
      await admin.check('input[name=bulkkind][value=lottery]');
      await admin.click('#bulkadd');
      await admin.locator('#errortext').filter({ hasText: '追加できる方がいませんでした' }).waitFor();
      await admin.click('#errorclose');
      // 会の名前・席数
      await admin.fill('#event', '送別会');
      await admin.click('#eventsave');
      await waitStatus(admin, /会の名前を保存しました/);
      await admin.fill('#seats', '8');
      await admin.click('#seatssave');
      await waitStatus(admin, /抽選席を8席にしました/);
      // 範囲外の席数はサーバーで拒否され、赤いバーに出る
      await admin.fill('#seats', '100');
      await admin.click('#seatssave');
      await admin.locator('#error').waitFor({ state: 'visible' });
      assert.match(await text(admin, '#errortext'), /^抽選席数は/, 'エラー文の先頭の「Error: 」は取り除いて表示');
      await admin.click('#errorclose');
      await admin.fill('#seats', '8');

      const st = state();
      assert.equal(st.people.length, 6);
      assert.deepEqual(st.people.map(p => p.name), [...LOTTERY, FIXED]);
      assert.deepEqual(st.people.map(p => p.kind), ['lottery', 'lottery', 'lottery', 'lottery', 'lottery', 'fixed']);
      assert.equal(st.settings.event, '送別会');
      assert.equal(st.settings.seats, 8);
      const settingsSheet = Object.fromEntries(ctx.__mock.values('設定').map(r => [r[0], r[1]]));
      assert.equal(String(settingsSheet.event), '送別会');
      assert.equal(Number(settingsSheet.seats), 8);
      assert.equal(ctx.__mock.values('参加者').length, 7, '見出し＋6行');
      await admin.locator('#eventhead').filter({ hasText: '送別会' }).waitFor();
      await noHScroll(admin, 'admin-pc setup');
      await shot(admin, 'admin-setup');
      await admin.click('#tab-drinks');
      assert.match(await admin.locator('#drinkrows tr', { hasText: FIXED }).innerText(), /固定/);
      assert.match(await text(admin, '#drinktotal'), /名簿 6人（抽選席 5人・固定席 1人）/);

      // QR タブ → QR表示ダイアログ
      await admin.click('#tab-qr');
      await admin.locator('#view-qr').waitFor({ state: 'visible' });
      assert.equal(await admin.locator('#qrurlwarn').isHidden(), true, 'appUrl があるので警告は出ない');
      assert.equal(await text(admin, '#qrevent'), '送別会');
      const target = byName(LOTTERY[0]);
      await admin.locator('#qrrows tr', { hasText: LOTTERY[0] }).getByRole('button', { name: /QRコードを表示/ }).click();
      await admin.locator('#qrdialog[open] #qrbox svg').waitFor({ state: 'visible' });
      const link = await admin.inputValue('#qrlink');
      assert.ok(link.includes('?t='), 'リンクに ?t= が入る: ' + link);
      assert.equal(link, 'https://script.google.com/macros/s/TESTDEPLOY/exec?t=' + target.token);
      assert.equal(await admin.getAttribute('#qropen', 'href'), link + '&preview=1', '幹事が試しに開いても、その端末に覚えない');
      const box = await admin.locator('#qrbox svg').boundingBox();
      assert.ok(box.width >= 180, 'QR が大きく表示される (' + box.width + 'px)');
      assert.match(await text(admin, '#qrtitle'), /山田 太郎/);
      await shot(admin, 'admin-qr-dialog', false);
      await admin.click('#qrclose');
      await admin.locator('#qrdialog').waitFor({ state: 'hidden' });
    });

    let lot, part;
    await step('2) 参加者画面：くじを引く→番号表示→ドリンク登録（メニュー・その他）→再読込で復元', async () => {
      lot = byName(LOTTERY[0]);
      part = await newPage(browser, 'participant', { width: 390, height: 844 });
      await open(part, { t: lot.token });
      await part.locator('#draw').waitFor({ state: 'visible' });
      assert.equal(await part.title(), '席くじ');
      assert.equal(await text(part, '#name'), LOTTERY[0] + ' さん');
      assert.match(await text(part, '#intro'), /送別会/);
      assert.equal(await part.locator('#drinkbox').isHidden(), true, '席が決まるまでドリンク欄は出ない');
      await noHScroll(part, 'participant before');
      await shot(part, 'participant-before');

      const t0 = Date.now();
      await part.click('#draw');
      await part.locator('#number.rolling').waitFor({ state: 'visible', timeout: 1000 });
      assert.equal(await part.locator('#resulthint').isHidden(), true, '演出中は結果の案内を出さない');
      await part.locator('#resulthint').waitFor({ state: 'visible', timeout: 6000 });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 1400, '演出は最低1.5秒 (' + elapsed + 'ms)');
      const shown = Number((await text(part, '#number')).replace(/\D/g, ''));
      const row = sheetRow(lot.token);
      assert.ok(Number.isInteger(row.seat) && row.seat >= 1 && row.seat <= 8, 'シートに席が入る: ' + row.seat);
      assert.equal(shown, row.seat, '画面の番号とシートの席番号が一致');
      assert.match(String(row.drawnAt), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.equal(await text(part, '#name2'), LOTTERY[0] + ' さんのお席');
      assert.equal(await part.locator('#number.pop').count(), 1, '確定時に pop');
      // 読み上げ：回っている数字は読まず、結果だけを知らせる
      assert.equal(await part.locator('#number[aria-live]').count(), 0);
      assert.equal(await part.locator('#number[aria-hidden]').count(), 0, '確定後は番号を読める');
      assert.equal(await part.locator('#announce').textContent(), LOTTERY[0] + ' さんのお席は ' + shown + '番 です。');
      assert.equal(calls.filter(c => c.label === 'participant' && c.name === 'participantDraw').length, 1, 'サーバーの抽選は1回だけ');
      await part.locator('#drinkbox').waitFor({ state: 'visible' });
      await part.waitForTimeout(500); // pop が終わってから撮る
      await shot(part, 'participant-result');

      // メニューから選ぶ
      await part.locator('#drinklist button', { hasText: /^ハイボール$/ }).click();
      await part.locator('#drinkmsg.ok').filter({ hasText: '「ハイボール」で登録しました' }).waitFor();
      assert.equal(sheetRow(lot.token).drink, 'ハイボール');
      assert.match(String(sheetRow(lot.token).drinkAt), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.equal(await part.locator('#drinklist button.sel').innerText(), 'ハイボール');
      await noHScroll(part, 'participant drink');
      await shot(part, 'participant-drink');

      // その他（全角英数も NFKC で正規化して保存。Enter で決定）
      await part.click('#otherbtn');
      await part.locator('#otherinput').waitFor({ state: 'visible' });
      await part.fill('#otherinput', '  ジンジャーエール　ＺＥＲＯ ');
      await part.press('#otherinput', 'Enter');
      await part.locator('#drinkmsg.ok').filter({ hasText: '「ジンジャーエール ZERO」で登録しました' }).waitFor();
      assert.equal(sheetRow(lot.token).drink, 'ジンジャーエール ZERO');
      assert.equal(await part.locator('#otherform').isHidden(), true);
      assert.match(await part.locator('#otherbtn').innerText(), /その他：ジンジャーエール ZERO/);

      // 再読込 → 席とドリンクがサーバーから復元（くじボタンは出ない）
      const seat = sheetRow(lot.token).seat;
      await part.reload();
      await part.locator('#result').waitFor({ state: 'visible' });
      assert.equal(await part.locator('#intro').isHidden(), true);
      assert.equal(Number((await text(part, '#number')).replace(/\D/g, '')), seat);
      await part.locator('#drinkbox').waitFor({ state: 'visible' });
      assert.match(await part.locator('#otherbtn.sel').innerText(), /ジンジャーエール ZERO/);
      assert.match(await text(part, '#drinkmsg'), /「ジンジャーエール ZERO」で登録済みです/);

      // もう一度演出を見る（幹事が席を空きに戻していないかを確かめるため、読み込みだけをする）
      const before = calls.length;
      await part.click('#again');
      await part.locator('#number.rolling').waitFor({ state: 'visible', timeout: 1000 });
      await part.locator('#again').waitFor({ state: 'visible', timeout: 4000 });
      assert.equal(Number((await text(part, '#number')).replace(/\D/g, '')), seat);
      assert.deepEqual(calls.slice(before).map(c => c.name), ['participantGet'], '演出の見直しでは読み込みだけ（くじは引き直さない）');

      // 未定も登録できる
      await part.locator('#drinklist button', { hasText: 'あとで決める（未定）' }).click();
      await part.locator('#drinkmsg.ok').filter({ hasText: '「未定」で登録しました' }).waitFor();
      assert.equal(sheetRow(lot.token).drink, '未定');
      await part.locator('#drinklist button', { hasText: /^ハイボール$/ }).click();
      await part.locator('#drinkmsg.ok').filter({ hasText: '「ハイボール」で登録しました' }).waitFor();

      // 末尾「_」の関数はクライアントから呼べない（実際の GAS と同じ）
      const priv = await part.evaluate(() => window.__gasCall('load_', '[]'));
      assert.equal(priv.ok, false);

      // 間違ったトークン → エラー表示
      const bad = await newPage(browser, 'participant-bad', { width: 390, height: 844 });
      await open(bad, { t: 'WRONGTOKEN1234567890' });
      await bad.locator('#bad').waitFor({ state: 'visible' });
      assert.match(await text(bad, '#badmsg'), /^QRコードが無効です/);
      assert.equal(await bad.locator('#draw').isVisible(), false);
      assert.equal(await bad.locator('#drinkbox').isHidden(), true);
      await shot(bad, 'participant-badtoken');
      await bad.context().close();
    });

    await step('2b) 2人目：くじ→ビール（席が重ならない）', async () => {
      const p2 = byName(LOTTERY[1]);
      const pg = await newPage(browser, 'participant2', { width: 390, height: 844 });
      await open(pg, { t: p2.token });
      await pg.click('#draw');
      await pg.locator('#resulthint').waitFor({ state: 'visible', timeout: 6000 });
      const seat = Number((await text(pg, '#number')).replace(/\D/g, ''));
      assert.equal(seat, sheetRow(p2.token).seat);
      assert.notEqual(seat, sheetRow(lot.token).seat, '席が重ならない');
      await pg.locator('#drinklist button', { hasText: /^ビール$/ }).click();
      await pg.locator('#drinkmsg.ok').waitFor();
      assert.equal(sheetRow(p2.token).drink, 'ビール');
      await pg.context().close();
    });

    await step('3) 固定席の方：くじボタンなし・ドリンクは登録できる', async () => {
      const f = byName(FIXED);
      const pg = await newPage(browser, 'participant-fixed', { width: 390, height: 844 });
      await open(pg, { t: f.token });
      await pg.locator('#fixed').waitFor({ state: 'visible' });
      assert.match(await text(pg, '#fixedname'), /部長 伊藤 さんは\s*固定席\s*です/);
      assert.equal(await pg.locator('#draw').isVisible(), false, 'くじボタンは出ない');
      await pg.locator('#drinkbox').waitFor({ state: 'visible' });
      await pg.locator('#drinklist button', { hasText: /^ウーロン茶$/ }).click();
      await pg.locator('#drinkmsg.ok').filter({ hasText: '「ウーロン茶」で登録しました' }).waitFor();
      const row = sheetRow(f.token);
      assert.equal(row.drink, 'ウーロン茶');
      assert.equal(row.seat, null);
      await noHScroll(pg, 'participant fixed');
      await shot(pg, 'participant-fixed');
      await pg.context().close();
    });

    await step('3b) くじの画面を開いている間に固定席に変わった → くじを押すと固定席の画面に切り替わる', async () => {
      const p4 = byName(LOTTERY[3]);
      const pg = await newPage(browser, 'participant-switch', { width: 390, height: 844 });
      await open(pg, { t: p4.token });
      await pg.locator('#draw').waitFor({ state: 'visible' });
      callServer(ctx, 'adminUpdatePerson', [KEY, p4.id, { kind: 'fixed' }]);
      await pg.click('#draw');
      await pg.locator('#fixed').waitFor({ state: 'visible', timeout: 6000 });
      await pg.locator('#drinkbox').waitFor({ state: 'visible' });
      assert.equal(await pg.locator('#draw').isVisible(), false);
      // QR を作り直された → 無効の画面に切り替わる
      callServer(ctx, 'adminUpdatePerson', [KEY, p4.id, { kind: 'lottery' }]);
      await open(pg, { t: p4.token });
      await pg.locator('#draw').waitFor({ state: 'visible' });
      callServer(ctx, 'adminReissueToken', [KEY, p4.id]);
      await pg.click('#draw');
      await pg.locator('#bad').waitFor({ state: 'visible', timeout: 6000 });
      assert.match(await text(pg, '#badmsg'), /^QRコードが無効です/);
      await pg.context().close();
      assert.equal(byName(LOTTERY[3]).kind, 'lottery'); assert.equal(byName(LOTTERY[3]).seat, null);
    });

    await step('4) 幹事画面：ドリンク一覧・集計に反映／代わりに引く', async () => {
      await admin.click('#tab-drinks');
      await admin.click('#refresh');
      await admin.locator('#drinkrows').filter({ hasText: 'ウーロン茶' }).waitFor();
      const rowsText = await text(admin, '#drinkrows');
      for (const s of [LOTTERY[0], 'ハイボール', LOTTERY[1], 'ビール', FIXED, 'ウーロン茶']) assert.ok(rowsText.includes(s), '一覧に「' + s + '」');
      const sm = state().summary;
      assert.equal(sm.total, 6); assert.equal(sm.none, 3); assert.equal(sm.undecided, 0);
      assert.equal(sm.seated, 2); assert.equal(sm.seatsLeft, 6);
      const count = async name => Number((await admin.locator('#drinkcounts .drinkcount', { has: admin.locator('span', { hasText: new RegExp('^' + name + '$') }) }).locator('strong').innerText()).replace(/\D/g, ''));
      assert.equal(await count('ビール'), 1);
      assert.equal(await count('ハイボール'), 1);
      assert.equal(await count('ウーロン茶'), 1);
      assert.equal(await count('コーラ'), 0);
      assert.equal(await count('未登録'), 3);
      assert.equal(await count('合計'), 6);
      assert.match(await text(admin, '#drinktotal'), /注文が決まったドリンク 3杯/);
      // 席の列：席番号順で、表示が一致
      const mySeat = sheetRow(lot.token).seat;
      assert.match(await admin.locator('#drinkrows tr', { hasText: LOTTERY[0] }).innerText(), new RegExp('^\\s*' + mySeat + '\\b'));
      // 未登録の方だけ
      await admin.check('#onlynone');
      const onlyText = await text(admin, '#drinkrows');
      assert.ok(!onlyText.includes(LOTTERY[0]) && onlyText.includes(LOTTERY[2]), '未登録の方だけに絞れる');
      await admin.uncheck('#onlynone');
      await admin.locator('#updatedtext').filter({ hasText: /最終更新/ }).waitFor();
      // 自動更新で表が描き直されても、キーボードの位置（修正ボタン）は失われない
      const p2id = byName(LOTTERY[1]).id;
      await admin.locator('#drinkrows tr', { hasText: LOTTERY[1] }).getByRole('button', { name: /修正/ }).focus();
      await admin.evaluate(() => refresh(false));
      await admin.waitForTimeout(300);
      assert.equal(await admin.evaluate(() => document.activeElement && document.activeElement.dataset.fk), 'd:edit:' + p2id);
      await shot(admin, 'admin-drinks');

      // 代わりに引く（確認ダイアログ → OK）
      await admin.click('#tab-qr');
      await admin.locator('#qrrows tr', { hasText: LOTTERY[2] }).getByRole('button', { name: /代わりにくじを引く/ }).click();
      await admin.locator('#askdialog[open]').waitFor();
      await admin.click('#askyes');
      await waitStatus(admin, /佐藤 次郎さんの席は \d+番 です/);
      const s3 = sheetRow(byName(LOTTERY[2]).token).seat;
      assert.ok(s3 >= 1 && s3 <= 8);
      assert.match(await admin.locator('#qrrows tr', { hasText: LOTTERY[2] }).innerText(), new RegExp(s3 + '番'));
      assert.equal(await admin.evaluate(() => document.activeElement && document.activeElement.dataset.fk), 'q:show:' + byName(LOTTERY[2]).id, '代わりに引いたあと、同じ方の「QR表示」にフォーカス');
      assert.equal(new Set(state().people.filter(p => p.seat != null).map(p => p.seat)).size, 3, '席の重複なし');
    });

    await step('5) ドリンクの受付をオフ → 参加者は締め切り表示', async () => {
      // 参加者画面を開いたままにしておき、締め切り後に選ぼうとすると締め切り表示に切り替わる
      await part.reload();
      await part.locator('#drinklist button', { hasText: /^ビール$/ }).waitFor();
      await admin.click('#tab-drinks');
      await admin.locator('#view-drinks .drinkopen').click();
      await waitStatus(admin, /ドリンクの受付を締め切りました/);
      assert.equal(state().settings.drinkOpen, false);
      assert.equal(await admin.locator('#view-drinks .drinkopen').getAttribute('aria-checked'), 'false');

      await part.locator('#drinklist button', { hasText: /^ビール$/ }).click();
      await part.locator('#drinkclosed').waitFor({ state: 'visible' });
      assert.equal(sheetRow(lot.token).drink, 'ハイボール', '締め切り後は変わらない');
      assert.equal(await text(part, '#drinkcurrent'), 'ハイボール');
      await part.reload();
      await part.locator('#result').waitFor({ state: 'visible' });
      await part.locator('#drinkclosed').waitFor({ state: 'visible' });
      assert.equal(await part.locator('#drinkopen').isHidden(), true, 'ドリンクのボタンは出ない');
      assert.match(await text(part, '#drinkbox'), /ドリンクの受付は締め切りました[\s\S]*ハイボール/);
      await shot(part, 'participant-closed');

      // 受付を再開すると選べる
      await admin.locator('#view-drinks .drinkopen').click();
      await waitStatus(admin, /ドリンクの受付を再開しました/);
      await part.reload();
      await part.locator('#drinklist button', { hasText: /^ビール$/ }).waitFor();
    });

    await step('6) 合言葉が違う → 案内ページ（幹事画面は出ない）', async () => {
      const pg = await newPage(browser, 'admin-wrong', { width: 390, height: 844 });
      for (const params of [{ admin: KEY + 'x' }, { admin: '' }, {}]) {
        await open(pg, params);
        await pg.getByText('受付でお渡ししたQRコードを読み取ってください').waitFor();
        assert.equal(await pg.locator('#tab-drinks').count(), 0);
        assert.ok(!/幹事/.test(await pg.content()), '幹事画面の存在を示唆しない');
      }
      // サーバー API も合言葉が違えば拒否
      const r = await pg.evaluate(() => window.__gasCall('adminGetState', JSON.stringify(['wrong-key'])));
      assert.deepEqual(r, { ok: false, message: '幹事用の合言葉が違います。' });
      await shot(pg, 'landing');
      await pg.context().close();
    });

    await step('7) 幹事画面（スマホ幅 390×844）', async () => {
      const pg = await newPage(browser, 'admin-mobile', { width: 390, height: 844 });
      await open(pg, { admin: KEY });
      await pg.locator('#drinkrows').filter({ hasText: 'ハイボール' }).waitFor();
      await noHScroll(pg, 'admin-mobile drinks');
      await shot(pg, 'admin-mobile');
      for (const tab of ['qr', 'setup']) {
        await pg.click('#tab-' + tab);
        await pg.locator('#view-' + tab).waitFor({ state: 'visible' });
        await noHScroll(pg, 'admin-mobile ' + tab);
      }
      await shot(pg, 'admin-mobile-setup');
      await pg.click('#tab-qr');
      await pg.locator('#qrrows tr', { hasText: FIXED }).getByRole('button', { name: /QRコードを表示/ }).click();
      await pg.locator('#qrdialog[open] #qrbox svg').waitFor({ state: 'visible' });
      assert.ok((await pg.inputValue('#qrlink')).endsWith('?t=' + byName(FIXED).token));
      await noHScroll(pg, 'admin-mobile qr dialog');
      await shot(pg, 'admin-mobile-qr', false);
      await pg.context().close();
    });

    await step('8) 全員共通のQR：名前を選ぶ→くじ→ドリンク／同じスマホは再読込で戻る／別のスマホからは選べない', async () => {
      // 幹事画面：共通QRが表示される
      await admin.click('#tab-qr');
      await admin.locator('#joinqr svg').waitFor({ state: 'visible' });
      const joinUrl = await admin.inputValue('#joinlink');
      assert.equal(joinUrl, state().settings.joinUrl);
      assert.match(joinUrl, /^https:\/\/script\.google\.com\/macros\/s\/TESTDEPLOY\/exec\?j=[A-Za-z0-9]{12}$/);
      assert.equal(await admin.getAttribute('#joinopenlink', 'href'), joinUrl);
      await shot(admin, 'admin-join');
      const code = joinUrl.split('?j=')[1];
      const claimedBefore = state().people.filter(p => p.claimedAt).map(p => p.name);
      assert.ok(claimedBefore.includes(LOTTERY[0]) && claimedBefore.includes(FIXED), '個別QRで使った方は受付済み');
      const who = state().people.find(p => p.kind === 'lottery' && !p.claimedAt);
      assert.ok(who, 'まだ受付していない方がいる');

      // 1台目のスマホ
      const ph = await newPage(browser, 'join-phone1', { width: 390, height: 844 });
      await open(ph, { j: code });
      await ph.locator('#join').waitFor({ state: 'visible' });
      assert.match(await text(ph, '#join'), /送別会[\s\S]*お名前を選んでください/);
      // 個別QRで受付した方は選べない（押すと、個別のQR・リンクから開くよう案内だけが出る）
      for (const n of claimedBefore) {
        await ph.locator('#joinlist button', { hasText: n }).click();
        await ph.locator('#joinerr').filter({ hasText: '「' + n + '」さんは、個別のQRコード（またはLINEなどで届いたリンク）ですでに受付済みです' }).waitFor();
        assert.equal(await ph.evaluate(() => document.activeElement.id), 'joinerr', '案内にフォーカスが移る');
        assert.equal(await ph.locator('#confirm').isHidden(), true, n + ' は受付済みで選べない');
      }
      assert.match(await ph.locator('#joinlist button', { hasText: LOTTERY[0] }).innerText(), /受付済み/);
      await shot(ph, 'join-list');
      await ph.fill('#joinsearch', who.name.slice(0, 2));
      assert.equal(await ph.locator('#joinlist button').count() >= 1, true);
      await ph.locator('#joinlist button', { hasText: who.name }).click();
      await ph.locator('#confirm').waitFor({ state: 'visible' });
      assert.equal(await text(ph, '#confirmname'), who.name + ' さん');
      await shot(ph, 'join-confirm');
      await ph.click('#confirmyes');
      await ph.waitForFunction(() => !document.getElementById('intro').hidden || !document.getElementById('result').hidden);
      if (await ph.locator('#intro').isVisible()) {
        assert.equal(await text(ph, '#name'), who.name + ' さん');
        await ph.click('#draw');
      }
      await ph.locator('#resulthint').waitFor({ state: 'visible' });
      const seat = state().people.find(p => p.id === who.id).seat;
      assert.ok(seat >= 1);
      assert.equal((await text(ph, '#number')).replace(/\s/g, ''), seat + '番');
      await ph.locator('#drinklist button', { hasText: /^レモンサワー$/ }).click();
      await ph.locator('#drinkmsg').filter({ hasText: '「レモンサワー」で登録しました' }).waitFor();
      assert.equal(sheetRow(who.token).drink, 'レモンサワー');
      assert.ok(state().people.find(p => p.id === who.id).claimedAt);
      assert.equal(await ph.locator('#switchperson').isVisible(), true);
      await shot(ph, 'join-result');
      // 同じスマホで読み直すと、名前選びを飛ばしてそのまま戻る
      await ph.reload();
      await ph.locator('#resulthint').waitFor({ state: 'visible' });
      assert.equal(await ph.locator('#join').isHidden(), true);

      // 2台目のスマホ：受付済みなので選べない
      const ph2 = await newPage(browser, 'join-phone2', { width: 390, height: 844 });
      await open(ph2, { j: code });
      await ph2.locator('#join').waitFor({ state: 'visible' });
      assert.equal(await ph2.locator('#joinlist button', { hasText: who.name }).isDisabled(), true);
      // 画面を開いたまま他のスマホが先に受付した場合 → 選ぶとエラーで一覧に戻る
      const other = state().people.find(p => !p.claimedAt);
      if (other) {
        callServer(ctx, 'joinClaim', [code, other.id, 'OtherPhoneKey0000000']); // ほかのスマホ（確認キーを送る）
        await ph2.locator('#joinlist button', { hasText: other.name }).click();
        await ph2.click('#confirmyes');
        await ph2.locator('#joinerr').filter({ hasText: 'すでに受付済み' }).waitFor();
        assert.equal(await ph2.locator('#joinlist button', { hasText: other.name }).isDisabled(), true);
      }
      // 幹事が「受付をやり直す」→ 2台目から選べる。1台目は取り消しを知らせて一覧に戻る
      await admin.click('#tab-drinks');
      await admin.locator('#drinkrows tr', { hasText: who.name }).getByRole('button', { name: /修正/ }).click();
      await admin.locator('#editdialog[open]').waitFor();
      await admin.locator('#releasewrap').waitFor({ state: 'visible' }); // 開いたときに最新の状態を読み直して表示される
      await admin.check('#editrelease');
      await admin.click('#editform button[type=submit]');
      await waitStatus(admin, /修正しました/);
      assert.equal(state().people.find(p => p.id === who.id).claimedAt, null);
      // 1台目は取り消されたことを知らせて、名前の一覧に戻る
      await ph.reload();
      await ph.locator('#joinerr').filter({ hasText: '使えなくなりました' }).waitFor();
      await ph2.reload();
      await ph2.locator('#joinlist button', { hasText: who.name }).click();
      await ph2.click('#confirmyes');
      await ph2.locator('#resulthint').waitFor({ state: 'visible' });
      assert.equal((await text(ph2, '#number')).replace(/\s/g, ''), seat + '番', '席は変わらない');
      // 「ほかの方の受付をする」で一覧に戻る
      await ph2.click('#switchperson');
      await ph2.locator('#join').waitFor({ state: 'visible' });
      // 共通QRを作り直すと古いQRは使えない
      await admin.click('#tab-qr');
      await admin.click('#joinreset');
      await admin.click('#askyes');
      await waitStatus(admin, /共通QRコードを作り直しました/);
      assert.notEqual(await admin.inputValue('#joinlink'), joinUrl);
      // 受付済みのスマホは、古いQR・新しいQRのどちらから開いても自分の画面に戻れる
      await ph2.reload();
      await ph2.locator('#resulthint').waitFor({ state: 'visible' });
      assert.equal(await text(ph2, '#name2'), who.name + ' さんのお席');
      const newCode = (await admin.inputValue('#joinlink')).split('?j=')[1];
      await open(ph2, { j: newCode });
      await ph2.locator('#resulthint').waitFor({ state: 'visible' });
      assert.equal(await ph2.locator('#mylinkbox').isVisible(), true, '自分専用のリンクを案内する');
      assert.match(await ph2.getAttribute('#mylink', 'href'), new RegExp('\\?t=' + state().people.find(p => p.id === who.id).token + '$'));
      // まだ受付していないスマホでは、古い共通QRは使えない
      const ph3 = await newPage(browser, 'join-phone3', { width: 390, height: 844 });
      await open(ph3, { j: code });
      await ph3.locator('#bad').waitFor({ state: 'visible' });
      assert.match(await text(ph3, '#badmsg'), /QRコードが無効/);
      await noHScroll(ph2, 'join phone');
      await ph.context().close(); await ph2.context().close(); await ph3.context().close();
    });

    await step('9) 参加者画面の障害・競合：通信エラーの自動やり直し・返事の消失・無応答・演出中の切り替え・すばやい2回タップ', async () => {
      callServer(ctx, 'adminSaveSettings', [KEY, { seats: 30, joinOpen: true, drinkOpen: true }]);
      callServer(ctx, 'adminAddPeople', [KEY, ['障害 一郎', '障害 二郎', '障害 三郎', '障害 四郎'], 'lottery']);
      const code = state().settings.joinUrl.split('?j=')[1];
      const pg = await newPage(browser, 'fault', { width: 390, height: 844 });
      await pg.addInitScript(() => { window.__SEKI_TIMEOUT_MS = 2500; });
      // (a) 英語の通信エラー（NetworkError）は自動でやり直し、利用者には英語を見せない
      faults.push({ label: 'fault', name: 'joinList', mode: 'fail' });
      await open(pg, { j: code });
      await pg.locator('#join').waitFor({ state: 'visible', timeout: 15000 });
      // (b) すばやい2回タップでも確認なしで受付されない
      await pg.locator('#joinlist button', { hasText: '障害 一郎' }).dblclick();
      await pg.locator('#confirm').waitFor({ state: 'visible' });
      assert.equal(state().people.find(p => p.name === '障害 一郎').claimedAt, null, '2回目のタップで受付されない');
      // (c) 受付は済んだが返事が失われた → 同じスマホの確認キーで自動やり直し → そのまま受付できる
      faults.push({ label: 'fault', name: 'joinClaim', mode: 'lost' });
      await pg.waitForTimeout(600);
      await pg.click('#confirmyes');
      await pg.locator('#intro').waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await text(pg, '#name'), '障害 一郎 さん');
      // (d) くじの途中で通信エラー → 自動でやり直して席が出る（英語は出ない）
      faults.push({ label: 'fault', name: 'participantDraw', mode: 'lost', message: 'Exception: Service Spreadsheets timed out while accessing document with id 1abc.' });
      await pg.click('#draw');
      await pg.locator('#resulthint').waitFor({ state: 'visible', timeout: 15000 });
      const seat1 = state().people.find(p => p.name === '障害 一郎').seat;
      assert.equal((await text(pg, '#number')).replace(/\s/g, ''), seat1 + '番');
      // (e) ドリンク保存の返事が来ない → 少し待つと通信エラーを表示し、ボタンはまた押せる
      faults.push({ label: 'fault', name: 'participantSetDrink', mode: 'hang' });
      await pg.locator('#drinklist button', { hasText: /^ビール$/ }).click();
      await pg.locator('#drinkmsg.ng').waitFor({ timeout: 8000 });
      assert.match(await text(pg, '#drinkmsg'), /通信に失敗しました/);
      assert.equal(await pg.locator('#drinklist button', { hasText: /^ビール$/ }).isEnabled(), true);
      await pg.locator('#drinklist button', { hasText: /^コーラ$/ }).click();
      await pg.locator('#drinkmsg.ok').waitFor();
      // (f) 「もう一度演出を見る」の途中で「ほかの方の受付をする」→ 一覧のまま（前の人の画面が上から出ない・エラーなし）
      await pg.click('#again');
      await pg.click('#switchperson');
      await pg.locator('#join').waitFor({ state: 'visible' });
      await pg.waitForTimeout(1800);
      assert.equal(await pg.locator('#join').isVisible(), true, '演出のタイマーが一覧を上書きしない');
      assert.equal(await pg.locator('#result').isHidden(), true);
      // (g) 一覧に「このスマホで受付済み」として出て、押すと戻れる
      const mine = pg.locator('#joinlist button', { hasText: '障害 一郎' });
      assert.match(await mine.innerText(), /このスマホで受付済み/);
      await mine.click();
      await pg.locator('#resulthint').waitFor({ state: 'visible' });
      // (h) 幹事が席を空きに戻したあとドリンクを変えると、画面もくじを引く前に戻る
      const id1 = state().people.find(p => p.name === '障害 一郎').id;
      callServer(ctx, 'adminUpdatePerson', [KEY, id1, { clearSeat: true }]);
      await pg.locator('#drinklist button', { hasText: /^ビール$/ }).click();
      await pg.locator('#intro').waitFor({ state: 'visible' });
      assert.equal(await pg.locator('#drinkbox').isHidden(), true);
      // (i) 前の方の入力・エラー表示が次の方に残らない
      await pg.click('#draw');
      await pg.locator('#resulthint').waitFor({ state: 'visible' });
      await pg.click('#otherbtn');
      await pg.fill('#otherinput', '前の人のメモ');
      callServer(ctx, 'adminUpdatePerson', [KEY, id1, { releaseClaim: true }]);
      await pg.locator('#drinklist button', { hasText: /^ビール$/ }).click();
      await pg.locator('#joinerr').filter({ hasText: '使えなくなりました' }).waitFor();
      await pg.locator('#joinlist button', { hasText: '障害 二郎' }).click();
      await pg.waitForTimeout(600);
      await pg.click('#confirmyes');
      await pg.click('#draw');
      await pg.locator('#resulthint').waitFor({ state: 'visible' });
      assert.equal(await text(pg, '#drinkmsg'), '');
      assert.equal(await pg.inputValue('#otherinput'), '');
      // (j) 名前の絞り込み：空白なし・ひらがな/カタカナ・全角英字
      callServer(ctx, 'adminAddPeople', [KEY, ['ヤマダ ハナ', 'Alice Smith'], 'lottery']);
      await pg.click('#switchperson');
      await pg.locator('#join').waitFor({ state: 'visible' });
      for (const [q, want] of [['やまだ', 'ヤマダ ハナ'], ['ｱﾘｽ', null], ['ＡＬＩＣＥ', 'Alice Smith'], ['alicesmith', 'Alice Smith'], ['障害二郎', '障害 二郎']]) {
        await pg.fill('#joinsearch', q);
        const names = await pg.locator('#joinlist button span:first-child').allInnerTexts();
        if (want) assert.ok(names.includes(want), q + ' → ' + names.join(','));
        else assert.equal(names.length, 0, q + ' → ' + names.join(','));
      }
      await pg.context().close();
    });

    await step('10) 幹事画面の競合：修正画面の最新化・削除済みの方・保存中の入力・遅れた失敗・検索・プロジェクター表示', async () => {
      const pg = await newPage(browser, 'admin-race', { width: 1280, height: 900 });
      await open(pg, { admin: KEY });
      await pg.locator('#view-drinks').waitFor({ state: 'visible' });
      callServer(ctx, 'adminAddPeople', [KEY, ['競合 花子', 'tanaka Taro'], 'lottery']);
      await pg.click('#refresh'); await waitStatus(pg, /最新の状態/);
      // (a) 開く直前に参加者がドリンクを登録 → 修正画面は最新のドリンクを表示し、「未登録」に戻せる
      const hk = state().people.find(p => p.name === '競合 花子');
      callServer(ctx, 'participantSetDrink', [hk.token, 'ビール']);
      await pg.locator('#drinkrows tr', { hasText: '競合 花子' }).getByRole('button', { name: /修正/ }).click();
      await pg.waitForFunction(() => document.getElementById('editdrink').value === 'm:ビール');
      await pg.selectOption('#editdrink', '');
      await pg.click('#editform button[type=submit]');
      await waitStatus(pg, /修正しました/);
      assert.equal(state().people.find(p => p.name === '競合 花子').drink, null);
      // (b) 開いている間に削除された → 画面を閉じて知らせる
      await pg.locator('#drinkrows tr', { hasText: '競合 花子' }).getByRole('button', { name: /修正/ }).click();
      await pg.locator('#editdialog[open]').waitFor();
      callServer(ctx, 'adminDeletePerson', [KEY, hk.id]);
      // 開いたときの読み直しで、削除済みと分かって先に閉じていることもある
      if (await pg.locator('#editdialog').evaluate(d => d.open)) await pg.click('#editcancel', { timeout: 2000 }).catch(() => {});
      await pg.click('#refresh');
      await pg.locator('#drinkrows tr', { hasText: '競合 花子' }).waitFor({ state: 'detached' });
      // (c) 保存中に書き足した会の名前は消えない
      await pg.click('#tab-setup');
      faults.push({ label: 'admin-race', name: 'adminSaveSettings', mode: 'delay', ms: 800 });
      await pg.fill('#event', '送別会');
      await pg.click('#eventsave');
      await pg.locator('#event').press('End');
      await pg.locator('#event').pressSequentially(' 2026');
      await waitStatus(pg, /会の名前を保存しました/);
      assert.equal(await pg.inputValue('#event'), '送別会 2026', '保存中の入力が残る');
      assert.equal(await pg.locator('#eventsave').evaluate(b => b.classList.contains('dirty')), true, '未保存の表示が残る');
      await pg.click('#eventsave'); await waitStatus(pg, /会の名前を保存しました/);
      await pg.fill('#event', '送別会'); await pg.click('#eventsave'); await waitStatus(pg, /会の名前を保存しました/);
      // (d) 英語の通信エラーは日本語で表示
      await pg.click('#tab-drinks');
      faults.push({ label: 'admin-race', name: 'adminGetState', mode: 'fail' });
      await pg.click('#refresh');
      await pg.locator('#error').waitFor({ state: 'visible' });
      assert.match(await text(pg, '#errortext'), /^通信に失敗しました/);
      await pg.click('#errorclose');
      // (e) 検索：大文字小文字・空白・「12 番」
      await pg.click('#tab-drinks');
      await pg.fill('#drinksearch', 'TANAKATARO');
      assert.match(await text(pg, '#drinkrows'), /tanaka Taro/);
      const seated = state().people.find(p => p.seat != null);
      await pg.fill('#drinksearch', seated.seat + ' 番');
      assert.match(await text(pg, '#drinkrows'), new RegExp(seated.name));
      await pg.fill('#drinksearch', '');
      // (f) 受付をやり直す のチェック欄で修正画面が横にはみ出さない（スマホ幅）
      await pg.setViewportSize({ width: 320, height: 700 });
      const claimedP = state().people.find(p => p.claimedAt);
      await pg.fill('#drinksearch', claimedP.name);
      await pg.locator('#drinkrows tr', { hasText: claimedP.name }).getByRole('button', { name: /修正/ }).click();
      await pg.locator('#releasewrap').waitFor({ state: 'visible' });
      const [sw, cw] = await pg.locator('#editdialog').evaluate(d => [d.scrollWidth, d.clientWidth]);
      assert.ok(sw <= cw, '修正画面が横にはみ出さない ' + sw + '/' + cw);
      await pg.keyboard.press('Escape');
      await pg.setViewportSize({ width: 1280, height: 900 });
      await pg.fill('#drinksearch', '');
      // (g) プロジェクター用の表示は別のタブで開き、合言葉を含まない
      await pg.click('#tab-qr');
      const [popup] = await Promise.all([pg.context().waitForEvent('page'), pg.click('#joinshow')]);
      await popup.waitForLoadState();
      assert.equal(popup.url().includes(KEY), false);
      assert.equal(await popup.locator('svg').count(), 1);
      assert.match(await popup.locator('body').innerText(), /お名前を選んでください/);
      await popup.close();
      await pg.context().close();
    });

    await step('11) 第2回の回帰：受付済みの自分を押すと読み込み表示・保存後のフォーカス・取り消し後の絞り込み・QR画面の状態更新・確認中の削除', async () => {
      callServer(ctx, 'adminAddPeople', [KEY, ['回帰 春子', '回帰 夏子'], 'lottery']);
      const code = state().settings.joinUrl.split('?j=')[1];
      const pg = await newPage(browser, 'r2p', { width: 390, height: 844 });
      await open(pg, { j: code });
      await pg.locator('#join').waitFor({ state: 'visible' });
      await pg.fill('#joinsearch', '春子');
      await pg.locator('#joinlist button', { hasText: '回帰 春子' }).click();
      await pg.waitForTimeout(600);
      await pg.click('#confirmyes');
      await pg.locator('#intro').waitFor({ state: 'visible' });
      await pg.click('#switchperson');
      await pg.locator('#join').waitFor({ state: 'visible' });
      // (a) 自分（このスマホで受付済み）を押すと、すぐ読み込み表示になり、ほかの名前は押せない
      faults.push({ label: 'r2p', name: 'joinClaim', mode: 'delay', ms: 1200 });
      await pg.locator('#joinlist button', { hasText: '回帰 春子' }).click();
      assert.equal(await pg.locator('#loading').isVisible(), true);
      await pg.locator('#intro').waitFor({ state: 'visible' });
      assert.equal(await text(pg, '#name'), '回帰 春子 さん');
      // (b) ドリンクを保存したあとも、押したボタンにフォーカスが残る
      await pg.click('#draw');
      await pg.locator('#resulthint').waitFor({ state: 'visible' });
      await pg.locator('#drinklist button', { hasText: /^ビール$/ }).focus();
      await pg.keyboard.press('Enter');
      await pg.locator('#drinkmsg.ok').waitFor();
      assert.equal(await pg.evaluate(() => document.activeElement.textContent), 'ビール');
      // (c) 受付を取り消されて一覧に戻ったとき、前の方の絞り込みは消えている
      const id = state().people.find(p => p.name === '回帰 春子').id;
      callServer(ctx, 'adminUpdatePerson', [KEY, id, { releaseClaim: true }]);
      await pg.locator('#drinklist button', { hasText: /^コーラ$/ }).click();
      await pg.locator('#joinerr').filter({ hasText: '使えなくなりました' }).waitFor();
      assert.equal(await pg.inputValue('#joinsearch'), '');
      assert.ok((await pg.locator('#joinlist button').count()) > 2);
      await pg.context().close();

      // 幹事画面
      const ad = await newPage(browser, 'r2a', { width: 1280, height: 900 });
      await open(ad, { admin: KEY });
      await ad.locator('#view-drinks').waitFor({ state: 'visible' });
      await ad.click('#tab-qr');
      // (d) QR画面を開いた直後に届いた最新の状態で「状態／ドリンク」も更新される
      const nk = state().people.find(p => p.name === '回帰 夏子');
      callServer(ctx, 'participantDraw', [nk.token]);
      callServer(ctx, 'participantSetDrink', [nk.token, 'ハイボール']);
      await ad.locator('#qrrows tr', { hasText: '回帰 夏子' }).getByRole('button', { name: /QRコードを表示/ }).click();
      await ad.locator('#qrsub').filter({ hasText: 'ハイボール' }).waitFor();
      assert.match(await text(ad, '#qrsub'), /受付済み/);
      // (e) 「QRを作り直す」の確認中にほかの端末で削除 → 確認画面も閉じ、何も送らない
      await ad.click('#qrreissue');
      await ad.locator('#askdialog[open]').waitFor();
      callServer(ctx, 'adminDeletePerson', [KEY, nk.id]);
      await ad.evaluate(() => refresh(false));
      await ad.locator('#askdialog').waitFor({ state: 'hidden' });
      assert.equal(await ad.locator('#qrdialog').isVisible(), false);
      assert.equal(await ad.locator('#error').isVisible(), false, 'エラーを出さない');
      await ad.context().close();
    });

    await step('12) 第3回の回帰：幹事画面の無応答で固まらない・長い英字でスマホ幅がはみ出さない', async () => {
      const pg = await newPage(browser, 'r3a', { width: 360, height: 740 });
      await pg.addInitScript(() => { window.__SEKI_TIMEOUT_MS = 2000; });
      await open(pg, { admin: KEY });
      await pg.locator('#view-drinks').waitFor({ state: 'visible' });
      faults.push({ label: 'r3a', name: 'adminSaveSettings', mode: 'hang' });
      await pg.locator('#view-drinks .drinkopen').click();
      await pg.locator('#error').waitFor({ state: 'visible', timeout: 6000 });
      assert.match(await text(pg, '#errortext'), /通信に失敗しました/);
      await pg.waitForFunction(() => !document.body.classList.contains('busy'));
      assert.equal(await pg.locator('#refresh').isEnabled(), true, '操作できる状態に戻る');
      await pg.click('#errorclose');
      // 長い英字（空白なし）の会の名前・お名前・ドリンク
      const W = n => 'W'.repeat(n);
      callServer(ctx, 'adminSaveSettings', [KEY, { event: W(40) }]);
      callServer(ctx, 'adminAddPeople', [KEY, [W(60)], 'lottery']);
      const lp = state().people.find(p => p.name === W(60));
      callServer(ctx, 'participantSetDrink', [lp.token, W(30)]);
      await pg.click('#refresh'); await waitStatus(pg, /最新の状態/);
      for (const tab of ['drinks', 'qr', 'setup']) { await pg.click('#tab-' + tab); await noHScroll(pg, 'long ' + tab); }
      await pg.click('#tab-qr');
      await pg.locator('#qrrows tr', { hasText: W(60) }).getByRole('button', { name: /QRコードを表示/ }).click();
      await pg.locator('#qrdialog[open]').waitFor();
      const [a1, b1] = await pg.locator('#qrdialog').evaluate(d => [d.scrollWidth, d.clientWidth]);
      assert.ok(a1 <= b1, 'QR画面が横にはみ出さない ' + a1 + '/' + b1);
      await pg.click('#qrclose');
      callServer(ctx, 'adminSaveSettings', [KEY, { event: '送別会' }]);
      callServer(ctx, 'adminDeletePerson', [KEY, lp.id]);
      await pg.context().close();
    });

    await step('13) 卓分け：卓を設定→参加者は「A卓 3番」→固定席の卓指定→卓ごとの配膳（画面・印刷・CSV）', async () => {
      const pg = await newPage(browser, 'tables-admin', { width: 1280, height: 900 });
      await pg.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
      await open(pg, { admin: KEY });
      await pg.locator('#view-drinks').waitFor({ state: 'visible' });
      assert.equal(await pg.locator('#tablesummary').isHidden(), true, '卓が無いときは卓ごとの配膳は出ない');
      await pg.click('#tab-setup');
      await pg.fill('#tables', 'A卓 10\nB卓 10\nC卓：10');
      await pg.click('#tablessave');
      await waitStatus(pg, /卓の設定を保存しました/);
      assert.equal(await pg.inputValue('#tables'), 'A卓 10\nB卓 10\nC卓 10', '整えた形で表示');
      assert.equal(await pg.locator('#seats').isDisabled(), true, '席数は卓の合計になるので入力できない');
      assert.match(await text(pg, '#tablesstate'), /3卓・合計 30席/);
      assert.deepEqual(state().settings.tables.map(t => t.name), ['A卓', 'B卓', 'C卓']);
      // 固定席の方の卓を修正画面で指定
      await pg.click('#tab-drinks');
      await pg.locator('#drinkrows tr', { hasText: FIXED }).getByRole('button', { name: /修正/ }).click();
      await pg.locator('#edittablewrap').waitFor({ state: 'visible' });
      await pg.selectOption('#edittable', 'B卓');
      await pg.click('#editform button[type=submit]');
      await waitStatus(pg, /修正しました/);
      assert.equal(state().people.find(p => p.name === FIXED).table, 'B卓');
      // 参加者：くじで「◯卓 ◯番」
      callServer(ctx, 'adminAddPeople', [KEY, ['卓 太郎'], 'lottery']);
      const tp = state().people.find(p => p.name === '卓 太郎');
      const ph = await newPage(browser, 'tables-phone', { width: 390, height: 844 });
      await open(ph, { t: tp.token });
      await ph.locator('#draw').waitFor({ state: 'visible' });
      await ph.click('#draw');
      await ph.waitForTimeout(400);
      assert.match(await text(ph, '#tablename'), /^[ABC]卓$/, '演出中も卓の名前が回る');
      await ph.locator('#resulthint').waitFor({ state: 'visible' });
      const me = state().people.find(p => p.name === '卓 太郎');
      assert.equal(await text(ph, '#tablename'), me.table);
      assert.equal((await text(ph, '#number')).replace(/\s/g, ''), me.tableSeat + '番');
      assert.equal(await ph.locator('#announce').textContent(), '卓 太郎 さんのお席は ' + me.table + ' ' + me.tableSeat + '番 です。');
      await ph.locator('#drinklist button', { hasText: /^ビール$/ }).click();
      await ph.locator('#drinkmsg.ok').waitFor();
      await noHScroll(ph, 'tables phone');
      await shot(ph, 'participant-table');
      // 固定席の方のスマホ：「お席：B卓」
      const fx = await newPage(browser, 'tables-fixed', { width: 390, height: 844 });
      await open(fx, { t: state().people.find(p => p.name === FIXED).token });
      await fx.locator('#fixedtable').filter({ hasText: 'お席：B卓' }).waitFor();
      // 幹事：卓ごとの配膳
      await pg.click('#tab-drinks');
      await pg.click('#refresh'); await waitStatus(pg, /最新の状態/);
      await pg.locator('#tablesummary').waitFor({ state: 'visible' });
      const card = pg.locator('.tcard', { has: pg.locator('h4', { hasText: me.table }) });
      assert.match(await card.innerText(), /ビール \d+/);
      assert.match(await card.innerText(), /卓 太郎/);
      const bcard = pg.locator('.tcard', { has: pg.locator('h4', { hasText: 'B卓' }) });
      assert.match(await bcard.innerText(), new RegExp(FIXED));
      // 表の数字とサーバーの状態が一致
      const st = state();
      for (const t of st.settings.tables) {
        const inT = st.people.filter(p => p.table === t.name);
        const beer = inT.filter(p => p.drink === 'ビール').length;
        const txt = await pg.locator('.tcard', { has: pg.locator('h4', { hasText: t.name }) }).innerText();
        if (beer) assert.match(txt, new RegExp('ビール ' + beer + '(\\D|$)'), t.name + ' のビール数');
        const fx = inT.filter(p => p.kind === 'fixed').length;
        assert.match(txt, new RegExp((inT.length - fx) + ' / ' + t.seats + '席' + (fx ? ' ＋固定' + fx + '人' : '')));
      }
      assert.match(await text(pg, '#drinkrows'), new RegExp(me.table + ' ' + me.tableSeat + '番'));
      await shot(pg, 'admin-tables');
      // 検索「a卓」で A卓の方だけ
      await pg.fill('#drinksearch', 'a卓');
      const shownSeats = await pg.locator('#drinkrows td.seat').allInnerTexts();
      assert.ok(shownSeats.length && shownSeats.every(x => /A卓/.test(x)), shownSeats.join(','));
      // 卓の中の番号（見えている番号）でも探せる
      await pg.fill('#drinksearch', String(me.tableSeat));
      assert.match(await text(pg, '#drinkrows'), /卓 太郎/);
      await pg.fill('#drinksearch', '');
      // 代わりに引く：「◯卓 ◯番」で知らせる
      callServer(ctx, 'adminAddPeople', [KEY, ['卓 花子'], 'lottery']);
      await pg.click('#tab-qr'); await pg.click('#refresh').catch(() => {});
      await pg.evaluate(() => refresh(true)); await waitStatus(pg, /最新の状態/);
      await pg.locator('#qrrows tr', { hasText: '卓 花子' }).getByRole('button', { name: /代わりに/ }).click();
      await pg.click('#askyes');
      await waitStatus(pg, /卓 花子さんの席は [ABC]卓 \d+番 です/);
      await pg.click('#tab-drinks');
      // 印刷：卓ごとの配膳表
      await pg.click('#tableprint');
      assert.equal(await pg.evaluate(() => window.__printed), 1);
      assert.equal(await pg.locator('#printsheet').getAttribute('class'), 'tables');
      assert.ok((await pg.locator('#printsheet .tsec').count()) >= 3);
      // CSV に卓の列
      const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#csv')]);
      const csv = fs.readFileSync(await dl.path(), 'utf8');
      assert.match(csv.split('\r\n')[0], /"卓","卓内の席","席番号"/);
      assert.ok(csv.includes('"' + me.table + '","' + me.tableSeat + '"'));
      // スマホ幅でもはみ出さない
      await pg.setViewportSize({ width: 360, height: 740 });
      await noHScroll(pg, 'admin tables 360');
      for (const c of [pg, ph, fx]) await c.context().close();
    });

    await step('14) 総点検の回帰：保存失敗後・次の方・その他のEnter・演出の見直しのフォーカス／古い読み込みで失敗の表示が消えない／保存中に書き足したお名前／固定席の隠れた番号で検索に出ない', async () => {
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: true, joinOpen: true }]);
      callServer(ctx, 'adminAddPeople', [KEY, ['焦点 一郎', '焦点 二郎'], 'lottery']);
      const code = state().settings.joinUrl.split('?j=')[1];
      const ph = await newPage(browser, 'focus-phone', { width: 390, height: 844 });
      const focused = () => ph.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'BODY' : (a.id || a.dataset.key || a.tagName); });
      await open(ph, { j: code });
      await ph.locator('#join').waitFor({ state: 'visible' });
      await ph.locator('#joinlist button', { hasText: '焦点 一郎' }).click();
      await ph.click('#confirmyes');
      await ph.locator('#intro').waitFor({ state: 'visible' });
      await ph.click('#draw');
      await ph.locator('#again').waitFor({ state: 'visible', timeout: 15000 });
      // (a) その他を入力して Enter で保存 → 「その他」のボタンにフォーカスが戻る
      await ph.click('#otherbtn'); await ph.fill('#otherinput', 'ジンジャーエール'); await ph.press('#otherinput', 'Enter');
      await ph.waitForFunction(() => /登録しました/.test(document.getElementById('drinkmsg').textContent));
      assert.equal(await focused(), 'otherbtn', 'Enter で保存しても、その他のボタンに戻る');
      // (b) 保存に失敗 → 押したボタンに戻り、覚えたフォーカスは残らない
      for (let i = 0; i < 4; i++) faults.push({ label: 'focus-phone', name: 'participantSetDrink', mode: 'fail' });
      await ph.focus('[data-key="m:ビール"]'); await ph.keyboard.press('Enter');
      await ph.waitForFunction(() => /通信に失敗/.test(document.getElementById('drinkmsg').textContent), null, { timeout: 20000 });
      assert.equal(await focused(), 'm:ビール', '失敗したら押したボタンへ戻る');
      assert.equal(await ph.evaluate(() => savedFocus), '');
      // (c) もう一度演出を見る → 終わったら同じボタンへ
      await ph.focus('#again'); await ph.keyboard.press('Enter');
      await ph.waitForFunction(() => !document.getElementById('again').hidden, null, { timeout: 5000 });
      await ph.waitForFunction(() => document.activeElement === document.getElementById('again'), null, { timeout: 3000 });
      // (d) 失敗のあと「ほかの方の受付をする」→ 次の方の画面で、前の方のドリンクのボタンにフォーカスが行かない
      for (let i = 0; i < 4; i++) faults.push({ label: 'focus-phone', name: 'participantSetDrink', mode: 'fail' });
      await ph.focus('[data-key="m:ビール"]'); await ph.keyboard.press('Enter');
      await ph.waitForFunction(() => /通信に失敗/.test(document.getElementById('drinkmsg').textContent), null, { timeout: 20000 });
      await ph.evaluate(() => { savedFocus = 'm:ビール'; }); // 失敗の直後に次の方へ替わった場合と同じ状態
      await ph.click('#switchperson');
      await ph.locator('#join').waitFor({ state: 'visible' });
      await ph.locator('#joinlist button', { hasText: '焦点 二郎' }).click();
      await ph.click('#confirmyes');
      await ph.locator('#intro').waitFor({ state: 'visible' });
      callServer(ctx, 'adminDrawOne', [KEY, byName('焦点 二郎').id]);
      await ph.evaluate(() => load());
      await ph.locator('#result').waitFor({ state: 'visible' });
      await ph.waitForTimeout(200);
      assert.ok(!(await ph.evaluate(() => document.getElementById('drinklist').contains(document.activeElement))), '次の方のドリンクのボタンにフォーカスが行かない: ' + await focused());
      assert.equal(await ph.evaluate(() => savedFocus), '');
      assert.equal(byName('焦点 二郎').drink, null);
      await ph.context().close();

      const pg = await newPage(browser, 'sweep-admin', { width: 1280, height: 900 });
      await open(pg, { admin: KEY });
      await pg.locator('#view-drinks').waitFor({ state: 'visible' });
      // (e) 修正画面を開いたときの読み込みが、同じ名前での保存の失敗より後に届いても、失敗の表示は消えない
      faults.push({ label: 'sweep-admin', name: 'adminGetState', mode: 'delay', ms: 1500 });
      await pg.locator('#drinkrows tr', { hasText: '焦点 二郎' }).getByRole('button', { name: /修正/ }).click();
      await pg.fill('#editname', '焦点 一郎');
      await pg.click('#editform button[type=submit]');
      await pg.locator('#editerror').waitFor({ state: 'visible' });
      assert.match(await text(pg, '#editerror'), /すでに名簿にあります/);
      await pg.waitForTimeout(2000); // 遅らせた読み込みが届くまで待つ
      assert.equal(faults.filter(f => f.label === 'sweep-admin').length, 0, '遅らせた読み込みは使われた');
      assert.equal(await pg.locator('#editerror').isVisible(), true, '修正画面の失敗の表示が残る');
      assert.equal(await pg.locator('#error').isVisible(), true);
      await pg.click('#editcancel');
      await pg.click('#refresh'); await waitStatus(pg, /最新の状態/);
      assert.equal(await pg.locator('#error').isVisible(), false, 'あとから始めた読み込みでは消える');
      // (f) 名簿に追加：保存中に書き足したお名前は消えない
      await pg.click('#tab-setup');
      faults.push({ label: 'sweep-admin', name: 'adminAddPeople', mode: 'delay', ms: 1200 });
      await pg.fill('#bulk', '追加 一郎\n追加 二郎');
      await pg.click('#bulkadd');
      await pg.fill('#bulk', '追加 一郎\n追加 二郎\n追加 三郎');
      await pg.waitForFunction(() => /2人を名簿に追加しました/.test(document.getElementById('bulkstate').textContent), null, { timeout: 8000 });
      assert.equal(await pg.inputValue('#bulk'), '追加 三郎', '送っていないお名前は残る');
      assert.ok(!state().people.some(p => p.name === '追加 三郎'));
      await pg.click('#bulkadd');
      await waitStatus(pg, /1人を名簿に追加しました/);
      assert.equal(await pg.inputValue('#bulk'), '');
      // (g) 卓があるとき、番号で探しても、見えていない「固定席N」で固定席の方が出ない
      await pg.click('#tab-drinks');
      // くじの結果によっては「◯卓 1番」の方がいないので、いなければシートで1番の方を作ってから探します
      if (!state().people.some(p => p.tableSeat === 1)) {
        const free = [1, 11, 21].find(n => !state().people.some(p => p.seat === n)), t = byName('追加 一郎').token;
        ctx.__mock.sheet('参加者').getRange(ctx.__mock.values('参加者').findIndex(r => String(r[1]) === t) + 1, 5).setValue(free);
        await pg.evaluate(() => { document.getElementById('status').textContent = ''; });
        await pg.click('#refresh'); await waitStatus(pg, /最新の状態/);
      }
      await pg.fill('#drinksearch', '1');
      const rows = await pg.locator('#drinkrows tr:has(td)').allInnerTexts();
      assert.ok(rows.length >= 1);
      for (const r of rows) assert.ok(r.includes('1'), '見えている文字に 1 がある行だけ: ' + r);
      assert.ok(!rows.some(r => r.includes(FIXED)), '固定席の方（卓あり）は出ない');
      await pg.fill('#drinksearch', '');
      await pg.context().close();
    });

    await step('15) 総点検 第2回の回帰：持ち主の画面に戻る・保存できないときの古いトークン・エラー時のフォーカス・遅れたドリンク保存／確認後の操作が消えない・卓の番号で検索・配膳の集計・入力エラー・印刷・卓の言葉・QRの作り直し', async () => {
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: true, joinOpen: true, tables: 'A卓 30\nB卓 30\nC卓 30' }]);
      callServer(ctx, 'adminAddPeople', [KEY, ['持ち主 太郎', '友人 花子', '遅延 三郎', '確認 四郎', '検索 五郎'], 'lottery']);
      const code = state().settings.joinUrl.split('?j=')[1];
      // (a) 「ほかの方の受付をする」で友人を受付したあと、持ち主が共通QRを読み直すと持ち主の画面に戻る
      const ph = await newPage(browser, 'r2-phone', { width: 390, height: 844 });
      await ph.addInitScript(() => { window.__SEKI_TIMEOUT_MS = 2000; });
      const focused = () => ph.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'BODY' : (a.id || a.tagName); });
      const pick = async name => {
        await ph.locator('#joinlist button', { hasText: name }).click();
        await ph.waitForFunction(() => !document.getElementById('confirmyes').disabled);
        await ph.click('#confirmyes');
        await ph.locator('#intro').waitFor({ state: 'visible' });
      };
      await open(ph, { j: code });
      await ph.locator('#join').waitFor({ state: 'visible' });
      await pick('持ち主 太郎');
      await ph.click('#switchperson');
      await ph.locator('#join').waitFor({ state: 'visible' });
      await pick('友人 花子');
      await open(ph, { j: code });
      await ph.locator('#intro').waitFor({ state: 'visible' });
      assert.equal(await text(ph, '#name'), '持ち主 太郎 さん', '持ち主の画面に戻る');
      await ph.click('#switchperson');
      await ph.locator('#join').waitFor({ state: 'visible' });
      assert.match(await ph.locator('#joinlist button', { hasText: '友人 花子' }).innerText(), /このスマホで受付済み/, '友人は一覧から開ける');
      // (b) 保存できないときは古いトークンを残さない
      assert.equal(await ph.evaluate(() => { const o = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); }; try { remember('ABCDEFGHabcdefgh1234'); } finally { Storage.prototype.setItem = o; } return localStorage.getItem('sekikuji.join.token'); }), null);
      // (c) くじのエラー（席なし）のあと、読み直しも失敗したら「もう一度くじを引く」にフォーカスが戻る
      await ph.evaluate(() => localStorage.removeItem('sekikuji.join.token'));
      await open(ph, { j: code });
      await ph.locator('#join').waitFor({ state: 'visible' });
      await pick('遅延 三郎');
      faults.push({ label: 'r2-phone', name: 'participantDraw', mode: 'fail', message: '空いている席がありません。受付にお声がけください。' });
      faults.push({ label: 'r2-phone', name: 'participantGet', mode: 'hang' });
      await ph.focus('#draw'); await ph.keyboard.press('Enter');
      await ph.waitForFunction(() => !document.getElementById('draw').disabled && !document.getElementById('drawerr').hidden, null, { timeout: 10000 });
      assert.equal(await focused(), 'draw');
      // (d) 遅れて届いた古いドリンクの保存は、あとで選んだドリンクを上書きしない
      await ph.click('#draw');
      await ph.locator('#resulthint').waitFor({ state: 'visible', timeout: 10000 });
      faults.push({ label: 'r2-phone', name: 'participantSetDrink', mode: 'delay', ms: 3500 });
      await ph.locator('#drinklist button', { hasText: /^ビール$/ }).click();
      await ph.locator('#drinkmsg.ng').waitFor({ timeout: 8000 });
      await ph.locator('#drinklist button', { hasText: /^ハイボール$/ }).click();
      await ph.locator('#drinkmsg.ok').waitFor();
      await ph.waitForTimeout(3000); // 遅らせた保存がサーバーで動くまで待つ
      assert.equal(faults.filter(f => f.label === 'r2-phone').length, 0);
      assert.equal(byName('遅延 三郎').drink, 'ハイボール', '古い保存で上書きされない');
      // (e) 「ほかの方の受付をする」の読み込みが時間切れ → 「もう一度読み込む」にフォーカス
      faults.push({ label: 'r2-phone', name: 'joinList', mode: 'hang' });
      await ph.focus('#switchperson'); await ph.keyboard.press('Enter');
      await ph.locator('#bad').waitFor({ state: 'visible', timeout: 8000 });
      assert.equal(await focused(), 'reload');
      await ph.context().close();

      const pg = await newPage(browser, 'r2-admin', { width: 1280, height: 900 });
      await pg.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
      await open(pg, { admin: KEY });
      await pg.locator('#view-drinks').waitFor({ state: 'visible' });
      const reload = async () => { await pg.click('#tab-drinks'); await pg.evaluate(() => ok('')); await pg.click('#refresh'); await waitStatus(pg, /最新の状態/); };
      // (f) 「更新」の読み込み中に確認の画面で OK を押しても、操作は消えない
      faults.push({ label: 'r2-admin', name: 'adminGetState', mode: 'delay', ms: 1200 });
      await pg.evaluate(() => { refresh(false); });
      await pg.click('#refresh'); // 自動更新の途中なので、終わってから読み直す
      await pg.click('#tab-qr');
      await pg.locator('#qrrows tr', { hasText: '確認 四郎' }).getByRole('button', { name: /代わりに/ }).click();
      await pg.locator('#askdialog[open]').waitFor();
      faults.push({ label: 'r2-admin', name: 'adminGetState', mode: 'delay', ms: 1200 });
      await pg.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await pg.click('#askyes');
      await waitStatus(pg, /確認 四郎さんの席は [ABC]卓 \d+番 です/);
      assert.ok(byName('確認 四郎').seat >= 1);
      // (g) 卓があるとき、隠れた通し番号（32）では探せない（見えている「B卓 2番」では探せる）
      const kg = byName('検索 五郎');
      const sh = ctx.__mock.sheet('参加者');
      const rowOf = token => ctx.__mock.values('参加者').findIndex(r => String(r[1]) === token) + 1;
      state().people.filter(p => p.seat === 32).forEach(p => callServer(ctx, 'adminUpdatePerson', [KEY, p.id, { clearSeat: true }]));
      sh.getRange(rowOf(kg.token), 5).setValue(32);
      sh.getRange(rowOf(kg.token), 6).setValue('ﾋﾞｰﾙ');
      await reload();
      await pg.fill('#drinksearch', '32');
      assert.ok(!(await text(pg, '#drinkrows')).includes('検索 五郎'), '通し番号 32 では出ない');
      await pg.fill('#drinksearch', 'b卓2');
      assert.match(await text(pg, '#drinkrows'), /検索 五郎/);
      await pg.fill('#drinksearch', '');
      // (h) 卓ごとの配膳は、集計と同じくシートの「ﾋﾞｰﾙ」を「ビール」として数える
      const bcard = await pg.locator('.tcard', { has: pg.locator('h4', { hasText: 'B卓' }) }).innerText();
      assert.ok(!bcard.includes('ﾋﾞｰﾙ'), bcard);
      assert.match(bcard, /ビール \d+/);
      // (i) 修正画面の入力エラーは、開いたときの読み込みが遅れて届いても消えない
      faults.push({ label: 'r2-admin', name: 'adminGetState', mode: 'delay', ms: 1200 });
      await pg.locator('#drinkrows tr', { hasText: '検索 五郎' }).getByRole('button', { name: /修正/ }).click();
      await pg.selectOption('#editdrink', 'other');
      await pg.fill('#editother', '   ');
      await pg.click('#editform button[type=submit]');
      await pg.locator('#editerror').filter({ hasText: 'ドリンク名を入力してください' }).waitFor();
      await pg.waitForTimeout(1600);
      assert.equal(faults.filter(f => f.label === 'r2-admin').length, 0);
      assert.equal(await pg.locator('#editerror').isVisible(), true, '入力エラーが残る');
      await pg.click('#editcancel');
      // (j) ブラウザのメニューで印刷すると、いまの画面が出る（前に作った印刷用の紙面は出ない）
      await pg.emulateMedia({ media: 'print' });
      const printView = () => pg.evaluate(() => [getComputedStyle(document.querySelector('main')).display, getComputedStyle(document.getElementById('printsheet')).display, document.getElementById('printsheet').children.length]);
      let [mainD, sheetD] = await printView();
      assert.notEqual(mainD, 'none'); assert.equal(sheetD, 'none');
      await pg.click('#tableprint');
      assert.equal(await pg.evaluate(() => window.__printed), 1);
      [mainD, sheetD] = await printView();
      assert.equal(mainD, 'none', '印刷ボタンの印刷中は紙面だけ'); assert.equal(sheetD, 'block');
      await pg.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      const after = await printView();
      assert.deepEqual([after[0] !== 'none', after[1], after[2]], [true, 'none', 0], '印刷が終わったら片付ける');
      await pg.emulateMedia({ media: 'screen' });
      // (k) 卓があるときの案内は「卓の設定」と「◯卓 ◯番」で
      await pg.click('#tab-setup');
      assert.match(await text(pg, '#seatsstate'), /いちばん後ろの席 [ABC]卓 \d+番（.+さん）/);
      assert.doesNotMatch(await text(pg, '#seatsstate'), /最大/);
      await pg.evaluate(() => { S.summary.lottery = S.settings.seats + 2; render(); });
      assert.match(await text(pg, '#warn'), /卓の設定で席数を増やす/);
      sh.getRange(rowOf(kg.token), 5).setValue('Z卓 1');
      await reload();
      assert.match(await text(pg, '#warn'), /席番号を読み取れない方がいます：検索 五郎さん（「Z卓 1」）/);
      assert.equal(sh.getRange(rowOf(kg.token), 5).getValue(), 'Z卓 1', '読み取れない値は消さない');
      // (l) QRを作り直すときに「席とドリンクも消す」を選べる。「この端末で開く」で試しても、この端末に覚えない
      const yk = byName('確認 四郎');
      callServer(ctx, 'adminUpdatePerson', [KEY, yk.id, { drink: 'ウーロン茶' }]);
      await reload(); await pg.click('#tab-qr');
      await pg.locator('#qrrows tr', { hasText: '確認 四郎' }).getByRole('button', { name: /QRコードを表示/ }).click();
      await pg.locator('#qrdialog[open]').waitFor();
      assert.match(await pg.getAttribute('#qropen', 'href'), /&preview=1$/);
      await pg.click('#qrreissue');
      await pg.locator('#askoptwrap').waitFor({ state: 'visible' });
      await pg.check('#askopt');
      await pg.click('#askyes');
      await waitStatus(pg, /QRコードを作り直しました/);
      const yk2 = byName('確認 四郎');
      assert.deepEqual([yk2.seat, yk2.drink], [null, null]);
      const href = await pg.getAttribute('#qropen', 'href');
      const tryer = await newPage(browser, 'r2-try', { width: 390, height: 844 });
      await tryer.goto(base + '/exec' + href.slice(href.indexOf('?')));
      await tryer.locator('#intro').waitFor({ state: 'visible' });
      await open(tryer, { j: code });
      await tryer.locator('#join').waitFor({ state: 'visible' });
      await tryer.context().close();
      await pg.click('#qrclose');
      await pg.context().close();
    });

    await step('16) 総点検 第3回の回帰：締め切られた保存のフォーカス・使えなくなった覚えたトークンの置き換え・引き直し後の演出・かなの検索・個別リンクで受付済みの案内・操作中の「更新」・席番号の重なりの注意', async () => {
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: true, joinOpen: true }]);
      callServer(ctx, 'adminAddPeople', [KEY, ['締切 一郎', '幹事 二郎', '引直 三郎', '重複 四郎', '重複 五郎', '来賓 六郎'], 'lottery']);
      callServer(ctx, 'adminUpdatePerson', [KEY, byName('来賓 六郎').id, { kind: 'fixed' }]);
      const code = state().settings.joinUrl.split('?j=')[1];
      const focusedOf = pg => pg.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'BODY' : (a.id || a.tagName); });
      // (a) ドリンクを保存しようとしたら締め切られていた → 締め切りの文にフォーカスが移る
      const ph = await newPage(browser, 'r3-phone', { width: 390, height: 844 });
      await open(ph, { t: byName('締切 一郎').token });
      await ph.click('#draw');
      await ph.locator('#resulthint').waitFor({ state: 'visible' });
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: false }]);
      await ph.locator('#drinklist button', { hasText: /^ビール$/ }).focus();
      await ph.keyboard.press('Enter');
      await ph.locator('#drinkclosed').waitFor({ state: 'visible' });
      await ph.waitForFunction(() => document.activeElement && document.activeElement.id === 'drinkclosedmsg');
      assert.equal(await ph.getAttribute('#drinkclosedmsg', 'role'), 'status');
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: true }]);
      // (b) 共通QRで試したあと「受付をやり直す」→ 同じスマホで自分の新しい個別QRを開くと、覚えるトークンが新しくなる
      assert.equal(await ph.evaluate(() => localStorage.getItem('sekikuji.join.token')), byName('締切 一郎').token, '個別QRで開いた最初の方を覚えている');
      await ph.evaluate(() => localStorage.removeItem('sekikuji.join.token'));
      await open(ph, { j: code });
      await ph.locator('#join').waitFor({ state: 'visible' });
      await ph.locator('#joinlist button', { hasText: '幹事 二郎' }).click();
      await ph.waitForFunction(() => !document.getElementById('confirmyes').disabled);
      await ph.click('#confirmyes');
      await ph.locator('#intro').waitFor({ state: 'visible' });
      const oldTok = await ph.evaluate(() => localStorage.getItem('sekikuji.join.token'));
      assert.equal(oldTok, byName('幹事 二郎').token);
      callServer(ctx, 'adminUpdatePerson', [KEY, byName('幹事 二郎').id, { releaseClaim: true }]);
      const newTok = byName('幹事 二郎').token;
      await open(ph, { t: newTok });
      await ph.locator('#intro').waitFor({ state: 'visible' });
      await ph.waitForFunction(t => localStorage.getItem('sekikuji.join.token') === t, newTok);
      await open(ph, { j: code });
      await ph.locator('#intro').waitFor({ state: 'visible' });
      assert.equal(await text(ph, '#name'), '幹事 二郎 さん', '共通QRからも自分の画面に戻れる');
      // (c) 幹事が「席を空きに戻す」→「もう一度演出を見る」で、古い席ではなく「くじを引く」が出る
      await open(ph, { t: byName('引直 三郎').token });
      await ph.click('#draw');
      await ph.locator('#again').waitFor({ state: 'visible' });
      callServer(ctx, 'adminUpdatePerson', [KEY, byName('引直 三郎').id, { clearSeat: true }]);
      await ph.click('#again');
      await ph.locator('#intro').waitFor({ state: 'visible' });
      assert.equal(await ph.locator('#draw').isEnabled(), true);
      assert.equal(byName('引直 三郎').seat, null);
      // (d) 共通QRの名前一覧：例は漢字。かなで見つからないときは漢字で試すよう案内する。個別リンクで受付した方は案内を出す
      await ph.evaluate(() => localStorage.removeItem('sekikuji.join.token'));
      await open(ph, { j: code });
      await ph.locator('#join').waitFor({ state: 'visible' });
      assert.match(await ph.getAttribute('#joinsearch', 'placeholder'), /例：山田/);
      await ph.fill('#joinsearch', 'ひきなお');
      assert.match(await text(ph, '#joinlist'), /該当するお名前がありません。[\s\S]*漢字の一部/);
      await ph.fill('#joinsearch', '引直');
      const linkBtn = ph.locator('#joinlist button', { hasText: '引直 三郎' });
      assert.equal(await linkBtn.isEnabled(), true);
      await linkBtn.click();
      await ph.locator('#joinerr').filter({ hasText: 'そのQRコード・リンクから開いてください' }).waitFor();
      assert.equal(await ph.locator('#confirm').isHidden(), true);
      await ph.context().close();

      // (e) 幹事画面：自動更新の途中で「更新」を押してから操作しても、操作の結果が画面に残る
      const pg = await newPage(browser, 'r3-admin', { width: 1280, height: 900 });
      await open(pg, { admin: KEY });
      await pg.locator('#view-drinks').waitFor({ state: 'visible' });
      assert.match(await pg.getAttribute('#drinksearch', 'placeholder'), /^例：山田／A卓 3$/, '卓があるときは「A卓 3」の形の例');
      await pg.fill('#drinksearch', 'ひきなお');
      assert.match(await text(pg, '#drinkrows'), /該当する方はいません。お名前が漢字のときは、漢字の一部/);
      await pg.fill('#drinksearch', '');
      faults.push({ label: 'r3-admin', name: 'adminGetState', mode: 'delay', ms: 1200 });
      await pg.evaluate(() => { refresh(false); });
      await pg.click('#refresh'); // 自動更新の途中なので、終わってから読む予定になる
      faults.push({ label: 'r3-admin', name: 'adminSaveSettings', mode: 'delay', ms: 2000 });
      await pg.click('#view-drinks .drinkopen');
      await waitStatus(pg, /ドリンクの受付を締め切りました/);
      await pg.waitForFunction(() => !document.body.classList.contains('busy'));
      await pg.waitForTimeout(300);
      assert.equal(state().settings.drinkOpen, false);
      assert.equal(await pg.getAttribute('#view-drinks .drinkopen', 'aria-checked'), 'false', '操作の結果（締め切り）が画面に出ている');
      assert.match(await text(pg, '#status'), /ドリンクの受付を締め切りました/, '待たせていた「更新」で、操作の結果の文を消さない');
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: true }]);
      // (f) シートで席番号を重ねた・固定席の方の席番号の列に書いた → 消さずに注意を出し、「修正」で消せる
      const sh = ctx.__mock.sheet('参加者');
      const rowOf = tok => ctx.__mock.values('参加者').findIndex(r => String(r[1]) === tok) + 1;
      const d4 = byName('重複 四郎');
      const v4 = callServer(ctx, 'participantDraw', [d4.token]);
      sh.getRange(rowOf(byName('重複 五郎').token), 5).setValue(v4.table + ' ' + v4.tableSeat);
      sh.getRange(rowOf(byName('来賓 六郎').token), 5).setValue('上座');
      await pg.evaluate(() => { document.getElementById('status').textContent = ''; });
      await pg.click('#refresh');
      await waitStatus(pg, /最新の状態にしました/);
      const warn = await text(pg, '#warn');
      assert.match(warn, new RegExp('ほかの方と重なっている方がいます：重複 五郎さん（「' + v4.table + ' ' + v4.tableSeat + '」）'));
      assert.match(warn, /固定席の方の「席番号」の列に、卓として読み取れない内容が書かれています：来賓 六郎さん（「上座」）/);
      assert.equal(byName('重複 四郎').seat, v4.seat, 'くじで決まった方の席はそのまま');
      await pg.locator('#drinkrows tr', { hasText: '来賓 六郎' }).getByRole('button', { name: /修正/ }).click();
      await pg.locator('#editdialog[open]').waitFor();
      await pg.locator('#clearseatwrap').waitFor({ state: 'visible' });
      assert.match(await text(pg, '#clearseatlabel'), /席番号の列に書かれた内容（「上座」）を消す/);
      await pg.check('#editclearseat');
      await pg.click('#editform button[type=submit]');
      await waitStatus(pg, /来賓 六郎さんを修正しました/);
      assert.equal(byName('来賓 六郎').badSeat, null);
      assert.doesNotMatch(await text(pg, '#warn'), /来賓 六郎/);
      await pg.context().close();
    });

    await step('17) 総点検 第4回の回帰：演出の見直し中の保存・残した文の片付け・演出中に下が動かない・受付済みの案内が見える・受付し直したスマホ・幹事画面の狭い幅/dev/固定席の卓', async () => {
      const code = new URL(state().settings.joinUrl).searchParams.get('j');
      const baseTables = state().settings.tables.map(t => t.name + ' ' + t.seats).join('\n');
      callServer(ctx, 'adminSaveSettings', [KEY, { tables: baseTables + '\nステージ前テーブル 4' }]);
      callServer(ctx, 'adminAddPeople', [KEY, ['見直 一郎', '見直 二郎', '案内 七郎', '持主 九郎'], 'lottery']);
      callServer(ctx, 'adminAddPeople', [KEY, ['来賓 八郎'], 'fixed']);
      callServer(ctx, 'adminUpdatePerson', [KEY, byName('来賓 八郎').id, { table: 'ステージ前テーブル' }]);
      const ph = await newPage(browser, 'r4-phone', { width: 320, height: 640 });
      const selected = () => ph.locator('#drinklist button.sel').allTextContents();
      // (a) 演出の見直し中にドリンクを選んでも、見直しで読んだ古い状態で選択が戻らず、次の変更で「ほかの画面で」と出ない
      await open(ph, { t: byName('見直 一郎').token });
      await ph.click('#draw');
      await ph.locator('#again').waitFor({ state: 'visible' });
      await ph.click('#again');
      // (b) 演出のあいだ、卓の名前の高さを確保して、下のドリンクの欄が動かない（長い卓の名前が2行になる幅でも）
      const tops = new Set();
      for (let i = 0; i < 8; i++) { tops.add(await ph.evaluate(() => Math.round(document.getElementById('drinkbox').getBoundingClientRect().top))); await ph.waitForTimeout(40); }
      assert.equal(tops.size, 1, '演出中のドリンクの欄の位置: ' + [...tops]);
      await ph.locator('#drinklist button', { hasText: /^ビール$/ }).click();
      await ph.waitForFunction(() => /「ビール」で登録しました/.test(document.getElementById('drinkmsg').textContent));
      await ph.locator('#again').waitFor({ state: 'visible' });
      assert.deepEqual(await selected(), ['ビール'], '見直しが終わっても選んだドリンクのまま');
      await ph.locator('#drinklist button', { hasText: /^ハイボール$/ }).click();
      await ph.waitForFunction(() => /「ハイボール」で登録しました/.test(document.getElementById('drinkmsg').textContent));
      assert.equal(byName('見直 一郎').drink, 'ハイボール');
      // (c) 残した文は、サーバーの状態が変わったら片付ける（受付で変更された・締め切りのあと再開された）
      callServer(ctx, 'adminUpdatePerson', [KEY, byName('見直 一郎').id, { drink: 'ビール' }]);
      await ph.click('#again');
      await ph.locator('#again').waitFor({ state: 'visible' });
      await ph.waitForFunction(() => /「ビール」で登録済みです/.test(document.getElementById('drinkmsg').textContent));
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: false }]);
      await ph.locator('#drinklist button', { hasText: /^ハイボール$/ }).click();
      await ph.locator('#drinkclosed').waitFor({ state: 'visible' });
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: true }]);
      await ph.click('#again');
      await ph.locator('#drinkopen').waitFor({ state: 'visible' });
      await ph.locator('#again').waitFor({ state: 'visible' });
      assert.doesNotMatch(await text(ph, '#drinkmsg'), /締め切/, '再開したあとに締め切りの文を残さない');
      // (d) 共通QRの長い名前一覧の下のほうで、個別リンクで受付済みの方を押すと、案内が画面に見える
      callServer(ctx, 'participantGet', [byName('案内 七郎').token]);
      await ph.setViewportSize({ width: 375, height: 667 });
      await ph.evaluate(() => localStorage.clear());
      await open(ph, { j: code });
      await ph.locator('#join').waitFor({ state: 'visible' });
      const guideBtn = ph.locator('#joinlist button', { hasText: '案内 七郎' });
      await guideBtn.scrollIntoViewIfNeeded();
      assert.ok(await ph.evaluate(() => scrollY > 300), '一覧の下のほうまで動かしている');
      await guideBtn.click();
      await ph.waitForFunction(() => { const r = document.getElementById('joinerr').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
      // (e) 間違えて別の方を選んだ → 幹事が受付をやり直す → 自分を選び直すと、次に読み取ったとき自分の画面が開く
      await open(ph, { j: code });
      await ph.locator('#joinlist button', { hasText: '見直 二郎' }).click();
      await ph.waitForFunction(() => !document.getElementById('confirmyes').disabled);
      await ph.click('#confirmyes');
      await ph.locator('#intro').waitFor({ state: 'visible' });
      callServer(ctx, 'adminUpdatePerson', [KEY, byName('見直 二郎').id, { releaseClaim: true }]);
      await ph.click('#switchperson');
      await ph.locator('#joinlist button', { hasText: '持主 九郎' }).click();
      await ph.waitForFunction(() => !document.getElementById('confirmyes').disabled);
      await ph.click('#confirmyes');
      await ph.locator('#intro').waitFor({ state: 'visible' });
      // 取り消された記録は消すだけ（次に受付したのが友人か持ち主かは分からないため）。次に読み取ると、
      // エラーなしで一覧が開き、一番上の「このスマホで受付済み」から1回で自分の画面に戻れる
      await ph.waitForFunction(() => !localStorage.getItem('sekikuji.join.token'));
      await open(ph, { j: code });
      await ph.locator('#join').waitFor({ state: 'visible' });
      assert.equal(await ph.locator('#joinerr').isHidden(), true, '「使えなくなりました」の遠回りは出ない');
      const first = ph.locator('#joinlist button').first();
      assert.match(await first.innerText(), /持主 九郎[\s\S]*このスマホで受付済み/);
      await first.click();
      await ph.locator('#intro').waitFor({ state: 'visible' });
      assert.equal(await text(ph, '#name'), '持主 九郎 さん');
      await ph.context().close();

      // (f) 幹事画面 360px：QRコードタブの「状態」の文字が、操作のボタンの下にもぐらない
      const pg = await newPage(browser, 'r4-admin', { width: 360, height: 740 });
      await open(pg, { admin: KEY });
      await pg.locator('#view-drinks').waitFor({ state: 'visible' });
      await pg.click('#tab-qr');
      await pg.locator('#qrrows tr', { hasText: '来賓 八郎' }).waitFor();
      const over = await pg.evaluate(() => [...document.querySelectorAll('#qrrows td .tag')].filter(t => t.getBoundingClientRect().right > t.closest('td').getBoundingClientRect().right + 0.5).map(t => t.textContent));
      assert.deepEqual(over, [], '欄からはみ出す状態の文字');
      // (g) 卓を消すと、その卓の固定席の方の名前を知らせる（(a) のくじでその卓の席になっていても消せるよう、先に席を空きに戻します）
      callServer(ctx, 'adminUpdatePerson', [KEY, byName('見直 一郎').id, { clearSeat: true }]);
      await pg.click('#tab-setup');
      await pg.fill('#tables', baseTables);
      await pg.click('#tablessave');
      await waitStatus(pg, /来賓 八郎さん（ステージ前テーブル）は、その卓が無くなったため卓を未設定に戻しました/);
      assert.equal(byName('来賓 八郎').table, null);
      // (h) テスト用のURL（/dev）しか取れないときは、全員共通のQRの欄にも /exec のURLを貼るよう案内する
      ctx.__mock.setUrl('https://script.google.com/macros/s/TESTDEPLOY/dev');
      await open(pg, { admin: KEY });
      await pg.locator('#view-drinks').waitFor({ state: 'visible' });
      await pg.click('#tab-qr');
      assert.match(await text(pg, '#joinqr'), /テスト用のURL（\/dev で終わるもの）[\s\S]*QR用のURL/);
      assert.doesNotMatch(await text(pg, '#joinqr'), /先にWebアプリとしてデプロイ/);
      assert.equal(await pg.locator('#joincopy').isDisabled(), true);
      ctx.__mock.setUrl('https://script.google.com/macros/s/TESTDEPLOY/exec');
      await pg.context().close();
    });

    await step('最終確認) 取り消された受付が残るスマホで友人→持ち主の順に受付しても、持ち主の画面を覚える', async () => {
      callServer(ctx, 'adminSaveSettings', [KEY, { joinOpen: true }]);
      callServer(ctx, 'adminAddPeople', [KEY, ['誤選 次郎', '友代 花子', '持主 太郎'], 'lottery']);
      const code = state().settings.joinUrl.split('?j=')[1];
      const pg = await newPage(browser, 'owner-phone', { width: 390, height: 844 });
      const pick = async name => {
        await pg.locator('#join').waitFor({ state: 'visible' });
        await pg.fill('#joinsearch', name);
        await pg.locator('#joinlist button', { hasText: name }).first().click();
        await pg.waitForTimeout(600);
        await pg.click('#confirmyes');
        await pg.locator('#intro, #result, #fixed').first().waitFor({ state: 'attached' });
        await pg.waitForFunction(n => document.getElementById('name').textContent.includes(n) || document.getElementById('name2').textContent.includes(n), name);
      };
      await open(pg, { j: code });
      await pick('誤選 次郎');
      callServer(ctx, 'adminUpdatePerson', [KEY, state().people.find(p => p.name === '誤選 次郎').id, { releaseClaim: true }]);
      await pg.click('#switchperson'); await pick('友代 花子');
      await pg.click('#switchperson'); await pick('持主 太郎');
      await pg.waitForTimeout(800);
      await open(pg, { j: code });
      await pg.waitForFunction(() => /持主 太郎/.test(document.getElementById('name').textContent + document.getElementById('name2').textContent) || !document.getElementById('join').hidden);
      assert.doesNotMatch(await pg.locator('main').innerText(), /友代 花子 さん/, '友人の画面は開かない');
      await pg.context().close();
    });

    await step('最終確認2) 幹事画面：失敗したときは前の「最新の状態にしました」を消す・エラー欄の「閉じる」が縦に割れない', async () => {
      const pg = await newPage(browser, 'dry2-admin', { width: 360, height: 740 });
      await open(pg, { admin: KEY });
      await pg.locator('#drinkrows tr').first().waitFor();
      await pg.click('#refresh');
      await waitStatus(pg, /最新の状態にしました/);
      const sh = ctx.__mock.sheet('参加者');
      sh.insertRowsAfter(0, 1); // 見出しの上に行を差し込んだ
      try {
        await pg.click('#refresh');
        await pg.waitForFunction(() => !document.getElementById('error').hidden);
        assert.match(await text(pg, '#errortext'), /見出しの行/);
        assert.equal(await text(pg, '#status'), '', '古い成功の文を残さない');
        const box = await pg.locator('#errorclose').boundingBox();
        assert.ok(box.width > box.height, '閉じるボタンが横長のまま: ' + JSON.stringify(box));
      } finally { sh.deleteRows(1, 1); }
      await pg.click('#refresh');
      await waitStatus(pg, /最新の状態にしました/);
      await pg.context().close();
    });

    await step('最終確認2) 参加者画面：「もう一度演出を見る」の途中でドリンクを保存しても、あとから読んだ最新の状態（締め切り）を捨てない', async () => {
      callServer(ctx, 'adminAddPeople', [KEY, ['再演 一郎', '再演 二郎'], 'lottery']);
      for (const [variant, who] of [['A', '再演 一郎'], ['B', '再演 二郎']]) {
        callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: true }]);
        const tk = byName(who).token;
        callServer(ctx, 'participantDraw', [tk]);
        const label = 'replay-' + variant;
        const pg = await newPage(browser, label, { width: 390, height: 844 });
        await open(pg, { t: tk });
        await pg.waitForSelector('#again:not([hidden])');
        await pg.waitForSelector('#drinkopen:not([hidden])');
        // A: 読み直しが遅れて届く／B: 読み直しが通信エラーで、自動で送り直す
        faults.push(variant === 'A' ? { label, name: 'participantGet', mode: 'delay', ms: 1500 } : { label, name: 'participantGet', mode: 'fail' });
        await pg.click('#again');
        await pg.waitForTimeout(150);
        await pg.click('#drinklist button:first-child');
        await pg.waitForFunction(() => /登録しました/.test(document.getElementById('drinkmsg').textContent));
        callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: false }]); // 保存のあと、読み直しより前に幹事が締め切った
        await pg.waitForSelector('#again:not([hidden])', { timeout: 10000 });
        await pg.waitForSelector('#drinkclosed:not([hidden])', { timeout: 10000 });
        assert.equal(await pg.evaluate(() => view.drinkOpen), false, variant + ': 締め切りを表示');
        await pg.context().close();
      }
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: true }]);
      // C: 読み直しをもう一度している間も、演出は回ったまま（途中の数字を席として見せない）
      {
        callServer(ctx, 'adminAddPeople', [KEY, ['再演 三郎'], 'lottery']);
        const tk = byName('再演 三郎').token, seat = callServer(ctx, 'participantDraw', [tk]);
        const label = 'replay-C';
        const pg = await newPage(browser, label, { width: 390, height: 844 });
        await open(pg, { t: tk });
        await pg.waitForSelector('#again:not([hidden])');
        await pg.waitForSelector('#drinkopen:not([hidden])');
        faults.push({ label, name: 'participantGet', mode: 'delay', ms: 200 }, { label, name: 'participantGet', mode: 'delay', ms: 3000 });
        await pg.click('#again');
        await pg.waitForTimeout(150);
        await pg.click('#drinklist button:first-child');
        await pg.waitForFunction(() => /登録しました/.test(document.getElementById('drinkmsg').textContent));
        await pg.waitForTimeout(2000); // 最初の読み直しの演出（1.5秒）が終わり、2回目の読み直しを待っているところ
        const st = await pg.evaluate(() => ({ rolling: rolling !== null, again: document.getElementById('again').hidden })); // eslint-disable-line no-undef
        assert.ok(st.rolling && st.again, '読み直し中は回したまま: ' + JSON.stringify(st));
        await pg.waitForSelector('#again:not([hidden])', { timeout: 10000 });
        assert.equal((await text(pg, '#number')).replace('番', '').trim(), String(seat.table ? seat.tableSeat : seat.seat));
        await pg.context().close();
      }
    });

    await step('最終確認4) 幹事画面：自動更新の途中に押した「更新」は、先に終わった操作の失敗・成功の文を消さない', async () => {
      const label = 'dry4-admin';
      const pg = await newPage(browser, label, { width: 1280, height: 900 });
      await open(pg, { admin: KEY });
      await pg.locator('#drinkrows tr').first().waitFor();
      const st = () => pg.evaluate(() => ({ status: document.getElementById('status').textContent, err: document.getElementById('error').hidden ? null : document.getElementById('errortext').textContent }));
      for (const saveFails of [true, false]) {
        faults.push({ label, name: 'adminGetState', mode: 'delay', ms: 900 }); // 自動更新が遅い
        await pg.evaluate(() => { refresh(false); }); // eslint-disable-line no-undef
        await pg.waitForTimeout(100);
        await pg.click('#refresh'); // 自動更新の途中なので、待たせる
        if (saveFails) faults.push({ label, name: 'adminSaveSettings', mode: 'fail', message: 'Error: テスト用の保存エラーです。' });
        await pg.click('.drinkopen'); // 自動更新より先に終わる
        await pg.waitForTimeout(2200);
        const r = await st();
        if (saveFails) { assert.equal(r.err, 'テスト用の保存エラーです。', JSON.stringify(r)); assert.equal(r.status, ''); }
        else { assert.match(r.status, /ドリンクの受付を(締め切り|再開し)ました/, JSON.stringify(r)); assert.equal(r.err, null); }
        await pg.evaluate(() => { hideError(); ok(''); }); // eslint-disable-line no-undef
      }
      // 操作が終わったあとに押した「更新」は、ふだんどおり最新にしてエラーを消す
      faults.push({ label, name: 'adminGetState', mode: 'delay', ms: 1200 });
      await pg.evaluate(() => { refresh(false); }); // eslint-disable-line no-undef
      await pg.waitForTimeout(100);
      faults.push({ label, name: 'adminSaveSettings', mode: 'fail', message: 'Error: テスト用の保存エラーです。' });
      await pg.click('.drinkopen');
      await pg.waitForFunction(() => !document.getElementById('error').hidden);
      await pg.click('#refresh');
      await waitStatus(pg, /最新の状態にしました/);
      assert.equal((await st()).err, null);
      // あとから終わった古い自動更新の失敗で、保存のエラーを上書きしない
      faults.push({ label, name: 'adminGetState', mode: 'delayfail', ms: 1200 }, { label, name: 'adminSaveSettings', mode: 'fail', message: 'Error: テスト用の保存エラーです。' });
      await pg.evaluate(() => { ok(''); refresh(false); }); // eslint-disable-line no-undef
      await pg.waitForTimeout(100);
      await pg.click('.drinkopen');
      await pg.waitForTimeout(1600);
      assert.equal((await st()).err, 'テスト用の保存エラーです。');
      callServer(ctx, 'adminSaveSettings', [KEY, { drinkOpen: true }]);
      await pg.context().close();
    });

    await step('最終確認6) 幹事画面：変更の衝突のあとの読み直しを、読み込み中・次の保存の途中でも捨てない', async () => {
      const label = 'dry6-admin';
      callServer(ctx, 'adminAddPeople', [KEY, ['衝突 一郎'], 'lottery']);
      const who = byName('衝突 一郎'), menu = state().settings.drinks;
      const pg = await newPage(browser, label, { width: 1280, height: 900 });
      await open(pg, { admin: KEY });
      await pg.locator('#drinkrows tr', { hasText: '衝突 一郎' }).waitFor();
      faults.push({ label, name: 'adminGetState', mode: 'late', ms: 2500 }); // 修正を開いたときの読み込みの返事が遅れる
      await pg.locator('#drinkrows tr', { hasText: '衝突 一郎' }).getByRole('button', { name: /修正/ }).click();
      await pg.locator('#editdialog[open]').waitFor();
      await pg.waitForTimeout(300);
      callServer(ctx, 'participantSetDrink', [who.token, menu[0], '']); // その間に本人がドリンクを登録
      await pg.selectOption('#editdrink', 'm:' + menu[1]);
      await pg.click('#editform button[type=submit]');
      await pg.waitForFunction(() => /ほかの画面で/.test(document.getElementById('editerror').textContent));
      faults.push({ label, name: 'adminUpdatePerson', mode: 'delayfail', ms: 3000 });
      await pg.selectOption('#editdrink', 'm:' + menu[2]);
      await pg.click('#editform button[type=submit]');
      await pg.waitForTimeout(4500);
      assert.equal(await pg.evaluate(n => S.people.find(p => p.name === n).drink, '衝突 一郎'), menu[0], '読み直して本人の登録を表示'); // eslint-disable-line no-undef
      await pg.context().close();
    });

    await step('ページのエラー・コンソールエラーなし', async () => {
      assert.deepEqual(problems, []);
    });
  } catch (e) {
    failed = true;
    if (problems.length) console.log('console/page problems:\n  ' + problems.join('\n  '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log('gas-e2e: ' + results.filter(r => r[0] === 'ok').length + ' passed, ' + (failed ? 1 : 0) + ' failed. screenshots: ' + SHOTS);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
