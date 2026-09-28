'use strict';
/*
 * 席くじ（Google Apps Script 版）サーバー側。
 * 名簿・席・ドリンクはスプレッドシート（シート「参加者」「設定」）に保存します。
 * google.script.run から呼べるのは末尾が「_」でない関数だけです。公開してよい関数以外は必ず末尾に「_」を付けています。
 */

const SHEET_PEOPLE_ = '参加者', SHEET_SETTINGS_ = '設定';
const HEADERS_ = ['ID', 'トークン', 'お名前', '区分', '席番号', 'ドリンク', '抽選日時', 'ドリンク登録日時'];
const COL_SEAT_ = 5; // 席番号の列（ここだけ数値。ほかの列は書式なしテキスト）
const DEFAULT_DRINKS_ = ['ビール', 'ハイボール', 'レモンサワー', 'ウーロン茶', 'オレンジジュース', 'コーラ'];
const DEFAULT_SEATS_ = 27, MAX_SEATS_ = 99, MAX_PEOPLE_ = 200, MAX_NAME_ = 60, MAX_DRINK_ = 30, MAX_DRINKS_ = 20, MAX_EVENT_ = 40, MAX_URL_ = 300;
const UNDECIDED_ = '未定', TZ_ = 'Asia/Tokyo';
const ERR_TOKEN_ = 'QRコードが無効です。受付にお声がけください。';
const ERR_KEY_ = '幹事用の合言葉が違います。';
const ERR_NOSEAT_ = '空いている席がありません。受付にお声がけください。';
const ERR_FIXED_ = '固定席の方はくじを引きません。';
const ERR_CLOSED_ = 'ドリンクの受付は締め切りました。受付にお声がけください。';
const ERR_PERSON_ = '該当する方が見つかりません。画面を更新してから、もう一度お試しください。';

/* ================= 画面の振り分け ================= */

function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  if (typeof p.admin === 'string' && p.admin && isAdminKey_(p.admin)) {
    out = HtmlService.createHtmlOutputFromFile('Admin').setTitle('席くじ 幹事画面');
  } else if (typeof p.t === 'string' && p.t) {
    out = HtmlService.createHtmlOutputFromFile('Participant').setTitle('席くじ');
  } else {
    out = HtmlService.createHtmlOutput(infoPage_()).setTitle('席くじ');
  }
  return out.addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function infoPage_() {
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px 16px;box-sizing:border-box;' +
    'font-family:system-ui,-apple-system,"Noto Sans JP",sans-serif;background:#f3f6fb;color:#182d4a}' +
    'main{max-width:420px;width:100%;background:#fff;border:1px solid #dfe6ef;border-radius:24px;padding:30px 22px;text-align:center;box-shadow:0 12px 40px #213a6314}' +
    'h1{font-size:24px;margin:0 0 10px;color:#193961}p{color:#617087;line-height:1.9;margin:0}' +
    '</style></head><body><main><h1>席くじ</h1><p>受付でお渡ししたQRコードを読み取ってください。<br>うまくいかないときは受付にお声がけください。</p></main></body></html>';
}

/* ================= 参加者用 API ================= */

function participantGet(token) {
  const db = load_();
  return participantView_(db, findByToken_(db, token));
}

/*
 * 参加者の書き込みは、まずロックを取らずに読んでトークンを確かめます（でたらめなトークンでロックを占有されないように）。
 * 本当の確認と書き込みはロックの中でやり直し、変わった1行だけを書き込みます（受付が混み合ってもロックを短く保つため）。
 */
function participantDraw(token) {
  checkTokenShape_(token);
  const pre = load_(), pp = findByToken_(pre, token);
  if (pp.kind === 'fixed') throw new Error(ERR_FIXED_);
  if (pp.seat !== null) return participantView_(pre, pp); // すでに席がある（2回押し・再読込）ならロック不要
  return withLock_(function () {
    const db = load_(true);
    const p = findByToken_(db, token);
    if (drawFor_(db, p)) saveRow_(db, p);
    return participantView_(db, p);
  });
}

function participantSetDrink(token, drink) {
  checkTokenShape_(token);
  const pre = load_();
  findByToken_(pre, token);
  if (!pre.settings.drinkOpen) throw new Error(ERR_CLOSED_);
  const d = checkDrink_(drink);
  return withLock_(function () {
    const db = load_(true);
    const p = findByToken_(db, token);
    if (!db.settings.drinkOpen) throw new Error(ERR_CLOSED_);
    p.drink = d;
    p.drinkAt = now_();
    saveRow_(db, p);
    return participantView_(db, p);
  });
}

/* ================= 幹事用 API ================= */

function adminGetState(key) {
  checkKey_(key);
  let db = load_();
  if (db.dirty) db = withLock_(function () { const d = load_(true); save_(d); return d; });
  return adminState_(db);
}

function adminAddPeople(key, names, kind) {
  checkKey_(key);
  if (!Array.isArray(names)) throw new Error('お名前を入力してください。');
  checkKind_(kind);
  return withLock_(function () {
    const db = load_(true);
    const added = [], skipped = [];
    const seen = Object.create(null);
    db.people.forEach(function (p) { seen[clean_(p.name)] = true; });
    names.forEach(function (raw) {
      if (raw === null || raw === undefined) return;
      const n = tidy_(raw);
      if (!n) return;
      if (n.length > MAX_NAME_) { skipped.push(n.slice(0, 20) + '…（' + MAX_NAME_ + '文字を超えています）'); return; }
      if (seen[clean_(n)]) { skipped.push(n + '（すでに登録）'); return; }
      if (db.people.length >= MAX_PEOPLE_) { skipped.push(n + '（' + MAX_PEOPLE_ + '名を超えています）'); return; }
      seen[clean_(n)] = true;
      db.people.push(newPerson_(db, n, kind));
      added.push(n);
    });
    if (!added.length) throw new Error('追加できる方がいませんでした。' + (skipped.length ? skipped.join('、') : 'お名前を入力してください。'));
    save_(db);
    return { state: adminState_(db), added: added, skipped: skipped };
  });
}

function adminUpdatePerson(key, id, patch) {
  checkKey_(key);
  if (!patch || typeof patch !== 'object') throw new Error('変更する内容がありません。');
  return withLock_(function () {
    const db = load_(true);
    const p = findById_(db, id);
    if (patch.name !== undefined) p.name = checkName_(db, patch.name, p.id);
    if (patch.kind !== undefined) {
      checkKind_(patch.kind);
      if (patch.kind !== p.kind) { p.kind = patch.kind; p.seat = null; p.drawnAt = null; }
    }
    if (patch.drink !== undefined) {
      if (patch.drink === null) { p.drink = null; p.drinkAt = null; }
      else { p.drink = checkDrink_(patch.drink); p.drinkAt = now_(); }
    }
    if (patch.clearSeat === true) { p.seat = null; p.drawnAt = null; }
    save_(db);
    return adminState_(db);
  });
}

function adminDeletePerson(key, id) {
  checkKey_(key);
  return withLock_(function () {
    const db = load_(true);
    const p = findById_(db, id);
    db.people = db.people.filter(function (x) { return x !== p; });
    save_(db);
    return adminState_(db);
  });
}

function adminDrawAll(key) {
  checkKey_(key);
  return withLock_(function () {
    const db = load_(true);
    const targets = db.people.filter(function (p) { return p.kind === 'lottery' && p.seat === null; });
    if (!targets.length) throw new Error('席が決まっていない方はいません。');
    const free = freeSeats_(db);
    if (!free.length) throw new Error('空いている席がありません。抽選席数を増やしてください。');
    shuffle_(free);
    const at = now_();
    let count = 0;
    targets.forEach(function (p) {
      if (count >= free.length) return;
      p.seat = free[count++];
      p.drawnAt = at;
    });
    save_(db);
    return { state: adminState_(db), count: count };
  });
}

function adminDrawOne(key, id) {
  checkKey_(key);
  return withLock_(function () {
    const db = load_(true);
    if (drawFor_(db, findById_(db, id))) save_(db);
    return adminState_(db);
  });
}

function adminSaveSettings(key, s) {
  checkKey_(key);
  if (!s || typeof s !== 'object') throw new Error('変更する内容がありません。');
  return withLock_(function () {
    const db = load_(true), st = db.settings;
    if (s.seats !== undefined) {
      const n = typeof s.seats === 'string' && s.seats.trim() ? Number(s.seats) : s.seats;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_SEATS_) throw new Error('抽選席数は1〜' + MAX_SEATS_ + 'の整数で入力してください。');
      const maxSeat = db.people.reduce(function (m, p) { return p.seat !== null && p.seat > m ? p.seat : m; }, 0);
      if (n < maxSeat) throw new Error('すでに' + maxSeat + '番の席が決まっているため、抽選席数を' + maxSeat + 'より少なくできません。');
      st.seats = n;
    }
    if (s.event !== undefined) {
      if (typeof s.event !== 'string') throw new Error('会の名前を文字で入力してください。');
      const ev = tidy_(s.event);
      if (ev.length > MAX_EVENT_) throw new Error('会の名前は' + MAX_EVENT_ + '文字以内で入力してください。');
      st.event = ev;
    }
    if (s.drinks !== undefined) st.drinks = checkMenu_(s.drinks);
    if (s.drinkOpen !== undefined) {
      if (typeof s.drinkOpen !== 'boolean') throw new Error('ドリンクの受付の設定が正しくありません。');
      st.drinkOpen = s.drinkOpen;
    }
    if (s.baseUrl !== undefined) st.baseUrl = checkBaseUrl_(s.baseUrl);
    saveSettings_(db);
    SpreadsheetApp.flush();
    return adminState_(db);
  });
}

function adminReissueToken(key, id) {
  checkKey_(key);
  return withLock_(function () {
    const db = load_(true);
    const p = findById_(db, id);
    p.token = newToken_(db);
    save_(db);
    return adminState_(db);
  });
}

function adminReset(key, scope) {
  checkKey_(key);
  if (scope !== 'seats' && scope !== 'drinks' && scope !== 'all') throw new Error('リセットする範囲が正しくありません。');
  return withLock_(function () {
    const db = load_(true);
    if (scope === 'all') db.people = [];
    db.people.forEach(function (p) {
      if (scope === 'seats') { p.seat = null; p.drawnAt = null; }
      if (scope === 'drinks') { p.drink = null; p.drinkAt = null; }
    });
    save_(db);
    return adminState_(db);
  });
}

/* ================= エディタ・スプレッドシートのメニュー ================= */

function setup() {
  withLock_(function () {
    const props = PropertiesService.getScriptProperties();
    let ss = null;
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) { ss = null; }
    const id = props.getProperty('SHEET_ID');
    if (!ss && id) {
      // 保存先が一時的に開けないだけのこともあるので、新しく作り直さずにエラーにします（名簿が切り離されないように）。
      try { ss = SpreadsheetApp.openById(id); } catch (err) { throw new Error('保存先のスプレッドシート（SHEET_ID）を開けませんでした。少し待ってから、もう一度お試しください。'); }
    }
    if (!ss) ss = SpreadsheetApp.create('席くじ');
    if (props.getProperty('SHEET_ID') !== ss.getId()) props.setProperty('SHEET_ID', ss.getId());
    const people = ensurePeopleSheet_(ss);
    ensureSettingsSheet_(ss);
    // 初期シート（シート1 など）が空のまま残っていれば、そのままにしておきます（消すと幹事が困ることがあるため）。
    if (people.getLastRow() < 1) writeHeaders_(people);
    if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', randomString_(32));
    SpreadsheetApp.flush();
  });
  Logger.log('初期設定が終わりました。Webアプリとしてデプロイ後、スプレッドシートのメニュー『席くじ』→『幹事画面のURLを表示』で幹事画面を開いてください。');
}

function onOpen() {
  const ui = getUi_();
  if (!ui) return;
  ui.createMenu('席くじ')
    .addItem('初期設定', 'setup')
    .addItem('幹事画面のURLを表示', 'showAdminUrl')
    .addItem('合言葉を作り直す', 'menuResetAdminKey')
    .addToUi();
}

function showAdminUrl() {
  const key = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  let base = '';
  try { base = appUrl_(readSettingsOnly_()); } catch (err) { base = serviceUrl_(); }
  const url = key && base ? base + '?admin=' + key : '';
  const ui = getUi_();
  if (!ui) {
    Logger.log(!key ? '先に setup（初期設定）を実行してください。' : !base ? '先にWebアプリとしてデプロイしてください。' : '幹事画面のURL: ' + url);
    return;
  }
  if (!key) { ui.alert('先にメニュー『席くじ』→『初期設定』を実行してください。'); return; }
  if (!base && isDevUrl_(rawServiceUrl_())) {
    ui.alert('幹事画面のURL', 'テスト用のURL（/dev で終わるもの）しか取得できませんでした。\n' +
      'Apps Script の「デプロイ」→「デプロイを管理」で、ウェブアプリのURL（/exec で終わるもの）をコピーし、末尾に次を付けて開いてください。\n\n?admin=' + key, ui.ButtonSet.OK);
    return;
  }
  if (!base) { ui.alert('先にデプロイしてください。（拡張機能 → Apps Script → デプロイ → 新しいデプロイ → 種類「ウェブアプリ」）'); return; }
  const u = esc_(url);
  const html = '<div style="font-family:system-ui,sans-serif;color:#182d4a;font-size:14px;line-height:1.7">' +
    '<p style="margin:0 0 8px">幹事画面のURLです。このURLを知っている人は誰でも幹事画面を開けます。取り扱いにご注意ください。</p>' +
    '<p style="margin:0 0 8px"><a href="' + u + '" target="_blank" rel="noopener" style="color:#2255aa;font-weight:700">幹事画面を開く</a></p>' +
    '<textarea readonly onclick="this.select()" style="width:100%;height:70px;font-size:12px;box-sizing:border-box">' + u + '</textarea>' +
    '<p style="margin:6px 0 0;color:#617087;font-size:12px">上の欄をクリックすると全体を選択できます。コピーしてブックマークしておくと便利です。</p></div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(520).setHeight(260), '幹事画面のURL');
}

function menuResetAdminKey() {
  const ui = getUi_();
  if (!ui) return;
  const res = ui.alert('合言葉を作り直しますか？', '今までの幹事画面のURLは使えなくなります（参加者のQRコードはそのまま使えます）。', ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) return;
  PropertiesService.getScriptProperties().setProperty('ADMIN_KEY', randomString_(32));
  showAdminUrl();
}

/* ================= ここから内部処理（すべて末尾「_」） ================= */

function clean_(t) { return String(t).normalize('NFKC').trim().replace(/\s+/g, ' '); }
function tidy_(t) { return String(t).trim().replace(/\s+/g, ' '); }
function esc_(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function now_() { return Utilities.formatDate(new Date(), TZ_, 'yyyy/MM/dd HH:mm:ss'); }
function has_(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

function getUi_() {
  try { return SpreadsheetApp.getUi() || null; } catch (err) { return null; }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) { throw new Error('ただいま混み合っています。少し待ってから、もう一度お試しください。'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

/* 英数字のランダム文字列。GAS には crypto が無いので Utilities.getUuid()（UUID v4）の乱数部分を使います。 */
function randomString_(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '', pool = [];
  while (out.length < len) {
    if (pool.length < 2) {
      const hex = Utilities.getUuid().replace(/-/g, '');
      // 13文字目（版）と17文字目（variant）は固定値を含むので使いません。
      const h = hex.slice(0, 12) + hex.slice(13, 16) + hex.slice(17);
      for (let i = 0; i + 1 < h.length; i += 2) pool.push(parseInt(h.substr(i, 2), 16));
    }
    const b = pool.shift();
    if (b < 248) out += chars.charAt(b % 62); // 248 = 62*4。偏りを避けるため 248 以上は捨てます。
  }
  return out;
}

function randomIndex_(n) { return Math.floor(Math.random() * n); }
function shuffle_(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = randomIndex_(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

function adminKey_() { return PropertiesService.getScriptProperties().getProperty('ADMIN_KEY') || ''; }
function isAdminKey_(key) {
  const k = adminKey_();
  return typeof key === 'string' && key.length > 0 && k.length > 0 && key === k;
}
function checkKey_(key) { if (!isAdminKey_(key)) throw new Error(ERR_KEY_); }
function checkKind_(kind) { if (kind !== 'lottery' && kind !== 'fixed') throw new Error('区分は「抽選」か「固定」を選んでください。'); }
function checkTokenShape_(token) { if (typeof token !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(token)) throw new Error(ERR_TOKEN_); }

function checkName_(db, name, exceptId) {
  if (typeof name !== 'string') throw new Error('お名前を入力してください。');
  const n = tidy_(name);
  if (!n) throw new Error('お名前を入力してください。');
  if (n.length > MAX_NAME_) throw new Error('お名前は' + MAX_NAME_ + '文字以内で入力してください。');
  const c = clean_(n);
  if (db.people.some(function (p) { return p.id !== exceptId && clean_(p.name) === c; })) throw new Error('「' + n + '」はすでに名簿にあります。区別できる表記にしてください。');
  return n;
}

function checkDrink_(drink) {
  if (typeof drink !== 'string') throw new Error('ドリンクを選んでください。');
  const d = clean_(drink);
  if (!d) throw new Error('ドリンクを選んでください。');
  if (d.length > MAX_DRINK_) throw new Error('ドリンク名は' + MAX_DRINK_ + '文字以内で入力してください。');
  return d;
}

function checkMenu_(list) {
  if (!Array.isArray(list)) throw new Error('ドリンクメニューを入力してください。');
  const out = [];
  list.forEach(function (x) {
    if (x === null || x === undefined) return;
    const d = clean_(x);
    if (!d) return;
    if (d.length > MAX_DRINK_) throw new Error('「' + d.slice(0, 20) + '」は長すぎます。ドリンク名は' + MAX_DRINK_ + '文字以内で入力してください。');
    if (d === UNDECIDED_) throw new Error('「' + UNDECIDED_ + '」はメニューに入れられません（参加者の画面に「あとで決める」が自動で出ます）。');
    if (out.indexOf(d) < 0) out.push(d);
  });
  if (!out.length) throw new Error('ドリンクメニューを1つ以上入力してください。');
  if (out.length > MAX_DRINKS_) throw new Error('ドリンクメニューは' + MAX_DRINKS_ + '個までです。');
  return out;
}

function checkBaseUrl_(url) {
  if (typeof url !== 'string') throw new Error('URLを文字で入力してください。');
  let u = url.trim();
  if (!u) return '';
  u = u.replace(/#.*$/, '').replace(/\?.*$/, '');
  if (!/^https:\/\/[^\s"'<>\\`]+$/.test(u)) throw new Error('URLは https:// から始まる形で入力してください。');
  if (u.length > MAX_URL_) throw new Error('URLは' + MAX_URL_ + '文字以内で入力してください。');
  if (isDevUrl_(u)) throw new Error('/dev で終わるURLはテスト用で、参加者は開けません。「デプロイを管理」に出ている /exec で終わるURLを入力してください。');
  return u;
}

/* ----- スプレッドシート ----- */

function spreadsheet_() {
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) { ss = null; }
  if (ss) return ss;
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (err) { /* 下でまとめてエラー */ }
  }
  throw new Error('保存先のスプレッドシートが見つかりません。幹事の方は Apps Script エディタで setup を実行してください。');
}

function writeHeaders_(sh) {
  const r = sh.getRange(1, 1, 1, HEADERS_.length);
  r.setNumberFormat('@');
  r.setValues([HEADERS_]);
  sh.setFrozenRows(1);
}

function ensurePeopleSheet_(ss) {
  let sh = ss.getSheetByName(SHEET_PEOPLE_);
  if (!sh) { sh = ss.insertSheet(SHEET_PEOPLE_); writeHeaders_(sh); }
  return sh;
}

function ensureSettingsSheet_(ss) {
  let sh = ss.getSheetByName(SHEET_SETTINGS_);
  const fresh = !sh;
  if (!sh) sh = ss.insertSheet(SHEET_SETTINGS_);
  const rows = readKeyValues_(sh);
  const defaults = { seats: String(DEFAULT_SEATS_), event: '', drinks: DEFAULT_DRINKS_.join('\n'), drinkOpen: 'TRUE', baseUrl: '' };
  let changed = fresh;
  Object.keys(defaults).forEach(function (k) {
    if (!rows.some(function (r) { return r[0] === k; })) { rows.push([k, defaults[k]]); changed = true; }
  });
  if (changed) writeKeyValues_(sh, rows);
  return sh;
}

function readKeyValues_(sh) {
  const last = sh.getLastRow();
  if (last < 1) return [];
  return sh.getRange(1, 1, last, 2).getValues()
    .map(function (r) { return [String(r[0]).trim(), r[1]]; })
    .filter(function (r) { return r[0]; });
}

/* 先に全体を消さず、上から上書きして余った行だけ消します（同時に読んでいる実行が空のシートを見ないように）。 */
function writeKeyValues_(sh, rows) {
  const last = sh.getLastRow();
  if (rows.length) {
    const r = sh.getRange(1, 1, rows.length, 2);
    r.setNumberFormat('@');
    r.setValues(rows.map(function (x) { return [x[0], x[1] === null || x[1] === undefined ? '' : String(x[1])]; }));
  }
  if (last > rows.length) sh.getRange(rows.length + 1, 1, last - rows.length, 2).clearContent();
}

function parseSettings_(rows) {
  const m = Object.create(null);
  rows.forEach(function (r) { if (!(r[0] in m)) m[r[0]] = r[1]; });
  const seats = Number(m.seats);
  const drinksRaw = m.drinks === undefined ? DEFAULT_DRINKS_.join('\n') : String(m.drinks);
  const drinks = [];
  drinksRaw.split(/\r?\n/).forEach(function (x) { const d = clean_(x); if (d && d.length <= MAX_DRINK_ && drinks.indexOf(d) < 0 && drinks.length < MAX_DRINKS_) drinks.push(d); });
  const open = m.drinkOpen;
  const url = m.baseUrl === undefined || m.baseUrl === null ? '' : String(m.baseUrl).trim();
  return {
    seats: Number.isInteger(seats) && seats >= 1 && seats <= MAX_SEATS_ ? seats : DEFAULT_SEATS_,
    event: m.event === undefined || m.event === null ? '' : tidy_(m.event).slice(0, MAX_EVENT_),
    drinks: drinks,
    drinkOpen: !(open === false || String(open).trim().toUpperCase() === 'FALSE'),
    baseUrl: /^https:\/\//.test(url) ? url : '',
    rows: rows
  };
}

function readSettingsOnly_() {
  const ss = spreadsheet_();
  const sh = ss.getSheetByName(SHEET_SETTINGS_);
  return parseSettings_(sh ? readKeyValues_(sh) : []);
}

function saveSettings_(db) {
  const st = db.settings;
  const vals = { seats: String(st.seats), event: st.event, drinks: st.drinks.join('\n'), drinkOpen: st.drinkOpen ? 'TRUE' : 'FALSE', baseUrl: st.baseUrl };
  const rows = st.rows.map(function (r) { return [r[0], has_(vals, r[0]) ? vals[r[0]] : r[1]]; });
  Object.keys(vals).forEach(function (k) { if (!rows.some(function (r) { return r[0] === k; })) rows.push([k, vals[k]]); });
  st.rows = rows;
  writeKeyValues_(db.settingsSheet, rows);
}

function cellText_(v) {
  if (v === null || v === undefined) return null;
  if (isDate_(v)) return Utilities.formatDate(v, TZ_, 'yyyy/MM/dd HH:mm:ss');
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'; // シートでの表示と同じにします
  const s = String(v).trim();
  return s ? s : null;
}

/*
 * 全行を読み込み、正規化した名簿と設定を返します。
 * locked=true（ロックの中）のときだけ、足りないシートや設定の既定値を書き足します。
 * ロックの外（参加者の表示・幹事画面の読み込み）では何も書き込まず、足りない設定は既定値として扱います。
 */
function load_(locked) {
  const ss = spreadsheet_();
  const sheet = locked ? ensurePeopleSheet_(ss) : ss.getSheetByName(SHEET_PEOPLE_);
  const settingsSheet = locked ? ensureSettingsSheet_(ss) : ss.getSheetByName(SHEET_SETTINGS_);
  const settings = parseSettings_(settingsSheet ? readKeyValues_(settingsSheet) : []);
  const db = { sheet: sheet, settingsSheet: settingsSheet, settings: settings, people: [], dirty: false };
  const last = sheet ? sheet.getLastRow() : 0;
  if (last >= 2) {
    const values = sheet.getRange(2, 1, last - 1, HEADERS_.length).getValues();
    const ids = Object.create(null), tokens = Object.create(null);
    values.forEach(function (r, i) {
      const name = cellText_(r[2]);
      if (!name) { if (r.some(function (c) { return c !== '' && c !== null; })) db.dirty = true; return; }
      let id = cellText_(r[0]), token = cellText_(r[1]);
      const kind = cellText_(r[3]) === '固定' || cellText_(r[3]) === 'fixed' ? 'fixed' : 'lottery';
      let seat = r[4] === '' || r[4] === null ? NaN : Number(String(r[4]).trim());
      seat = kind === 'lottery' && Number.isInteger(seat) && seat >= 1 ? seat : null;
      const p = { id: id, token: token, name: tidy_(name), kind: kind, seat: seat, drink: cellText_(r[5]), drawnAt: cellText_(r[6]), drinkAt: cellText_(r[7]), row: i + 2 };
      if (!p.id || ids[p.id]) { p.id = null; db.dirty = true; }
      if (!p.token || !/^[A-Za-z0-9]{8,64}$/.test(p.token) || tokens[p.token]) { p.token = null; db.dirty = true; }
      if (p.id) ids[p.id] = true;
      if (p.token) tokens[p.token] = true;
      db.people.push(p);
    });
    // 同じ席番号が重複していたら（手で編集した場合など）、後ろの人の席を空きに戻します。
    const taken = Object.create(null);
    db.people.forEach(function (p) {
      if (p.seat === null) return;
      if (taken[p.seat]) { p.seat = null; p.drawnAt = null; db.dirty = true; }
      else taken[p.seat] = true;
    });
    // ID・トークンが無い行（スプレッドシートに直接書き足した行）には新しく付けます。
    db.people.forEach(function (p) {
      if (!p.id) p.id = newId_(db);
      if (!p.token) p.token = newToken_(db);
    });
  }
  return db;
}

function rowValues_(p) {
  return [p.id, p.token, p.name, p.kind === 'fixed' ? '固定' : '抽選', p.seat === null ? '' : p.seat, p.drink || '', p.drawnAt || '', p.drinkAt || ''];
}

/* 全員分を書き込みます。先に全体を消さず上書きし、行が減った分だけ消します（同時に読んでいる実行が空の名簿を見ないように）。 */
function save_(db) {
  const sh = db.sheet, n = db.people.length, last = sh.getLastRow();
  if (n) {
    const range = sh.getRange(2, 1, n, HEADERS_.length);
    range.setNumberFormat('@'); // 利用者の入力が数式や日付・数値として解釈されないように書式なしテキストにします
    sh.getRange(2, COL_SEAT_, n, 1).setNumberFormat('0');
    range.setValues(db.people.map(rowValues_));
  }
  if (last > n + 1) sh.getRange(n + 2, 1, last - n - 1, HEADERS_.length).clearContent();
  db.people.forEach(function (p, i) { p.row = i + 2; });
  db.dirty = false;
  SpreadsheetApp.flush();
}

/* 1人分の行だけを書き込みます（参加者の抽選・ドリンク登録用）。読み込み時に直した箇所があれば全体を書き込みます。 */
function saveRow_(db, p) {
  if (db.dirty || !p.row) { save_(db); return; }
  const range = db.sheet.getRange(p.row, 1, 1, HEADERS_.length);
  range.setNumberFormat('@');
  db.sheet.getRange(p.row, COL_SEAT_).setNumberFormat('0');
  range.setValues([rowValues_(p)]);
  SpreadsheetApp.flush();
}

function newId_(db) {
  let id;
  do { id = 'p' + randomString_(10); } while (db.people.some(function (p) { return p.id === id; }));
  return id;
}

function newToken_(db) {
  let t;
  do { t = randomString_(20); } while (db.people.some(function (p) { return p.token === t; }));
  return t;
}

function newPerson_(db, name, kind) {
  return { id: newId_(db), token: newToken_(db), name: name, kind: kind, seat: null, drink: null, drawnAt: null, drinkAt: null, row: 0 };
}

function findByToken_(db, token) {
  checkTokenShape_(token);
  for (let i = 0; i < db.people.length; i++) if (db.people[i].token === token) return db.people[i];
  throw new Error(ERR_TOKEN_);
}

function findById_(db, id) {
  if (typeof id === 'string' && id) {
    for (let i = 0; i < db.people.length; i++) if (db.people[i].id === id) return db.people[i];
  }
  throw new Error(ERR_PERSON_);
}

function freeSeats_(db) {
  const taken = Object.create(null);
  db.people.forEach(function (p) { if (p.seat !== null) taken[p.seat] = true; });
  const free = [];
  for (let s = 1; s <= db.settings.seats; s++) if (!taken[s]) free.push(s);
  return free;
}

/* 1人分の抽選。席を割り当てたら true、すでに席があれば false（冪等）。 */
function drawFor_(db, p) {
  if (p.kind === 'fixed') throw new Error(ERR_FIXED_);
  if (p.seat !== null) return false;
  const free = freeSeats_(db);
  if (!free.length) throw new Error(ERR_NOSEAT_);
  p.seat = free[randomIndex_(free.length)];
  p.drawnAt = now_();
  return true;
}

function fixedLabels_(db) {
  const m = Object.create(null);
  let i = 0;
  db.people.forEach(function (p) { if (p.kind === 'fixed') m[p.id] = '固定席' + (++i); });
  return m;
}

function appUrl_(settings) { return settings.baseUrl || serviceUrl_(); }
/* テスト用デプロイの URL（…/dev）は作った本人しか開けないので、QR には使いません。 */
function serviceUrl_() { const u = rawServiceUrl_(); return isDevUrl_(u) ? '' : u; }
function rawServiceUrl_() {
  try { return String(ScriptApp.getService().getUrl() || ''); } catch (err) { return ''; }
}
function isDevUrl_(u) { return /\/dev\/?$/.test(String(u || '')); }

function participantView_(db, p) {
  const st = db.settings;
  return {
    event: st.event,
    name: p.name,
    kind: p.kind,
    seat: p.seat,
    fixedLabel: p.kind === 'fixed' ? fixedLabels_(db)[p.id] : null,
    drink: p.drink,
    drinks: st.drinks.slice(),
    drinkOpen: st.drinkOpen,
    seatsLeft: freeSeats_(db).length
  };
}

function summary_(db) {
  const menu = db.settings.drinks, counts = Object.create(null), extra = Object.create(null);
  menu.forEach(function (d) { counts[d] = 0; });
  let undecided = 0, none = 0;
  db.people.forEach(function (p) {
    if (p.drink === null) { none++; return; }
    const d = clean_(p.drink);
    if (d === UNDECIDED_) { undecided++; return; }
    if (has_(counts, d)) counts[d]++;
    else extra[d] = (extra[d] || 0) + 1;
  });
  const others = Object.keys(extra).sort(function (a, b) { return extra[b] - extra[a] || (a < b ? -1 : a > b ? 1 : 0); });
  const lottery = db.people.filter(function (p) { return p.kind === 'lottery'; });
  return {
    orders: menu.map(function (d) { return { name: d, count: counts[d] }; })
      .concat(others.map(function (d) { return { name: d, count: extra[d] }; })),
    undecided: undecided,
    none: none,
    total: db.people.length,
    lottery: lottery.length,
    fixed: db.people.length - lottery.length,
    seated: lottery.filter(function (p) { return p.seat !== null; }).length,
    seatsLeft: freeSeats_(db).length
  };
}

function adminState_(db) {
  const st = db.settings, labels = fixedLabels_(db);
  return {
    settings: { seats: st.seats, event: st.event, drinks: st.drinks.slice(), drinkOpen: st.drinkOpen, baseUrl: st.baseUrl, appUrl: appUrl_(st),
      devUrl: !st.baseUrl && isDevUrl_(rawServiceUrl_()) /* 自動で取れた URL がテスト用（/dev）だった */ },
    people: db.people.map(function (p) {
      return { id: p.id, token: p.token, name: p.name, kind: p.kind, seat: p.seat, drink: p.drink, drawnAt: p.drawnAt, drinkAt: p.drinkAt, fixedLabel: labels[p.id] || null };
    }),
    summary: summary_(db),
    updatedAt: now_()
  };
}
