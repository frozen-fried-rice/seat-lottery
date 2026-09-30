'use strict';
/*
 * 席くじ（Google Apps Script 版）サーバー側。
 * 名簿・席・ドリンクはスプレッドシート（シート「参加者」「設定」）に保存します。
 * google.script.run から呼べるのは末尾が「_」でない関数だけです。公開してよい関数以外は必ず末尾に「_」を付けています。
 */

const SHEET_PEOPLE_ = '参加者', SHEET_SETTINGS_ = '設定';
const HEADERS_ = ['ID', 'トークン', 'お名前', '区分', '席番号', 'ドリンク', '抽選日時', 'ドリンク登録日時', '受付日時', '受付確認キー'];
const COL_SEAT_ = 5; // 席番号の列（ここだけ数値。ほかの列は書式なしテキスト）
const DEFAULT_DRINKS_ = ['ビール', 'ハイボール', 'レモンサワー', 'ウーロン茶', 'オレンジジュース', 'コーラ'];
const MAX_TABLES_ = 30, MAX_TABLE_NAME_ = 10;
const DEFAULT_SEATS_ = 27, MAX_SEATS_ = 99, MAX_PEOPLE_ = 200, MAX_NAME_ = 60, MAX_DRINK_ = 30, MAX_DRINKS_ = 20, MAX_EVENT_ = 40, MAX_URL_ = 190; // QRコード（型番10・誤り訂正M）に入るのは213バイトまで。?t=＋合言葉20文字を足しても収まる長さ
const UNDECIDED_ = '未定', TZ_ = 'Asia/Tokyo';
const ERR_TOKEN_ = 'QRコードが無効です。受付にお声がけください。';
const ERR_KEY_ = '幹事用の合言葉が違います。';
const ERR_NOSEAT_ = '空いている席がありません。受付にお声がけください。';
const ERR_FIXED_ = '固定席の方はくじを引きません。';
const ERR_HEADER_ = '「参加者」シートの見出しの行（ID・トークン・お名前…）が1行目にありません。行を消した・差し込んだ場合は元に戻し、見出しを1行目にしてください。';
const ERR_COLUMNS_ = '「参加者」シートの列が追加・削除されています。A〜J列を元の並び（ID・トークン・お名前・区分・席番号・ドリンク・抽選日時・ドリンク登録日時・受付日時・受付確認キー）に戻し、足したい列はK列より右に作ってください。';
const ERR_CLOSED_ = 'ドリンクの受付は締め切りました。受付にお声がけください。';
const ERR_PERSON_ = '該当する方が見つかりません。画面を更新してから、もう一度お試しください。';
const ERR_BUSY_ = 'ただいま混み合っています。少し待ってから、もう一度お試しください。';
const ERR_JOIN_CLOSED_ = '共通QRコードでの受付は、いまは停止しています。受付にお声がけください。';
const ERR_DRINK_CHANGED_ = 'ドリンクの登録が、ほかの画面で変更されていました。いまの登録を表示しますので、もう一度お選びください。';

/* ================= 画面の振り分け ================= */

function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  if (typeof p.admin === 'string' && p.admin && isAdminKey_(p.admin)) {
    out = HtmlService.createHtmlOutputFromFile('Admin').setTitle('席くじ 幹事画面');
  } else if ((typeof p.t === 'string' && p.t) || (typeof p.j === 'string' && p.j)) {
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

/* ================= 画面から呼ぶ関数（入口） ================= */
// 画面から呼ぶ関数は、中身を api_ で包みます（想定外のエラー → ERR_BUSY_。appErr_ のエラーはそのまま）
function appErr_(msg) { const e = new Error(msg); e.app = true; return e; }
function api_(fn) {
  try { return fn(); }
  catch (err) {
    if (err && err.app) throw err;
    console.error(err && err.stack ? err.stack : err);
    throw appErr_(ERR_BUSY_);
  }
}

/* ================= 参加者用 API ================= */

function participantGet(token) { return api_(function () {
    const db = load_();
    const p = findByToken_(db, token);
    if (p.claimedAt) return participantView_(db, p);
    // 初めて開いた方を「受付済み」にします（共通QRで他人が選べないように）。記録は次の操作でもよいので、混んでいれば表示を優先します
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(1500)) return participantView_(db, p);
    try {
      const d = load_(true), q = findByToken_(d, token);
      if (!q.claimedAt) { q.claimedAt = now_(); saveRow_(d, q); }
      return participantView_(d, q);
    } finally { lock.releaseLock(); }
}); }

/* 参加者の書き込みは、まずロックの外でトークンを確かめ（でたらめなトークンでロックを占有させない）、ロックの中でやり直して1行だけ書きます */
function participantDraw(token) { return api_(function () {
    const pre = load_(), pp = findByToken_(pre, token);
    if (pp.kind === 'fixed') throw appErr_(ERR_FIXED_);
    if (pp.seat !== null && pp.claimedAt) return participantView_(pre, pp); // すでに席がある（2回押し・再読込）ならロック不要
    return withLock_(function () {
      const db = load_(true);
      const p = findByToken_(db, token);
      let changed = drawFor_(db, p);
      if (!p.claimedAt) { p.claimedAt = now_(); changed = true; } // 個別QRで使い始めた方は、共通QRの名前一覧でも「受付済み」にします
      if (changed) saveRow_(db, p);
      return participantView_(db, p);
    });
}); }

/* seen：画面が見た drinkAt。時間切れで遅れて届いた古い保存が、選び直したドリンクを上書きしないように、別のドリンクに変わっていたら保存しません */
function participantSetDrink(token, drink, seen) { return api_(function () {
    const pre = load_();
    findByToken_(pre, token);
    if (!pre.settings.drinkOpen) throw appErr_(ERR_CLOSED_);
    const d = checkDrink_(drink);
    return withLock_(function () {
      const db = load_(true);
      const p = findByToken_(db, token);
      if (!db.settings.drinkOpen) throw appErr_(ERR_CLOSED_);
      if (typeof seen === 'string' && (p.drinkAt || '') !== seen && p.drink !== d) throw appErr_(ERR_DRINK_CHANGED_);
      p.drink = d;
      p.drinkAt = now_();
      if (!p.claimedAt) p.claimedAt = p.drinkAt;
      saveRow_(db, p);
      return participantView_(db, p);
    });
}); }

/* ================= 共通QR（?j=<共通コード>）用 API ================= */
/* 名簿から名前を選ぶと個別トークンを受け取ります。なりすまし防止のため、受付済みの名前は別のスマホからは選べません */

/* claimKey（このスマホの確認キー）を渡すと、このスマホで受付した方に mine: true を付けます（受付の返事を受け取れなかったときに戻れるように） */
function joinList(code, claimKey) { return api_(function () {
    const key = validClaimKey_(claimKey);
    let db = load_();
    checkJoin_(db, code);
    db = persistIfDirty_(db); // スプレッドシートに直接書き足した行にも、毎回同じIDが付くように保存しておきます
    return {
      event: db.settings.event,
      people: db.people.map(function (p) {
        const o = { id: p.id, name: p.name, claimed: !!p.claimedAt };
        if (p.claimedAt && key && p.claimKey === key) o.mine = true;
        // 個別QR・LINEなどで送ったリンク（?t=）から受付した方（名前を選んだスマホが無い）。画面で「そのリンクから開いてください」と案内します
        else if (p.claimedAt && !p.claimKey) o.link = true;
        return o;
      })
    };
}); }

/* claimKey：スマホが作る乱数。返事が失われても、同じスマホは同じ claimKey でやり直せます（ほかのスマホは知らないので選べません） */
function joinClaim(code, id, claimKey) { return api_(function () {
    const key = validClaimKey_(claimKey);
    const pre = load_();
    checkJoin_(pre, code);
    const pp = findById_(pre, id);
    if (pp.claimedAt && !(key && pp.claimKey === key)) throw appErr_(claimedMsg_(pp));
    return withLock_(function () {
      const db = load_(true);
      checkJoin_(db, code);
      const p = findById_(db, id);
      if (p.claimedAt) {
        if (!(key && p.claimKey === key)) throw appErr_(claimedMsg_(p));
      } else {
        p.claimedAt = now_();
        p.claimKey = key || null;
        saveRow_(db, p);
      }
      return { token: p.token, view: participantView_(db, p) };
    });
}); }

/* ================= 幹事用 API ================= */

function adminGetState(key) { return api_(function () {
    checkKey_(key);
    let db = load_();
    // 読み込み時に直した箇所・空の共通QRコードは、ここで書き込んでおきます
    if (db.dirty || !db.settings.joinCode) db = withLock_(function () { const d = load_(true); save_(d); if (!d.settings.joinCode) { saveSettings_(d); SpreadsheetApp.flush(); } return d; });
    return adminState_(db);
}); }

function adminAddPeople(key, names, kind) { return api_(function () {
    checkKey_(key);
    if (!Array.isArray(names)) throw appErr_('お名前を入力してください。');
    checkKind_(kind);
    return withLock_(function () {
      const db = load_(true);
      const added = [], skipped = [];
      const seen = Object.create(null);
      db.people.forEach(function (p) { seen[clean_(p.name)] = true; });
      names.forEach(function (raw) {
        if (typeof raw !== 'string') return;
        const n = tidy_(raw);
        if (!n) return;
        if (n.length > MAX_NAME_) { skipped.push(n.slice(0, 20) + '…（' + MAX_NAME_ + '文字を超えています）'); return; }
        if (seen[clean_(n)]) { skipped.push(n + '（すでに登録）'); return; }
        if (db.people.length >= MAX_PEOPLE_) { skipped.push(n + '（' + MAX_PEOPLE_ + '名を超えています）'); return; }
        seen[clean_(n)] = true;
        db.people.push(newPerson_(db, n, kind));
        added.push(n);
      });
      if (!added.length) throw appErr_('追加できる方がいませんでした。' + (skipped.length ? skipped.join('、') : 'お名前を入力してください。'));
      save_(db);
      return { state: adminState_(db), added: added, skipped: skipped };
    });
}); }

function adminUpdatePerson(key, id, patch) { return api_(function () {
    checkKey_(key);
    if (!patch || typeof patch !== 'object') throw appErr_('変更する内容がありません。');
    return withLock_(function () {
      const db = load_(true);
      const p = findById_(db, id);
      if (patch.name !== undefined) p.name = checkName_(db, patch.name, p.id);
      if (patch.kind !== undefined) {
        checkKind_(patch.kind);
        if (patch.kind !== p.kind) { p.kind = patch.kind; clearSeat_(p); p.table = null; }
      }
      if (patch.drink !== undefined) {
        const d = patch.drink === null ? null : checkDrink_(patch.drink);
        // drinkSeen：修正画面が見た drinkAt。遅れて届いた・古い画面からの保存で、新しい登録を上書きしないように
        if (patch.drinkSeen !== undefined) {
          const seen = typeof patch.drinkSeen === 'string' ? patch.drinkSeen : '';
          if ((p.drinkAt || '') !== seen && p.drink !== d) throw appErr_('ドリンクの登録が、ほかの画面で変更されていました。最新の状態を確かめてから、もう一度保存してください。');
        }
        if (d === null) { p.drink = null; p.drinkAt = null; }
        else { p.drink = d; p.drinkAt = now_(); }
      }
      if (patch.table !== undefined) {
        // 固定席の方の卓（null で未設定）
        if (p.kind !== 'fixed') throw appErr_('卓を指定できるのは固定席の方だけです（くじを引く方の卓は、くじで決まります）。');
        if (patch.table === null || patch.table === '') p.table = null;
        else {
          const names = db.settings.tables.map(function (t) { return t.name; });
          const t = typeof patch.table === 'string' ? clean_(patch.table) : '';
          if (names.indexOf(t) < 0) throw appErr_('その卓はありません。「名簿・設定」の卓の設定をご確認ください。');
          p.table = t;
        }
        p.rawSeat = null; // 席番号の列に書かれていた内容（卓のつもりで書いた「上座」など）は、卓を選び直したので消します
      }
      if (patch.clearSeat === true) clearSeat_(p);
      // 受付をやり直すときは、名前を選んだスマホ（間違えて選んだ人のスマホを含む）が使えなくなるよう合言葉も新しくします
      if (patch.releaseClaim === true) { p.claimedAt = null; p.claimKey = null; p.token = newToken_(db); }
      save_(db);
      return adminState_(db);
    });
}); }

function adminDeletePerson(key, id) { return api_(function () {
    checkKey_(key);
    return withLock_(function () {
      const db = load_(true);
      const p = findById_(db, id);
      db.people = db.people.filter(function (x) { return x !== p; });
      save_(db);
      return adminState_(db);
    });
}); }

function adminDrawAll(key) { return api_(function () {
    checkKey_(key);
    return withLock_(function () {
      const db = load_(true);
      const targets = db.people.filter(function (p) { return p.kind === 'lottery' && p.seat === null; });
      if (!targets.length) throw appErr_('席が決まっていない方はいません。');
      const free = freeSeats_(db);
      if (!free.length) throw appErr_('空いている席がありません。抽選席数を増やしてください。');
      shuffle_(free);
      shuffle_(targets); // 席が足りないとき、名簿の上の方の人から決まらないように順番もくじにします
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
}); }

function adminDrawOne(key, id) { return api_(function () {
    checkKey_(key);
    return withLock_(function () {
      const db = load_(true);
      if (drawFor_(db, findById_(db, id)) || db.dirty) save_(db);
      return adminState_(db);
    });
}); }

function adminSaveSettings(key, s) { return api_(function () {
    checkKey_(key);
    if (!s || typeof s !== 'object') throw appErr_('変更する内容がありません。');
    return withLock_(function () {
      const db = load_(true), st = db.settings, cleared = [];
      const maxSeat = db.people.concat(db.ghosts).reduce(function (m, p) { return p.seat !== null && p.seat > m ? p.seat : m; }, 0);
      if (s.tables !== undefined) {
        if (typeof s.tables !== 'string') throw appErr_('卓の設定を文字で入力してください。');
        const tables = parseTables_(s.tables, true);
        const total = tables.reduce(function (n, t) { return n + t.seats; }, 0);
        if (tables.length && total > MAX_SEATS_) throw appErr_('席数の合計が' + total + '席です。合計' + MAX_SEATS_ + '席までにしてください。');
        if (tables.length && total < maxSeat) throw appErr_(seatHolder_(db, maxSeat) + 'が決まっているため、卓の席数の合計を' + maxSeat + '席より少なくできません（その方の「修正」で席を空きに戻すと減らせます）。');
        // 固定席の方の卓が、新しい卓の一覧に無くなっていたら「未設定」に戻し、今まであった卓なら幹事画面で知らせます（clearedFixed）
        const names = tables.map(function (t) { return t.name; });
        db.people.forEach(function (p) {
          if (p.kind !== 'fixed' || !p.table || names.indexOf(p.table) >= 0) return;
          if (fixedTable_(st, p)) cleared.push(p.name + 'さん（' + p.table + '）');
          p.table = null; db.dirty = true;
        });
        st.tables = tables;
        st.tablesRaw = tables.map(function (t) { return t.name + ' ' + t.seats; }).join('\n');
        if (tables.length) st.seats = total;
      }
      if (s.seats !== undefined) {
        if (st.tables.length) throw appErr_('卓を設定しているときは、抽選する席の数は各卓の席数の合計になります。卓の設定を変えてください。');
        const n = typeof s.seats === 'string' && s.seats.trim() ? Number(s.seats) : s.seats;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_SEATS_) throw appErr_('抽選席数は1〜' + MAX_SEATS_ + 'の整数で入力してください。');
        if (n < maxSeat) throw appErr_(seatHolder_(db, maxSeat) + 'が決まっているため、抽選席数を' + maxSeat + 'より少なくできません。');
        st.seats = n;
      }
      if (s.event !== undefined) {
        if (typeof s.event !== 'string') throw appErr_('会の名前を文字で入力してください。');
        const ev = tidy_(s.event);
        if (ev.length > MAX_EVENT_) throw appErr_('会の名前は' + MAX_EVENT_ + '文字以内で入力してください。');
        st.event = st.eventRaw = ev;
      }
      if (s.drinks !== undefined) { st.drinks = checkMenu_(s.drinks); st.drinksRaw = st.drinks.join('\n'); }
      if (s.drinkOpen !== undefined) {
        if (typeof s.drinkOpen !== 'boolean') throw appErr_('ドリンクの受付の設定が正しくありません。');
        st.drinkOpen = s.drinkOpen;
      }
      if (s.baseUrl !== undefined) st.baseUrl = checkBaseUrl_(s.baseUrl);
      if (s.joinOpen !== undefined) {
        if (typeof s.joinOpen !== 'boolean') throw appErr_('共通QRコードの設定が正しくありません。');
        st.joinOpen = s.joinOpen;
      }
      saveSettings_(db);
      // シートに直接書き足した方の仮のIDを、返す前に保存します。卓・席数を変えて読み取れるようになった席番号も、ここで席にします
      if (resolveRaw_(db) || db.dirty) save_(db);
      SpreadsheetApp.flush();
      const out = adminState_(db);
      if (cleared.length) out.clearedFixed = cleared;
      return out;
    });
}); }

/* opts.clearSeat / opts.clearDrink：QRカードを別の人に渡してしまい、その人がくじ・ドリンクまで済ませていたときに、席とドリンクも消します */
function adminReissueToken(key, id, opts) { return api_(function () {
    checkKey_(key);
    const o = opts && typeof opts === 'object' ? opts : {};
    return withLock_(function () {
      const db = load_(true);
      const p = findById_(db, id);
      p.token = newToken_(db);
      p.claimedAt = null; p.claimKey = null; // 古いスマホは使えなくなるので、共通QRから選び直せるようにします
      if (o.clearSeat === true) clearSeat_(p);
      if (o.clearDrink === true) { p.drink = null; p.drinkAt = null; }
      save_(db);
      return adminState_(db);
    });
}); }

/* 共通QRコードを作り直します（古い共通QRは使えなくなります。受付済みの方のスマホはそのまま使えます）。 */
function adminResetJoinCode(key) { return api_(function () {
    checkKey_(key);
    return withLock_(function () {
      const db = load_(true);
      db.settings.joinCode = randomString_(12);
      saveSettings_(db);
      if (db.dirty) save_(db);
      SpreadsheetApp.flush();
      return adminState_(db);
    });
}); }

function adminReset(key, scope) { return api_(function () {
    checkKey_(key);
    if (scope !== 'seats' && scope !== 'drinks' && scope !== 'all') throw appErr_('リセットする範囲が正しくありません。');
    return withLock_(function () {
      const db = load_(true);
      if (scope === 'all') {
        db.people = []; db.ghosts = [];
        db.settings.joinCode = randomString_(12); // 前の会の共通QR（ポスター・送ったリンク）で、次の会の名簿を選べないように作り直します
        // 次の会の準備なので、前の会の終わりに締め切ったドリンクの受付・止めた共通QRの受付も受け付ける状態に戻します
        db.settings.drinkOpen = true; db.settings.joinOpen = true;
        saveSettings_(db);
      }
      if (scope === 'seats') db.ghosts.forEach(function (g) { g.seat = null; g.rawSeat = null; });
      db.people.forEach(function (p) {
        if (scope === 'seats') clearSeat_(p);
        if (scope === 'drinks') { p.drink = null; p.drinkAt = null; }
      });
      save_(db);
      return adminState_(db);
    });
}); }

/* ================= エディタ・スプレッドシートのメニュー ================= */

function setup() {
  // すでに初期設定が済んでいれば何もしません（誰が呼んでもロックを取らないので、参加者の操作を妨げません）
  let done = false;
  try {
    const props0 = PropertiesService.getScriptProperties();
    if (props0.getProperty('ADMIN_KEY') && props0.getProperty('SHEET_ID')) {
      const ss0 = spreadsheet_();
      done = !!findSheet_(ss0, SHEET_PEOPLE_) && settingsHas_(ss0, 'sheetVersion') === true;
    }
  } catch (err) { /* 下でロックを取ってやり直します */ }
  if (!done) withLock_(function () {
    const props = PropertiesService.getScriptProperties();
    let ss = null;
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) { ss = null; }
    const id = props.getProperty('SHEET_ID');
    if (!ss && id) {
      // 保存先が一時的に開けないだけのこともあるので、新しく作り直さずにエラーにします（名簿が切り離されないように）。
      try { ss = SpreadsheetApp.openById(id); } catch (err) { throw appErr_('保存先のスプレッドシート（SHEET_ID）を開けませんでした。少し待ってから、もう一度お試しください。'); }
    }
    if (!ss) ss = SpreadsheetApp.create('席くじ');
    if (id !== ss.getId()) props.setProperty('SHEET_ID', ss.getId());
    // シートを作るのは初期設定のときだけです（ふだんの操作では、シートが見つからなくても新しく作りません）
    ensurePeopleSheet_(ss, true);
    ensureSettings_(ss, true);
    if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', randomString_(32));
    SpreadsheetApp.flush();
  });
  const m = '初期設定が終わりました。Webアプリとしてデプロイしたあと、スプレッドシートのメニュー『席くじ』→『幹事画面のURLを表示』で幹事画面を開いてください。';
  Logger.log(m);
  const ui = getUi_(); // スプレッドシートのメニューから実行したときは、画面にも出します（ログは見えないため）
  if (ui) ui.alert(m);
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
    // 画面の無いところ（エディタから実行など）では、合言葉入りのURLはログに出さず、見つけ方だけを案内します
    Logger.log(!key ? '先に setup（初期設定）を実行してください。' : !base ? '先にWebアプリとしてデプロイしてください。' : 'スプレッドシートのメニュー「席くじ」→「幹事画面のURLを表示」で確認してください。');
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

const ZW_ = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g; // 目に見えない文字（ゼロ幅スペースなど）
function clean_(t) { return String(t).replace(ZW_, '').normalize('NFKC').trim().replace(/\s+/g, ' '); }
function tidy_(t) { return String(t).replace(ZW_, '').trim().replace(/\s+/g, ' '); }
function esc_(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function now_() { return Utilities.formatDate(new Date(), TZ_, 'yyyy/MM/dd HH:mm:ss'); }
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

function getUi_() {
  try { return SpreadsheetApp.getUi() || null; } catch (err) { return null; }
}

function validClaimKey_(k) { return typeof k === 'string' && /^[A-Za-z0-9]{16,64}$/.test(k) ? k : ''; }

function persistIfDirty_(db) {
  if (!db.dirty) return db;
  try {
    return withLock_(function () { const d = load_(true); if (d.dirty) save_(d); return d; });
  } catch (err) {
    if (!(err && err.message === ERR_BUSY_)) throw err;
    // 混み合っていて保存できないときは、仮のIDしかない方（シートに直接書き足した方）を除いて返します（選んでも見つからないため）
    db.people = db.people.filter(function (p) { return !p.tempId; });
    return db;
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) { throw appErr_(ERR_BUSY_); }
  try { return fn(); } finally { lock.releaseLock(); }
}

/* 英数字のランダム文字列（GAS には crypto が無いので UUID v4 の乱数部分を使います） */
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
function isAdminKey_(key) { const k = adminKey_(); return !!k && key === k; }
function checkKey_(key) { if (!isAdminKey_(key)) throw appErr_(ERR_KEY_); }
function checkKind_(kind) { if (kind !== 'lottery' && kind !== 'fixed') throw appErr_('区分は「抽選」か「固定」を選んでください。'); }
function checkJoin_(db, code) {
  const c = db.settings.joinCode;
  if (typeof code !== 'string' || !c || code !== c) throw appErr_(ERR_TOKEN_);
  if (!db.settings.joinOpen) throw appErr_(ERR_JOIN_CLOSED_);
}
function claimedMsg_(p) {
  // 個別QR・送ったリンク（?t=）から受付した方には、名前を選んだスマホが無いので、そのQR・リンクから開くよう案内します
  if (!p.claimKey) return '「' + p.name + '」さんは、個別のQRコード（またはLINEなどで届いたリンク）ですでに受付済みです。ご本人の場合は、そのQRコード・リンクから開くか、受付にお声がけください。';
  return '「' + p.name + '」さんは、すでに受付済みです。ご本人の場合は、最初に使ったスマホで同じQRコードを読み取るか、受付にお声がけください。';
}

function checkName_(db, name, exceptId) {
  if (typeof name !== 'string') throw appErr_('お名前を入力してください。');
  const n = tidy_(name);
  if (!n) throw appErr_('お名前を入力してください。');
  if (n.length > MAX_NAME_) throw appErr_('お名前は' + MAX_NAME_ + '文字以内で入力してください。');
  const c = clean_(n);
  if (db.people.some(function (p) { return p.id !== exceptId && clean_(p.name) === c; })) throw appErr_('「' + n + '」はすでに名簿にあります。区別できる表記にしてください。');
  return n;
}

function checkDrink_(drink) {
  if (typeof drink !== 'string') throw appErr_('ドリンクを選んでください。');
  const d = clean_(drink);
  if (!d) throw appErr_('ドリンクを選んでください。');
  if (d.length > MAX_DRINK_) throw appErr_('ドリンク名は' + MAX_DRINK_ + '文字以内で入力してください。');
  return d;
}

function checkMenu_(list) {
  if (!Array.isArray(list)) throw appErr_('ドリンクメニューを入力してください。');
  const out = [];
  list.forEach(function (x) {
    if (typeof x !== 'string') return;
    const d = clean_(x);
    if (!d) return;
    if (d.length > MAX_DRINK_) throw appErr_('「' + d.slice(0, 20) + '」は長すぎます。ドリンク名は' + MAX_DRINK_ + '文字以内で入力してください。');
    if (d === UNDECIDED_) throw appErr_('「' + UNDECIDED_ + '」はメニューに入れられません（参加者の画面に「あとで決める」が自動で出ます）。');
    if (out.indexOf(d) < 0) out.push(d);
  });
  if (!out.length) throw appErr_('ドリンクメニューを1つ以上入力してください。');
  if (out.length > MAX_DRINKS_) throw appErr_('ドリンクメニューは' + MAX_DRINKS_ + '個までです。');
  return out;
}

function checkBaseUrl_(url) {
  if (typeof url !== 'string') throw appErr_('URLを文字で入力してください。');
  let u = url.trim();
  if (!u) return '';
  u = u.replace(/#.*$/, '').replace(/\?.*$/, '');
  if (!/^https:\/\/[^\s"'<>\\`]+$/.test(u)) throw appErr_('URLは https:// から始まる形で入力してください。');
  if (u.length > MAX_URL_) throw appErr_('URLは' + MAX_URL_ + '文字以内で入力してください。');
  if (isDevUrl_(u)) throw appErr_('/dev で終わるURLはテスト用で、参加者は開けません。「デプロイを管理」に出ている /exec で終わるURLを入力してください。');
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
  throw appErr_('保存先のスプレッドシートが見つかりません。幹事の方は Apps Script エディタで setup を実行してください。');
}

function writeHeaders_(sh) {
  // 使っていない列（I〜Z など）を消されていたら、A〜J列が収まるように列を足します
  const mc = sh.getMaxColumns();
  if (mc < HEADERS_.length) sh.insertColumnsAfter(mc, HEADERS_.length - mc);
  const r = sh.getRange(1, 1, 1, HEADERS_.length);
  r.setNumberFormat('@');
  r.setValues([HEADERS_]);
  sh.setFrozenRows(1);
}

/* A〜J列の途中に列を差し込む・消すと全員のデータがずれて書き込まれるので止めます（head はK列まで。見出しの書き換えだけなら通します） */
/* 見出しの行が1行目からずれていないか（1行目を消した・上に行を差し込んだ）。ずれていたら書き込まずに止めます */
/* 区分の列の固定席の書き方（「固定」「固定席」「固定（A卓）」「固定 A卓」など。かっこの中・後ろが卓の名前） */
const FIXED_KIND_ = /^(?:固定|fixed)\s*(?:席)?\s*[（(:：、,，]?\s*(.*?)\s*[）)]?$/i;
function checkHeaderRow_(head, below, current) {
  const t = function (v) { return v === null || v === undefined ? '' : String(v).trim(); };
  const cells = function (r) { const out = []; for (let c = 0; c < HEADERS_.length; c++) out.push(t(r[c])); return out; };
  // その列の見出しと同じ数／どの列でも見出しの言葉である数
  const pos = function (r) { return cells(r).filter(function (v, c) { return v === HEADERS_[c]; }).length; };
  const any = function (r) { return cells(r).filter(function (v) { return v && HEADERS_.indexOf(v) >= 0; }).length; };
  const isDate = function (v) { return Object.prototype.toString.call(v) === '[object Date]' || /^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/.test(t(v)); };
  const isKind = function (v) { return /^(抽選|固定([（(].*[）)])?|fixed|lottery)$/i.test(v); };
  // 名簿の行らしい（ID・トークンの形、区分、席番号の数、日時）
  const looksData = function (r) {
    const h = cells(r);
    return /^p[A-Za-z0-9]{10}$/.test(h[0]) || /^[A-Za-z0-9]{20}$/.test(h[1]) || isKind(h[3]) ||
      typeof r[4] === 'number' || [6, 7, 8].some(function (c) { return isDate(r[c]); });
  };
  const h1 = cells(head), filled = h1.filter(function (v) { return v; }).length;
  // 1行目：見出しの言葉が3つ以上（列がずれていれば checkColumns_ が止めます）・書いてあるのが本来の見出しだけ（一部を消した。以前の版のI・J列はメモの見出しでもよい）なら見出しの行です。
  // 見出しを全部書き換えた行（6つ以上書いてあり、名簿の行らしくない）も見出しとして書き直します。それ以外は、見出しの行を消して名簿の行が1行目に来ています
  const isHead = any(head) >= 3 || (!looksData(head) && h1.every(function (v, c) { return !v || v === HEADERS_[c] || c >= 8; })) || (filled >= 6 && !looksData(head));
  if (!isHead) throw appErr_(ERR_HEADER_);
  // 2行目より下に見出しの行がある（上に行を差し込んだ）。名簿の行がその列の見出しと同じになるのは、お名前とドリンクの2つまでです
  if (below.some(function (r) { return pos(r) >= 3; })) throw appErr_(ERR_HEADER_);
  // 見出しがほとんど残っていないと、見出しからは列のずれが分かりません。アプリが書いた行（IDとトークンがある）の並びで確かめます
  // I・J列の見出しが違う：I・J列を消して右のメモの列が来ていないか（受付日時は日時、受付確認キーは英数字）
  if (current && ((h1[8] && h1[8] !== HEADERS_[8]) || (h1[9] && h1[9] !== HEADERS_[9]))) {
    let n = 0, bad = 0;
    below.forEach(function (r) {
      const h = cells(r);
      if (!/^p[A-Za-z0-9]{10}$/.test(h[0]) || !/^[A-Za-z0-9]{20}$/.test(h[1]) || !(h[8] || h[9])) return;
      n++;
      if ((h[8] && !isDate(r[8])) || (h[9] && !/^[A-Za-z0-9]{16,64}$/.test(h[9]))) bad++;
    });
    if (bad && bad * 2 >= n) throw appErr_(ERR_COLUMNS_);
  }
  if (pos(head) < 5) {
    let rows = 0, strong = 0, weak = 0;
    below.forEach(function (r) {
      const h = cells(r);
      // 席・ドリンク・日時がまだ無い行は、列がずれても見分けがつかないので数えません
      if (!/^p[A-Za-z0-9]{10}$/.test(h[0]) || !/^[A-Za-z0-9]{20}$/.test(h[1]) || !h.slice(4).some(function (v) { return v; })) return;
      rows++;
      // 席番号・受付確認キーの列に日時がある・ドリンクの列に席番号の数がある → ずれています（手で書き直せる日時の列は見ません）
      if ([4, 9].some(function (c) { return isDate(r[c]); }) || typeof r[5] === 'number') strong++;
      // 区分が「抽選」「固定」でない・ドリンクの列に日時がある（手で書き換えたこともあるので、1行だけでは止めません）
      else if (!(isKind(h[3]) || FIXED_KIND_.test(h[3])) || isDate(r[5])) weak++;
    });
    if ((strong && strong * 2 >= rows) || (strong + weak >= 2 && (strong + weak) * 2 >= rows)) throw appErr_(ERR_COLUMNS_);
  }
}

function checkColumns_(head) {
  const h = head.map(function (v) { return v === null || v === undefined ? '' : String(v).trim(); });
  for (let c = 0; c < h.length && c <= HEADERS_.length; c++) {
    const i = HEADERS_.indexOf(h[c]);
    // 決まった見出しが別の列にあり、その本来の列には無い → 列がずれています
    if (h[c] && i >= 0 && i !== c && h[i] !== HEADERS_[i]) throw appErr_(ERR_COLUMNS_);
  }
}

/* 名前で見つからなければ、覚えたシートIDで探します（タブの名前を変えても見失わない）。remember=true（ロックの中）で名前で見つけたIDを覚えます */
const SHEET_PROPS_ = { '参加者': 'PEOPLE_SHEET_ID', '設定': 'SETTINGS_SHEET_ID' };
const sheetIdSaved_ = Object.create(null); // この実行で確かめた・覚えたシートID（何度もプロパティを読み書きしないように）
function findSheet_(ss, name, remember) {
  const props = PropertiesService.getScriptProperties(), key = SHEET_PROPS_[name], pre = ss.getId() + ':';
  let sh = ss.getSheetByName(name);
  if (sh) {
    // 名前で見つかったとき（ふだん）は、ロックの中で覚えるときだけプロパティを読みます
    const v = pre + sh.getSheetId();
    if (remember && sheetIdSaved_[key] !== v) { if (props.getProperty(key) !== v) props.setProperty(key, v); sheetIdSaved_[key] = v; }
    return sh;
  }
  const saved = props.getProperty(key) || '';
  if (saved.indexOf(pre) === 0) sh = ss.getSheets().filter(function (x) { return String(x.getSheetId()) === saved.slice(pre.length); })[0];
  return sh || null;
}
function missingSheet_(name) {
  if (!adminKey_()) return appErr_('保存先のスプレッドシートが見つかりません。幹事の方は Apps Script エディタで setup を実行してください。');
  return appErr_('「' + name + '」シートが見つかりません。幹事の方へ：シートを消したときは、スプレッドシートの「元に戻す」（Ctrl+Z）か「ファイル」→「変更履歴」で元に戻してください。');
}

/* ロックの中でシートを探します。作るのは初期設定のとき（create）だけです（設定を作り直すと共通QRのコード・卓・メニューが既定値に戻るため） */
function lockedSheet_(ss, name, create) {
  const sh = findSheet_(ss, name, true);
  if (sh) return sh;
  if (!create) throw missingSheet_(name);
  ss.insertSheet(name);
  return findSheet_(ss, name, true);
}

function ensurePeopleSheet_(ss, create) {
  const sh = lockedSheet_(ss, SHEET_PEOPLE_, create);
  if (sh.getLastRow() < 1) { writeHeaders_(sh); return sh; }
  // I〜Z列などを消して列が足りないときは、先に列を足します（足りないままでは右の列を読み書きできないため）
  const mc = sh.getMaxColumns();
  if (mc < HEADERS_.length) sh.insertColumnsAfter(mc, HEADERS_.length - mc);
  const raw = sh.getRange(1, 1, 1, Math.min(HEADERS_.length + 1, sh.getMaxColumns())).getValues()[0];
  checkHeaderRow_(raw, sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS_.length).getValues() : [], settingsHas_(ss, 'sheetVersion') !== false);
  checkColumns_(raw);
  const head = raw.slice(0, HEADERS_.length).map(function (v) { return String(v).trim(); });
  if (head.join('\t') === HEADERS_.join('\t')) return sh;
  // 以前の版（8列・9列。設定に sheetVersion が無い）から更新したときだけ：新しく使う列（I・J）に見出しかメモがあれば、
  // 列を差し込んで右へずらします（メモを受付の記録と取り違えないように）。今の版で見出しを書き換えただけなら、見出しを書き直すだけです
  if (settingsHas_(ss, 'sheetVersion') === false) {
    for (let c = 8; c < HEADERS_.length; c++) {
      if (head[c] === HEADERS_[c]) continue;
      const used = head[c] !== '' || sh.getRange(1, c + 1, sh.getLastRow(), 1).getValues().some(function (x) { return x[0] !== '' && x[0] !== null; });
      if (used) { sh.insertColumnBefore(c + 1); head.splice(c, 0, ''); }
    }
  }
  writeHeaders_(sh);
  return sh;
}

/* 設定シートにそのキーの行があるか（設定シートが無ければ null） */
function settingsHas_(ss, key) {
  const sh = findSheet_(ss, SHEET_SETTINGS_);
  return sh ? readKeyValues_(sh).some(function (r) { return r[0] === key; }) : null;
}

function ensureSettings_(ss, create) {
  const sh = lockedSheet_(ss, SHEET_SETTINGS_, create);
  const rows = readKeyValues_(sh);
  const defaults = { seats: String(DEFAULT_SEATS_), event: '', drinks: DEFAULT_DRINKS_.join('\n'), drinkOpen: 'TRUE', baseUrl: '', joinCode: randomString_(12), joinOpen: 'TRUE', sheetVersion: '2', tables: '' };
  const missing = Object.keys(defaults).filter(function (k) { return !rows.some(function (r) { return r[0] === k; }); }).map(function (k) { return [k, defaults[k]]; });
  if (missing.length) writeKeyValues_(sh, missing);
  return { sheet: sh, rows: rows.concat(missing) };
}

/* [キー, 値] の一覧。キーの無い行は含めません */
function readKeyValues_(sh) {
  const last = sh.getLastRow();
  if (last < 1) return [];
  const out = [];
  sh.getRange(1, 1, last, 2).getValues().forEach(function (r) {
    const k = String(r[0]).trim();
    if (k) out.push([k, typeof r[1] === 'string' ? unsafeText_(r[1]) : r[1]]);
  });
  return out;
}

/* 今ある行はその場所で書き換え、無いキーは下に足します。呼び出し側はこのアプリのキーだけを渡すので、幹事が足した行には触れません */
function writeKeyValues_(sh, pairs) {
  // 書き込む直前のA列を読み、キーの名前で行を探します（読み込んだあとに行が動いていても、正しい行に書くため）
  const last = sh.getLastRow();
  const colA = last ? sh.getRange(1, 1, last, 1).getValues() : [];
  const at = Object.create(null);
  colA.forEach(function (g, i) { const k = String(g[0]).trim(); if (k) (at[k] = at[k] || []).push(i); });
  const out = Object.create(null); // 行（0始まり）→ 書き込む [キー, 値]
  let end = colA.length;
  const val = function (x) { return [String(x[0]), x[1] === null || x[1] === undefined ? '' : String(safeText_(String(x[1])))]; };
  pairs.forEach(function (x) {
    if (!at[x[0]]) at[x[0]] = [end++]; // 無いキーは下に足します
    at[x[0]].forEach(function (i) { out[i] = val(x); });
  });
  const idx = Object.keys(out).map(Number).sort(function (a, b) { return a - b; });
  if (!idx.length) return;
  const maxRows = sh.getMaxRows();
  if (end > maxRows) sh.insertRowsAfter(maxRows, end - maxRows);
  // 続いている行ごとにまとめて書き込みます
  for (let n = 0; n < idx.length;) {
    let m = n;
    while (m + 1 < idx.length && idx[m + 1] === idx[m] + 1) m++;
    const r = sh.getRange(idx[n] + 1, 1, m - n + 1, 2);
    r.setNumberFormat('@');
    r.setValues(idx.slice(n, m + 1).map(function (i) { return out[i]; }));
    n = m + 1;
  }
}

function parseSettings_(rows) {
  const m = Object.create(null);
  rows.forEach(function (r) { if (!(r[0] in m)) m[r[0]] = r[1]; });
  const seats = Number(m.seats);
  const drinksRaw = m.drinks === undefined ? DEFAULT_DRINKS_.join('\n') : String(m.drinks);
  const drinks = [];
  drinksRaw.split(/\r?\n/).forEach(function (x) { const d = clean_(x); if (d && d !== UNDECIDED_ && d.length <= MAX_DRINK_ && drinks.indexOf(d) < 0 && drinks.length < MAX_DRINKS_) drinks.push(d); });
  const str = function (k) { return m[k] === undefined || m[k] === null ? '' : String(m[k]); };
  const flag = function (v) { return !(v === false || String(v).trim().toUpperCase() === 'FALSE'); };
  const url = str('baseUrl').trim(), join = str('joinCode').trim(), tablesRaw = str('tables');
  let tables = [];
  try { tables = parseTables_(tablesRaw); } catch (err) { tables = []; } // シートを手で壊した場合は、卓なし（通し番号）として扱います
  const total = tables.reduce(function (n, t) { return n + t.seats; }, 0);
  return {
    // 卓があるときは、抽選する席の数＝各卓の席数の合計です
    seats: tables.length ? total : Number.isInteger(seats) && seats >= 1 && seats <= MAX_SEATS_ ? seats : DEFAULT_SEATS_,
    tables: tables,
    tablesRaw: tablesRaw,
    event: Array.from(tidy_(str('event'))).slice(0, MAX_EVENT_).join(''), // 絵文字を途中で切らないように文字単位で
    eventRaw: str('event'), // 会の名前を変更しない保存では、シートの文字をそのまま書き戻します（手で書いた長い名前を切らないため）
    drinks: drinks,
    drinksRaw: drinksRaw, // メニューを変更しない保存では、シートの文字をそのまま書き戻します（21個目以降などを消さないため）
    drinkOpen: flag(m.drinkOpen),
    baseUrl: /^https:\/\//.test(url) ? url : '',
    joinCode: /^[A-Za-z0-9]{8,64}$/.test(join) ? join : '',
    joinOpen: flag(m.joinOpen)
  };
}

function readSettingsOnly_() {
  const ss = spreadsheet_();
  const sh = findSheet_(ss, SHEET_SETTINGS_);
  return parseSettings_(sh ? readKeyValues_(sh) : []);
}

function saveSettings_(db) {
  const st = db.settings;
  const vals = { seats: String(st.seats), tables: st.tablesRaw, event: st.eventRaw, drinks: st.drinksRaw, drinkOpen: st.drinkOpen ? 'TRUE' : 'FALSE', baseUrl: st.baseUrl,
    joinCode: st.joinCode || randomString_(12), joinOpen: st.joinOpen ? 'TRUE' : 'FALSE' };
  st.joinCode = vals.joinCode;
  writeKeyValues_(db.settingsSheet, Object.keys(vals).map(function (k) { return [k, vals[k]]; }));
}

function cellText_(v) {
  if (v === null || v === undefined) return null;
  if (isDate_(v)) return Utilities.formatDate(v, TZ_, 'yyyy/MM/dd HH:mm:ss');
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'; // シートでの表示と同じにします
  const s = unsafeText_(String(v)).trim();
  return s ? s : null;
}

/* 「=」「+」「-」「@」で始まる文字は数式として扱われるので、先頭に「'」を付けて書きます。「'」で始まる文字も、シートが先頭の「'」を
 * 1つ取り除くので同じく付けます。読むときは、付けた「'」が残っていれば外します */
function safeText_(v) { return typeof v === 'string' && /^[=+\-@']/.test(v) ? "'" + v : v; }
function unsafeText_(s) { return /^'[=+\-@']/.test(s) ? s.slice(1) : s; }

/* 名簿と設定を読みます。locked=true（ロックの中）のときだけ、見出しや足りない設定を書き足します */
function load_(locked) {
  const ss = spreadsheet_();
  // シートが無ければ（消した・初期設定の前）、空の名簿・既定の設定として扱わずに止めます
  const sheet = locked ? ensurePeopleSheet_(ss) : findSheet_(ss, SHEET_PEOPLE_);
  if (!sheet) throw missingSheet_(SHEET_PEOPLE_);
  let settingsSheet, rows;
  if (locked) { const e = ensureSettings_(ss); settingsSheet = e.sheet; rows = e.rows; }
  else { settingsSheet = findSheet_(ss, SHEET_SETTINGS_); if (!settingsSheet) throw missingSheet_(SHEET_SETTINGS_); rows = readKeyValues_(settingsSheet); }
  // 以前の版から更新した直後（sheetVersion が無い）は、先にロックの中で列を直してから読みます（I・J列のメモを受付の記録と取り違えないように）
  if (!locked && !rows.some(function (r) { return r[0] === 'sheetVersion'; })) return withLock_(function () { return load_(true); });
  const settings = parseSettings_(rows);
  const W = HEADERS_.length;
  const db = { sheet: sheet, settingsSheet: settingsSheet, settings: settings, people: [], ghosts: [], loadedRows: [], loadedRaw: Object.create(null), dirty: false };
  // 列が足りない（I〜Z列を消した）ときは、ロックの中で列を足してから読みます
  if (!locked && sheet.getMaxColumns() < HEADERS_.length) return withLock_(function () { return load_(true); });
  const last = sheet.getLastRow();
  if (last >= 1) {
    // A〜J列だけを読みます（右側の幹事の列には触れません）。列がずれていれば止めます（ロックの中は ensurePeopleSheet_ が確認済み）
    const rg = sheet.getRange(1, 1, last, W), all = rg.getValues(), fs = rg.getFormulas();
    if (!locked) { checkHeaderRow_(all[0], all.slice(1), true); checkColumns_(all[0]); }
    const values = all.slice(1);
    const named = [];
    values.forEach(function (r, i) {
      if (!r.some(function (c) { return c !== '' && c !== null; })) return; // A〜Jが空の行はそのまま（右側にメモがあるかもしれないので消しません）
      const row = i + 2, name = cellText_(r[2]) ? tidy_(cellText_(r[2])) : '';
      // A〜J列に数式があり、お名前かIDとトークンが無い行（幹事の合計の行など）は名簿にせず、読み書きもしません
      if (fs[i + 1].some(function (f) { return !!f; }) && (!name || (!cellText_(r[0]) && !cellText_(r[1])))) return;
      db.loadedRows.push(row);
      db.loadedRaw[row] = rowText_(r); // 書き込む前に、この行が読み込んだときのままかを確かめるため
      if (!name) {
        // お名前だけ消えている行はそのまま残し、席も使用中として扱います
        const gs = seatOf_(r[4], settings);
        db.ghosts.push({ raw: r.slice(0, W), seat: gs, rawSeat: gs === null && cellText_(r[4]) !== null ? r[4] : null, row: row, text: db.loadedRaw[row] });
        return;
      }
      named.push({ r: r, row: row, name: name });
    });
    // 同じトークンが複数の行にあったら（行のコピーなど）、どちらのQRでも他人の記録を触れないよう全員分を作り直します（お名前の無い行は数えません）
    const tokenCount = Object.create(null);
    named.forEach(function (x) { const t = cellText_(x.r[1]); if (t) tokenCount[t] = (tokenCount[t] || 0) + 1; });
    db.ghosts.forEach(function (g) { const t = cellText_(g.raw[1]); if (t && tokenCount[t]) { g.raw[1] = ''; db.dirty = true; } });
    // お名前の無い行のIDが名簿の方と同じなら（行のコピーなど）、名簿の方を優先して、お名前の無い行のIDを消します
    const namedIds = Object.create(null);
    named.forEach(function (x) { const i = cellText_(x.r[0]); if (i) namedIds[i] = true; });
    db.ghosts.forEach(function (g) { const i = cellText_(g.raw[0]); if (i && namedIds[i]) { g.raw[0] = ''; db.dirty = true; } });
    const ids = Object.create(null);
    named.forEach(function (x) {
      const r = x.r, id = cellText_(r[0]), token = cellText_(r[1]);
      // 区分の列：「抽選」「固定」または「固定（A卓）」（固定席の方の卓）。手で「固定席」「固定 A卓」「Fixed(B卓)」などと書いても固定席として読みます
      const km = FIXED_KIND_.exec(cellText_(r[3]) || '');
      const kind = km ? 'fixed' : 'lottery';
      const rawSeat = seatOf_(r[4], settings), hasSeat = cellText_(r[4]) !== null;
      // ドリンクは集計と同じ形（全角英数・半角カナ・空白をそろえた形）で扱います（手で「ﾋﾞｰﾙ」と書いても「ビール」と数えるため）
      const dr = cellText_(r[5]);
      const p = { id: id, token: token, name: x.name, kind: kind, seat: kind === 'lottery' ? rawSeat : null, drink: dr ? clean_(dr) || null : null, drawnAt: cellText_(r[6]), drinkAt: cellText_(r[7]),
        claimedAt: cellText_(r[8]), claimKey: cellText_(r[9]), row: x.row, table: km && km[1] ? clean_(km[1]) : null,
        // 読み取れない席番号（「3卓の2」・席数より大きい番号など）は消さずにそのまま残し、幹事画面で知らせます（直すまでは未抽選として扱います）
        rawSeat: kind === 'lottery' && rawSeat === null && hasSeat ? r[4] : null };
      if (kind === 'fixed' && hasSeat) {
        // 固定席の方の席番号の列に今ある卓の名前（「A卓」「A卓 3」）が書いてあれば、その卓にします（番号は使いません）。
        // それ以外（「上座」など）は消さずにそのまま残し、幹事画面で知らせます
        const tn = fixedTableOf_(r[4], p, settings);
        if (tn) { p.table = tn; db.dirty = true; }
        else p.rawSeat = r[4];
      }
      if (!p.id || ids[p.id]) { p.id = null; db.dirty = true; }
      if (!p.token || !/^[A-Za-z0-9]{8,64}$/.test(p.token) || tokenCount[p.token] > 1) { p.token = null; p.claimedAt = null; p.claimKey = null; db.dirty = true; }
      if (p.id) ids[p.id] = true;
      db.people.push(p);
    });
    // 席番号の重複は seatOrder_ の順・名簿の方を優先し、もう一方は席番号を消さずに残して幹事画面で知らせます（直すまでは未抽選）
    const taken = Object.create(null);
    seatOrder_(db, function (p) { return p.seat !== null; }).forEach(function (i) {
      const p = db.people[i];
      if (taken[p.seat]) { p.seat = null; p.rawSeat = named[i].r[4]; p.dupSeat = true; }
      else taken[p.seat] = true;
    });
    db.ghosts.forEach(function (g) { if (g.seat !== null) { if (taken[g.seat]) { g.seat = null; g.rawSeat = g.raw[COL_SEAT_ - 1]; } else taken[g.seat] = true; } });
    // 「B卓 3」「3番」のように読み取れた席は、通し番号の数字に書き直します（重なって席にしなかった方の文字は、そのまま残します）
    db.people.forEach(function (p, i) { if (p.seat !== null && !Number.isInteger(Number(String(named[i].r[4]).trim()))) db.dirty = true; });
    // ID・トークンが無い行（スプレッドシートに直接書き足した行）には新しく付けます（保存するまでは仮のIDです）
    db.people.forEach(function (p) {
      if (!p.id) { p.id = newId_(db); p.tempId = true; }
      if (!p.token) p.token = newToken_(db);
    });
  }
  return db;
}

/* 席番号のセル（「12番」「１２」「B卓 3」なども）→ 通し番号。読み取れなければ null */
function seatOf_(v, settings) {
  if (v === '' || v === null || v === undefined) return null;
  const ok = function (n) { return Number.isInteger(n) && n >= 1 && n <= settings.seats ? n : null; }; // 席数より大きい番号は、ない席
  if (typeof v === 'number') return ok(v);
  if (typeof v !== 'string') return null;
  const m = /^(.*?)[\s:：、,，]*(\d+)$/.exec(clean_(v).replace(/\s*(?:番|席)$/, ''));
  if (!m) return null;
  const n = Number(m[2]), pre = clean_(m[1]);
  if (!pre) return ok(n);
  const tables = settings.tables;
  let start = 0;
  for (let i = 0; i < tables.length; i++) {
    if (tables[i].name === pre) return n >= 1 && n <= tables[i].seats ? ok(start + n) : null;
    start += tables[i].seats;
  }
  return null;
}

function rowValues_(p) {
  // 読み取れない・ほかの方と重なった席番号、固定席の方の席番号の列に書かれた内容（「上座」など）は、そのまま書き戻します
  const seat = p.seat !== null ? p.seat : p.rawSeat !== null ? safeText_(p.rawSeat) : '';
  return [p.id, p.token, safeText_(p.name), p.kind === 'fixed' ? safeText_(p.table ? '固定（' + p.table + '）' : '固定') : '抽選', seat, safeText_(p.drink || ''), p.drawnAt || '', p.drinkAt || '', p.claimedAt || '', p.claimKey || ''];
}

function ghostValues_(g) {
  const W = HEADERS_.length, r = [];
  for (let c = 0; c < W; c++) r.push(c === COL_SEAT_ - 1 ? (g.seat !== null ? g.seat : g.rawSeat !== null ? safeText_(g.rawSeat) : '') : safeText_(cellText_(g.raw[c]) || ''));
  return r;
}

/* 固定席の方の席番号の列に書かれた卓の名前（「A卓」「A卓 3」）。今ある卓で、区分の列の卓と食い違わなければ返します（無ければ ''） */
function fixedTableOf_(cell, p, settings) {
  const known = function (n) { return settings.tables.some(function (t) { return t.name === n; }); };
  // 名前が数字で終わる卓（「テーブル2」）もあるので、まず全体を卓の名前として探し、無ければ末尾の番号を除いて探します
  const full = clean_(cellText_(cell) || '').replace(/\s*(?:番|席)$/, '');
  const tn = known(full) ? full : full.replace(/[\s:：、,，]*\d+$/, '');
  return tn && known(tn) && (!p.table || !known(p.table) || p.table === tn) ? tn : '';
}

/* 席の重なりを決める順番（名簿の何番目か）：このアプリのくじで決まった方（抽選日時がある方）→ 上の行の方 */
function seatOrder_(db, pick) {
  const order = db.people.map(function (p, i) { return i; }).filter(function (i) { return pick(db.people[i]); });
  return order.sort(function (a, b) { return (db.people[a].drawnAt ? 0 : 1) - (db.people[b].drawnAt ? 0 : 1) || a - b; });
}

/* 読み取れなかった・重なっていた席番号（と固定席の方の卓）が使えるようになっていたら席にします（読み込み直したときと同じ状態を返すため）。変わったら true */
function resolveRaw_(db) {
  const taken = Object.create(null);
  let changed = false;
  db.people.forEach(function (p) { if (p.seat !== null) taken[p.seat] = true; });
  db.ghosts.forEach(function (g) { if (g.seat !== null) taken[g.seat] = true; });
  seatOrder_(db, function (p) { return p.kind === 'lottery' && p.seat === null && p.rawSeat !== null; }).forEach(function (i) {
    const p = db.people[i], n = seatOf_(p.rawSeat, db.settings);
    if (n !== null && !taken[n]) { p.seat = n; p.rawSeat = null; p.dupSeat = false; taken[n] = true; changed = true; }
  });
  db.ghosts.forEach(function (g) {
    if (g.seat !== null || g.rawSeat === null) return;
    const n = seatOf_(g.rawSeat, db.settings);
    if (n !== null && !taken[n]) { g.seat = n; g.rawSeat = null; taken[n] = true; changed = true; }
  });
  db.people.forEach(function (p) {
    if (p.kind !== 'fixed' || p.rawSeat === null) return;
    const tn = fixedTableOf_(p.rawSeat, p, db.settings);
    if (tn) { p.table = tn; p.rawSeat = null; changed = true; }
  });
  return changed;
}

/* 席を空きに戻します（読み取れなかった席番号の文字も消します） */
function clearSeat_(p) { p.seat = null; p.drawnAt = null; p.rawSeat = null; }

function rowText_(r) {
  const out = [];
  for (let c = 0; c < HEADERS_.length; c++) out.push(cellText_(r[c]) || '');
  return out.join('\t');
}

/* 読み込んだ行が今も同じか確かめます（幹事が手で行を動かした直後なら、別の方の行に書かないよう ERR_BUSY_ で止めます） */
function verifyRows_(db) {
  const rows = db.loadedRows;
  if (!rows.length) return;
  const max = rows.reduce(function (m, r) { return r > m ? r : m; }, 2);
  if (max > db.sheet.getMaxRows()) throw appErr_(ERR_BUSY_);
  const vals = db.sheet.getRange(2, 1, max - 1, HEADERS_.length).getValues();
  rows.forEach(function (r) { if (rowText_(vals[r - 2]) !== db.loadedRaw[r]) throw appErr_(ERR_BUSY_); });
}

/* 全員分を書き込みます（消した方は行ごと削除、新しい方は下に追加。A〜J列だけを書き、全体は消しません） */
function save_(db) {
  const sh = db.sheet, W = HEADERS_.length;
  verifyRows_(db);
  resolveRaw_(db);
  const keep = Object.create(null);
  db.people.forEach(function (p) { if (p.row) keep[p.row] = true; });
  db.ghosts.forEach(function (g) { if (g.row) keep[g.row] = true; });
  const gone = db.loadedRows.filter(function (r) { return !keep[r]; }).sort(function (a, b) { return b - a; });
  if (gone.length) {
    // シートの見出し以外の行をすべて消すことはできないので、そのときは空の行を1つ足してから消します
    if (sh.getMaxRows() - gone.length < 2) sh.insertRowsAfter(sh.getMaxRows(), 1);
    for (let i = 0; i < gone.length;) {
      let j = i;
      while (j + 1 < gone.length && gone[j + 1] === gone[j] - 1) j++;
      sh.deleteRows(gone[j], j - i + 1);
      i = j + 1;
    }
    const shift = function (r) { let n = 0; gone.forEach(function (g) { if (g < r) n++; }); return r - n; };
    db.people.forEach(function (p) { if (p.row) p.row = shift(p.row); });
    db.ghosts.forEach(function (g) { if (g.row) g.row = shift(g.row); });
  }
  // 新しい方は、名簿の最後の行のすぐ下に足します（右側の列にチェックボックスなどが下まであっても、そこより下にはしません）
  let next = 2;
  db.people.forEach(function (p) { if (p.row >= next) next = p.row + 1; });
  db.ghosts.forEach(function (g) { if (g.row >= next) next = g.row + 1; });
  const newcomers = db.people.filter(function (p) { return !p.row; });
  if (newcomers.length) {
    // 右側の列に文字（メモ）が残っている行には入れません（前の方のメモを引き継がないように）。チェックボックス・数式だけの行は使います
    // A〜J列に数式がある行（幹事が足した合計の行など。読み込みで名簿から外した行）にも入れません
    const lastCol = Math.max(sh.getLastColumn(), W), lastRow = sh.getLastRow();
    let busyRow = function () { return false; };
    if (lastRow >= next) {
      const rg = sh.getRange(next, 1, lastRow - next + 1, lastCol), vals = rg.getValues(), fs = rg.getFormulas(), base = next;
      busyRow = function (r) {
        const i = r - base;
        if (i < 0 || i >= vals.length) return false;
        return vals[i].some(function (v, j) { return j < W ? !!fs[i][j] : !fs[i][j] && v !== '' && v !== null && typeof v !== 'boolean'; });
      };
    }
    const isNew = Object.create(null);
    newcomers.forEach(function (p) { while (busyRow(next)) next++; p.row = next++; isNew[p.row] = true; });
    // 新しい方を入れる行が、書き込む直前も空のままかを確かめます（その間に手で書き足された行を上書きしないように）
    const first = newcomers[0].row, lastNew = newcomers[newcomers.length - 1].row, lr = sh.getLastRow();
    if (first <= lr) {
      const v = sh.getRange(first, 1, Math.min(lastNew, lr) - first + 1, W).getValues();
      if (v.some(function (r, i) { return isNew[first + i] && rowText_(r).replace(/\t/g, '') !== ''; })) throw appErr_(ERR_BUSY_);
    }
  }
  const byRow = Object.create(null);
  let maxRow = 1;
  db.people.forEach(function (p) { byRow[p.row] = rowValues_(p); if (p.row > maxRow) maxRow = p.row; });
  // お名前の無い行は、読み込んだときから変わったとき（重複したIDやトークン・席を消した）だけ書き込みます（数式や日付の書式をそのまま残すため）
  const same = Object.create(null);
  db.ghosts.forEach(function (g) {
    const v = ghostValues_(g);
    if (g.text !== undefined && rowText_(v) === g.text) { same[g.row] = g.text; return; }
    byRow[g.row] = v; if (g.row > maxRow) maxRow = g.row;
  });
  const maxRows = sh.getMaxRows();
  if (maxRow > maxRows) sh.insertRowsAfter(maxRows, maxRow - maxRows);
  // 名簿の行だけを、続いているところごとにまとめて書き込みます（あいだの空行には触れません）
  for (let r = 2; r <= maxRow;) {
    if (!byRow[r]) { r++; continue; }
    let e = r;
    while (e + 1 <= maxRow && byRow[e + 1]) e++;
    const n = e - r + 1, out = [];
    for (let k = r; k <= e; k++) out.push(byRow[k]);
    const range = sh.getRange(r, 1, n, W);
    range.setNumberFormat('@'); // 利用者の入力が数式や日付・数値として解釈されないように書式なしテキストにします
    sh.getRange(r, COL_SEAT_, n, 1).setNumberFormat('0');
    range.setValues(out);
    r = e + 1;
  }
  db.loadedRaw = Object.create(null);
  Object.keys(byRow).forEach(function (r) { db.loadedRaw[r] = rowText_(byRow[r]); });
  Object.keys(same).forEach(function (r) { db.loadedRaw[r] = same[r]; });
  db.loadedRows = Object.keys(db.loadedRaw).map(Number);
  db.people.forEach(function (p) { delete p.tempId; });
  db.ghosts.forEach(function (g) { g.text = db.loadedRaw[g.row]; });
  db.dirty = false;
  SpreadsheetApp.flush();
}

/* 1人分の行だけを書き込みます（参加者の抽選・ドリンク登録用）。読み込み時に直した箇所があれば全体を書き込みます。 */
function saveRow_(db, p) {
  if (db.dirty || !p.row) { save_(db); return; }
  // 行がずれていたら書かない（上の verifyRows_ と同じ理由）
  if (p.row > db.sheet.getMaxRows() || rowText_(db.sheet.getRange(p.row, 1, 1, HEADERS_.length).getValues()[0]) !== db.loadedRaw[p.row]) throw appErr_(ERR_BUSY_);
  const range = db.sheet.getRange(p.row, 1, 1, HEADERS_.length);
  range.setNumberFormat('@');
  db.sheet.getRange(p.row, COL_SEAT_).setNumberFormat('0');
  range.setValues([rowValues_(p)]);
  db.loadedRaw[p.row] = rowText_(rowValues_(p));
  SpreadsheetApp.flush();
}

function newId_(db) {
  let id;
  do { id = 'p' + randomString_(10); } while (db.people.some(function (p) { return p.id === id; }) || db.ghosts.some(function (g) { return cellText_(g.raw[0]) === id; }));
  return id;
}

function newToken_(db) {
  let t;
  do { t = randomString_(20); } while (db.people.some(function (p) { return p.token === t; }) || db.ghosts.some(function (g) { return cellText_(g.raw[1]) === t; }));
  return t;
}

/* 「山田さんの席（B卓 4番）」：その席番号の方と、いまの卓での場所（設定を変える前の表示） */
function seatHolder_(db, seat) {
  const pl = seatPlace_(db.settings, seat), where = pl.table ? pl.table + ' ' + pl.num + '番' : seat + '番';
  const p = db.people.filter(function (x) { return x.seat === seat; })[0];
  return p ? p.name + 'さんの席（' + where + '）' : 'お名前の無い行の席（' + where + '）';
}

function newPerson_(db, name, kind) {
  return { id: newId_(db), token: newToken_(db), name: name, kind: kind, seat: null, rawSeat: null, drink: null, drawnAt: null, drinkAt: null, claimedAt: null, claimKey: null, row: 0, table: null };
}

function findByToken_(db, token) { // トークンの形は load_ と newToken_ で確かめ済み
  for (let i = 0; i < db.people.length; i++) if (db.people[i].token === token) return db.people[i];
  throw appErr_(ERR_TOKEN_);
}

function findById_(db, id) {
  if (typeof id === 'string' && id) {
    for (let i = 0; i < db.people.length; i++) if (db.people[i].id === id) return db.people[i];
  }
  throw appErr_(ERR_PERSON_);
}

function freeSeats_(db) {
  const taken = Object.create(null);
  db.people.forEach(function (p) { if (p.seat !== null) taken[p.seat] = true; });
  db.ghosts.forEach(function (g) { if (g.seat !== null) taken[g.seat] = true; });
  const free = [];
  for (let s = 1; s <= db.settings.seats; s++) if (!taken[s]) free.push(s);
  return free;
}

/* 1人分の抽選。席を割り当てたら true、すでに席があれば false（冪等）。 */
function drawFor_(db, p) {
  if (p.kind === 'fixed') throw appErr_(ERR_FIXED_);
  if (p.seat !== null) return false;
  const free = freeSeats_(db);
  if (!free.length) throw appErr_(ERR_NOSEAT_);
  p.seat = free[randomIndex_(free.length)];
  p.drawnAt = now_();
  return true;
}

/* 卓の設定を1行に1卓「A卓 8」の形で読みます。通し番号は上の卓から（A卓＝1〜8番、B卓＝9〜16番…） */
function parseTables_(text, strict) {
  const out = [], seen = Object.create(null);
  String(text).split(/\r?\n/).forEach(function (line, i) {
    const l = clean_(line);
    if (!l) return;
    const m = /^(.+?)[\s,:、，：]*(\d+)\s*(?:席|人|名)?$/.exec(l);
    // 数字だけの行（「24」など）は、卓の名前と席数の区切りが無いので読みません（「2」卓の4席と取り違えないように）
    if (!m || !tidy_(m[1].replace(/[,:、，：]+$/, '')) || /[.\-−]\s*$/.test(m[1]) || /\d[eE]$/.test(m[1]) || /\d[,，]\d{3}\D*$/.test(l) || (/^\d+$/.test(m[1]) && !/^\d+[\s,:、，：]+\d/.test(l))) throw appErr_((i + 1) + '行目「' + l.slice(0, 20) + '」を読み取れません。「A卓 8」のように、卓の名前と席数を書いてください。');
    const name = tidy_(m[1].replace(/[,:、，：]+$/, '')), n = Number(m[2]);
    // 1行に2卓（「A卓 8 B卓 8」）は、前の卓が名前に入ってしまうので止めます（「テーブル1 窓側」は通します）。保存のとき（strict）だけ
    const two = strict && /^(.*?)\d+\s*(席|人|名)?([\s,:、，：]+)(.*\D.*)$/.exec(name);
    if (two) {
      const a = tidy_(two[1]), b = tidy_(two[4]);
      if (two[2] || /[,:、，：]/.test(two[3]) || (a && a.slice(-1) === b.slice(-1)) || (/^[A-Za-z]$/.test(a) && /^[A-Za-z]$/.test(b))) throw appErr_((i + 1) + '行目「' + l.slice(0, 20) + '」に卓が2つ以上あるようです。1行に1卓ずつ「A卓 8」のように書いてください。');
    }
    if (name.length > MAX_TABLE_NAME_) throw appErr_('卓の名前「' + name.slice(0, 20) + '」は' + MAX_TABLE_NAME_ + '文字以内にしてください。');
    if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS_) throw appErr_('「' + name + '」の席数は1〜' + MAX_SEATS_ + 'の整数にしてください。');
    if (seen[name]) throw appErr_('卓の名前「' + name + '」が重なっています。');
    seen[name] = true;
    out.push({ name: name, seats: n });
  });
  if (out.length > MAX_TABLES_) throw appErr_('卓は' + MAX_TABLES_ + '卓までです。');
  // 合計の上限もここで確かめます（設定シートに直接書かれた場合も、上限を超えた席を配らないように）
  const total = out.reduce(function (n, t) { return n + t.seats; }, 0);
  if (total > MAX_SEATS_) throw appErr_('席数の合計が' + total + '席です。合計' + MAX_SEATS_ + '席までにしてください。');
  return out;
}

/* 通し番号の席 → { table: 卓の名前, num: 卓の中での番号 }。卓が無いときは table: null */
function seatPlace_(settings, seat) {
  if (seat === null || seat === undefined) return { table: null, num: null };
  let start = 0;
  for (let i = 0; i < settings.tables.length; i++) {
    const t = settings.tables[i];
    if (seat <= start + t.seats) return { table: t.name, num: seat - start };
    start += t.seats;
  }
  return { table: null, num: seat };
}

/* 固定席の方の卓。今の卓の一覧に無い卓（シートで書き換えた・卓の設定が変わった）は「未設定」として扱います */
function fixedTable_(st, p) {
  return p.kind === 'fixed' && p.table && st.tables.some(function (t) { return t.name === p.table; }) ? p.table : null;
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
    // 卓があるときの表示：「A卓 3番」（固定席の方は、幹事が指定した卓）
    table: p.kind === 'fixed' ? fixedTable_(st, p) : seatPlace_(st, p.seat).table,
    tableSeat: p.kind === 'fixed' ? null : seatPlace_(st, p.seat).num,
    tables: st.tables.map(function (t) { return { name: t.name, seats: t.seats }; }),
    drink: p.drink,
    drinkAt: p.drinkAt || '', // ドリンクを保存するときに送り返します（遅れて届いた古い保存で上書きしないため）
    drinks: st.drinks.slice(),
    drinkOpen: st.drinkOpen,
    seatsLeft: freeSeats_(db).length,
    link: appUrl_(st) ? appUrl_(st) + '?t=' + p.token : '' // ご本人専用のリンク（共通QRで受付した方がブックマークできるように）
  };
}

function summary_(db) {
  const menu = db.settings.drinks, counts = Object.create(null), extra = Object.create(null);
  menu.forEach(function (d) { counts[d] = 0; });
  let undecided = 0, none = 0;
  db.people.forEach(function (p) {
    if (p.drink === null) { none++; return; }
    const d = p.drink;
    if (d === UNDECIDED_) { undecided++; return; }
    if (d in counts) counts[d]++;
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
    settings: { seats: st.seats, tables: st.tables.map(function (t) { return { name: t.name, seats: t.seats }; }), event: st.event, drinks: st.drinks.slice(), drinkOpen: st.drinkOpen, baseUrl: st.baseUrl, appUrl: appUrl_(st),
      joinOpen: st.joinOpen, joinUrl: appUrl_(st) && st.joinCode ? appUrl_(st) + '?j=' + st.joinCode : '',
      devUrl: !st.baseUrl && isDevUrl_(rawServiceUrl_()) /* 自動で取れた URL がテスト用（/dev）だった */ },
    people: db.people.map(function (p) {
      const place = p.kind === 'fixed' ? { table: fixedTable_(st, p), num: null } : seatPlace_(st, p.seat);
      return { id: p.id, token: p.token, name: p.name, kind: p.kind, seat: p.seat, table: place.table, tableSeat: place.num, drink: p.drink, drawnAt: p.drawnAt, drinkAt: p.drinkAt, claimedAt: p.claimedAt, fixedLabel: labels[p.id] || null,
        // シートに手で書かれた、読み取れない席番号（dupSeat：ほかの方と重なった席番号。固定席の方は、席番号の列に書かれた内容）
        badSeat: p.seat === null && p.rawSeat !== null ? cellText_(p.rawSeat) : null, dupSeat: !!p.dupSeat && p.seat === null && p.rawSeat !== null };
    }),
    summary: summary_(db),
    updatedAt: now_()
  };
}
