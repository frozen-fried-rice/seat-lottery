'use strict';
// Google Apps Script サービスのモック。gas/Code.gs を node:vm で動かすために使います（単体テストと E2E で共有）。
// 使い方:
//   const { createGasContext, createBackend, callServer } = require('./gas-mock.cjs');
//   const ctx = createGasContext();               // 新しいスプレッドシート（コンテナバインド）で Code.gs を読み込む
//   ctx.setup(); const key = ctx.__mock.props.ADMIN_KEY;
//   const state = callServer(ctx, 'adminGetState', [key]);   // google.script.run と同じく引数・戻り値を直列化して呼ぶ
// createGasContext(opts):
//   backend   … createBackend() の戻り値。複数のコンテキスト（＝同時に動く別の実行）で同じスプレッドシート・プロパティ・ロックを共有する
//   bound     … true（既定）なら getActiveSpreadsheet() がスプレッドシートを返す。false なら null（スタンドアロンのスクリプト）
//   url       … ScriptApp.getService().getUrl() の値（既定 'https://script.google.com/macros/s/TESTDEPLOY/exec'。null で未デプロイ）
//   ui        … true なら SpreadsheetApp.getUi() がモック UI を返す。false（既定）なら実際の GAS 同様に例外
//   uiResponse… ui.alert(…, ButtonSet) の戻り値（既定 'YES'）
//   htmlDir   … createHtmlOutputFromFile で読むディレクトリ（既定 gas/）
//   htmlFiles … { Admin: '<p>…</p>' } のようにファイルの中身を上書き（ディスクより優先）
//   codePath  … 読み込む Code.gs（既定 gas/Code.gs）
//   random    … Math.random の代わりに使う関数（抽選を再現したいとき）
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

/* ---------- セルの値の変換（実際のスプレッドシートの挙動を真似る） ---------- */
const DATE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
function storeValue(v, format) {
  if (v === null || v === undefined || v === '') return { v: '' };
  if (format === '@') {
    // 書式なしテキスト: 文字列はそのまま。数値・真偽値は setValues しても値の型は保たれる（表示だけ文字列）。
    // getValues では文字列として返る（実際の GAS も '@' 列は文字列で返る）。
    if (typeof v === 'boolean') return { v: v ? 'TRUE' : 'FALSE' };
    if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') return { v: fmtDate(v, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss') };
    return { v: String(v) };
  }
  if (typeof v === 'string') {
    if (/^=/.test(v)) return { v: '#ERROR!', formula: v };          // 数式として解釈されてしまう
    const t = v.trim();
    if (/^[+-]?\d+(\.\d+)?$/.test(t)) return { v: Number(t) };      // 数字だけの文字列は数値になる
    if (/^(true|false)$/i.test(t)) return { v: /^true$/i.test(t) };  // TRUE/FALSE は真偽値になる
    const m = DATE_RE.exec(t);
    if (m) return { v: tokyoDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) };
    return { v };
  }
  if (typeof v === 'number' || typeof v === 'boolean') return { v };
  if (Object.prototype.toString.call(v) === '[object Date]') return { v: new Date(v.getTime()) };
  throw new Error('Exception: The parameters (' + typeof v + ') don\'t match the method signature for SpreadsheetApp.Range.setValues.');
}
function tokyoDate(y, mo, d, h, mi, s) { return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, s)); }
function readValue(cell) {
  if (!cell) return '';
  if (cell.v instanceof Date) return new Date(cell.v.getTime());
  return cell.v;
}

/* Utilities.formatDate（yyyy MM dd HH mm ss と、タイムゾーンは Asia/Tokyo / UTC / GMT に対応） */
function fmtDate(date, tz, pattern) {
  const off = /^(UTC|GMT|Etc\/UTC)$/.test(tz) ? 0 : /Tokyo|JST|GMT\+9/.test(tz) ? 9 : 9;
  const d = new Date(date.getTime() + off * 3600000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const map = { yyyy: d.getUTCFullYear(), MM: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()), HH: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()) };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, k => String(map[k]));
}

/* ---------- スプレッドシート ---------- */
class MockSheet {
  constructor(ss, name) { this._ss = ss; this._name = name; this._cells = []; this._frozen = 0; }
  _cell(r, c, create) {
    if (!this._cells[r]) { if (!create) return null; this._cells[r] = []; }
    if (!this._cells[r][c] && create) this._cells[r][c] = { v: '' };
    return this._cells[r][c] || null;
  }
  getName() { return this._name; }
  setName(n) { this._name = n; return this; }
  getParent() { return this._ss; }
  getRange(row, col, nr, nc) {
    if (typeof row === 'string') return a1Range(this, row);
    if (nr === undefined) nr = 1;
    if (nc === undefined) nc = 1;
    for (const [v, label] of [[row, 'row'], [col, 'column']]) if (!Number.isInteger(v) || v < 1) throw new Error('Exception: The starting ' + label + ' of the range is too small.');
    if (!Number.isInteger(nr) || nr < 1) throw new Error('Exception: The number of rows in the range must be at least 1.');
    if (!Number.isInteger(nc) || nc < 1) throw new Error('Exception: The number of columns in the range must be at least 1.');
    // 実際のシートと同じく、行数・列数を超える範囲は取れません
    if (row + nr - 1 > this.getMaxRows() || col + nc - 1 > this.getMaxColumns()) throw new Error('Exception: The coordinates of the range are outside the dimensions of the sheet.');
    this._ss._backend.stats.getRange++;
    return new MockRange(this, row, col, nr, nc);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getLastRow() {
    for (let r = this._cells.length - 1; r >= 1; r--) if (this._cells[r] && this._cells[r].some(c => c && c.v !== '')) return r;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this._cells.forEach(row => row && row.forEach((c, i) => { if (c && c.v !== '' && i > m) m = i; }));
    return m;
  }
  getMaxRows() { return this._maxRows === undefined ? 1000 : this._maxRows; }
  // 行の削除・挿入は実際のシートと同じく、右側の列（メモや数式）も行と一緒に動きます
  deleteRow(r) { return this.deleteRows(r, 1); }
  deleteRows(r, n) {
    const max = this.getMaxRows();
    if (!Number.isInteger(r) || !Number.isInteger(n) || r < 1 || n < 1 || r + n - 1 > max) throw new Error('Exception: Those rows are out of bounds.');
    if (max - n <= this._frozen) throw new Error('Exception: Sorry, it is not possible to delete all non-frozen rows.');
    this._cells.splice(r, n);
    this._maxRows = max - n;
    const st = this._ss._backend.stats; st.deleteRows = (st.deleteRows || 0) + 1;
    return this;
  }
  insertRowsAfter(r, n) { const max = this.getMaxRows(); if (this._cells.length > r + 1) this._cells.splice(r + 1, 0, ...new Array(n)); this._maxRows = max + n; return this; }
  insertRows(r, n) { return this.insertRowsAfter(r - 1, n || 1); }
  insertColumnBefore(c) { this._cells.forEach(row => { if (row && row.length > c) row.splice(c, 0, undefined); }); return this; }
  deleteColumns(c, n) { this._cells.forEach(row => { if (row && row.length > c) row.splice(c, n); }); return this; }
  getMaxColumns() { return 26; }
  setFrozenRows(n) { this._frozen = n; return this; }
  getFrozenRows() { return this._frozen; }
  clear() { this._cells = []; return this; }
  clearContents() { this._cells.forEach(row => row && row.forEach(c => { if (c) { c.v = ''; delete c.formula; } })); return this; }
  setColumnWidth() { return this; }
  setColumnWidths() { return this; }
  autoResizeColumns() { return this; }
  activate() { return this; }
  // テスト用: シートの中身（getValues と同じ形）を返す
  _dump() {
    const lr = this.getLastRow(), lc = this.getLastColumn();
    return lr && lc ? this.getRange(1, 1, lr, lc).getValues() : [];
  }
}

function a1Range(sheet, a1) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
  if (!m) throw new Error('Exception: Range not found');
  const col = s => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const r1 = +m[2], c1 = col(m[1]), r2 = m[3] ? +m[4] : r1, c2 = m[3] ? col(m[3]) : c1;
  return sheet.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1);
}

class MockRange {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { _sheet: sheet, _row: row, _col: col, _nr: nr, _nc: nc }); }
  _each(fn) { for (let i = 0; i < this._nr; i++) for (let j = 0; j < this._nc; j++) fn(i, j, this._row + i, this._col + j); }
  getRow() { return this._row; } getColumn() { return this._col; }
  getNumRows() { return this._nr; } getNumColumns() { return this._nc; }
  getSheet() { return this._sheet; }
  getValues() {
    this._sheet._ss._backend.stats.getValues++;
    const out = [];
    for (let i = 0; i < this._nr; i++) { const row = []; for (let j = 0; j < this._nc; j++) row.push(readValue(this._sheet._cell(this._row + i, this._col + j))); out.push(row); }
    return out;
  }
  getDisplayValues() { return this.getValues().map(r => r.map(v => v instanceof Date ? fmtDate(v, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss') : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))); }
  getValue() { return readValue(this._sheet._cell(this._row, this._col)); }
  setValue(v) { return this.setValues([[v]]); }
  setValues(values) {
    if (!Array.isArray(values) || values.length !== this._nr) throw new Error('Exception: The number of rows in the data does not match the number of rows in the range. The data has ' + (Array.isArray(values) ? values.length : 0) + ' but the range has ' + this._nr + '.');
    values.forEach(r => { if (!Array.isArray(r) || r.length !== this._nc) throw new Error('Exception: The number of columns in the data does not match the number of columns in the range. The data has ' + (Array.isArray(r) ? r.length : 0) + ' but the range has ' + this._nc + '.'); });
    this._sheet._ss._backend.stats.setValues++;
    this._each((i, j, r, c) => {
      const cell = this._sheet._cell(r, c, true);
      const stored = storeValue(values[i][j], cell.format);
      cell.v = stored.v;
      if (stored.formula) cell.formula = stored.formula; else delete cell.formula;
    });
    return this;
  }
  clearContent() { this._sheet._ss._backend.stats.clearContent++; this._each((i, j, r, c) => { const cell = this._sheet._cell(r, c); if (cell) { cell.v = ''; delete cell.formula; } }); return this; }
  clear() { this._each((i, j, r, c) => { if (this._sheet._cells[r]) this._sheet._cells[r][c] = undefined; }); return this; }
  setNumberFormat(f) { this._each((i, j, r, c) => { this._sheet._cell(r, c, true).format = f; }); return this; }
  setNumberFormats(fs2) { this._each((i, j, r, c) => { this._sheet._cell(r, c, true).format = fs2[i][j]; }); return this; }
  getNumberFormat() { const c = this._sheet._cell(this._row, this._col); return (c && c.format) || 'General'; }
  getNumberFormats() { const out = []; for (let i = 0; i < this._nr; i++) { const row = []; for (let j = 0; j < this._nc; j++) { const c = this._sheet._cell(this._row + i, this._col + j); row.push((c && c.format) || 'General'); } out.push(row); } return out; }
  getFormulas() { const out = []; for (let i = 0; i < this._nr; i++) { const row = []; for (let j = 0; j < this._nc; j++) { const c = this._sheet._cell(this._row + i, this._col + j); row.push((c && c.formula) || ''); } out.push(row); } return out; }
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; } setWrap() { return this; } setHorizontalAlignment() { return this; }
}

class MockSpreadsheet {
  constructor(backend, name) { this._backend = backend; this._name = name; this._id = 'ss_' + crypto.randomBytes(8).toString('hex'); this._sheets = [new MockSheet(this, 'シート1')]; }
  getId() { return this._id; }
  getName() { return this._name; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this._id + '/edit'; }
  getSheets() { return this._sheets.slice(); }
  getSheetByName(n) { return this._sheets.find(s => s._name === n) || null; }
  insertSheet(n) {
    if (n === undefined) n = 'シート' + (this._sheets.length + 1);
    if (this.getSheetByName(n)) throw new Error('Exception: A sheet with the name "' + n + '" already exists. Please enter another name.');
    const s = new MockSheet(this, n); this._sheets.push(s); return s;
  }
  deleteSheet(s) { this._sheets = this._sheets.filter(x => x !== s); }
  getActiveSheet() { return this._sheets[0]; }
}

/* ---------- 共有部分（スプレッドシート・プロパティ・ロック） ---------- */
function createBackend() {
  const backend = {
    spreadsheets: new Map(),
    props: {},
    lock: { held: false, owner: null, waits: 0, releases: 0, busy: false, maxWaitMs: [] },
    stats: { getRange: 0, getValues: 0, setValues: 0, clearContent: 0, flush: 0 },
    active: null,
  };
  const ss = new MockSpreadsheet(backend, '席くじ（テスト）');
  backend.spreadsheets.set(ss.getId(), ss);
  backend.active = ss;
  return backend;
}

/* ---------- HtmlService ---------- */
class HtmlOutput {
  constructor(content) { this._content = content || ''; this._title = ''; this._meta = []; this._xfo = 'DEFAULT_UNSET'; this._w = null; this._h = null; }
  setTitle(t) { this._title = String(t); return this; }
  getTitle() { return this._title; }
  addMetaTag(name, content) {
    if (!['apple-mobile-web-app-capable', 'google-site-verification', 'mobile-web-app-capable', 'viewport'].includes(name)) throw new Error('Exception: Meta tag ' + name + ' is not allowed.');
    this._meta.push({ name, content }); return this;
  }
  getMetaTags() { return this._meta.map(m => ({ getName: () => m.name, getContent: () => m.content })); }
  setXFrameOptionsMode(m) { if (m === undefined) throw new Error('Exception: Invalid argument: mode'); this._xfo = m; return this; }
  setSandboxMode() { return this; }
  setFaviconUrl() { return this; }
  setWidth(w) { this._w = w; return this; }
  setHeight(h) { this._h = h; return this; }
  getWidth() { return this._w; } getHeight() { return this._h; }
  getContent() { return this._content; }
  setContent(c) { this._content = String(c); return this; }
  append(c) { this._content += String(c); return this; }
  appendUntrusted(c) { this._content += String(c).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); return this; }
  asTemplate() { return new HtmlTemplate(this._content); }
}
class HtmlTemplate {
  constructor(src) { this._src = src; }
  getRawContent() { return this._src; }
  evaluate() {
    // <?= ?>（エスケープ）と <?!= ?>（そのまま）だけ対応
    const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const vars = Object.keys(this).filter(k => k !== '_src');
    const out = this._src.replace(/<\?(!?)=([\s\S]*?)\?>/g, (m, raw, expr) => {
      const v = Function(...vars, 'return (' + expr + ');')(...vars.map(k => this[k]));
      return raw ? String(v) : esc(v);
    });
    return new HtmlOutput(out);
  }
}

/* ---------- コンテキスト ---------- */
function createGasContext(opts = {}) {
  const backend = opts.backend || createBackend();
  const htmlDir = opts.htmlDir || path.join(ROOT, 'gas');
  const logs = [];
  let url = opts.url === undefined ? 'https://script.google.com/macros/s/TESTDEPLOY/exec' : opts.url;
  let uiEnabled = !!opts.ui;
  const ui = createUi(opts.uiResponse || 'YES');

  const readHtmlFile = name => {
    if (opts.htmlFiles && Object.prototype.hasOwnProperty.call(opts.htmlFiles, name)) return opts.htmlFiles[name];
    const base = name.replace(/\.html$/, '');
    const f = path.join(htmlDir, base + '.html');
    if (!fs.existsSync(f)) throw new Error('Exception: No HTML file named ' + base + ' was found.');
    return fs.readFileSync(f, 'utf8');
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => (opts.bound === false ? null : backend.active),
    getActive: () => (opts.bound === false ? null : backend.active),
    openById: id => {
      const ss = backend.spreadsheets.get(String(id));
      if (!ss) throw new Error('Exception: Unexpected error while getting the method or property openById on object SpreadsheetApp.');
      return ss;
    },
    create: name => { const ss = new MockSpreadsheet(backend, name); backend.spreadsheets.set(ss.getId(), ss); return ss; },
    flush: () => { backend.stats.flush++; },
    getUi: () => { if (!uiEnabled) throw new Error('Exception: Cannot call SpreadsheetApp.getUi() from this context.'); return ui; },
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => (Object.prototype.hasOwnProperty.call(backend.props, k) ? backend.props[k] : null),
      setProperty(k, v) { backend.props[k] = String(v); return this; },
      deleteProperty(k) { delete backend.props[k]; return this; },
      getProperties: () => Object.assign({}, backend.props),
      setProperties(o) { for (const k of Object.keys(o)) backend.props[k] = String(o[k]); return this; },
      getKeys: () => Object.keys(backend.props),
    }),
  };

  // スクリプトロック。同じ backend を共有するコンテキスト同士で排他。
  // 処理は同期的に進むので、取得中にもう一度 waitLock されたら（＝ロックの入れ子・解放漏れ）例外にして検出する。
  const LockService = {
    getScriptLock: () => {
      const L = backend.lock;
      let mine = false;
      return {
        waitLock(ms) {
          L.waits++; L.maxWaitMs.push(ms);
          if (L.busy) throw new Error('Exception: Lock timeout: another process was holding the lock for too long.');
          if (L.held) throw new Error('Exception: Lock timeout: another process was holding the lock for too long. (mock: lock already held — nested or leaked lock)');
          L.held = true; mine = true;
        },
        tryLock() { if (L.busy || L.held) return false; L.held = true; mine = true; return true; },
        releaseLock() { if (mine) { L.held = false; mine = false; L.releases++; } },
        hasLock: () => mine,
      };
    },
  };

  const Utilities = {
    getUuid: () => crypto.randomUUID(),
    formatDate: (d, tz, p) => fmtDate(d, tz, p),
    base64Encode: s => Buffer.from(typeof s === 'string' ? s : Buffer.from(s)).toString('base64'),
    base64Decode: s => Array.from(Buffer.from(s, 'base64')).map(b => (b > 127 ? b - 256 : b)),
    sleep: () => {},
  };

  const ScriptApp = { getService: () => ({ getUrl: () => url, isEnabled: () => !!url }) };

  const HtmlService = {
    createHtmlOutput: c => new HtmlOutput(c === undefined ? '' : String(c)),
    createHtmlOutputFromFile: name => new HtmlOutput(readHtmlFile(name)),
    createTemplate: src => new HtmlTemplate(String(src)),
    createTemplateFromFile: name => new HtmlTemplate(readHtmlFile(name)),
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    SandboxMode: { IFRAME: 'IFRAME', NATIVE: 'NATIVE', EMULATED: 'EMULATED' },
  };

  const ContentService = {
    createTextOutput: (c = '') => { const o = { _c: String(c), _m: 'TEXT', getContent: () => o._c, setMimeType: m => { o._m = m; return o; }, getMimeType: () => o._m, append: t => { o._c += t; return o; } }; return o; },
    MimeType: { TEXT: 'TEXT', JSON: 'JSON', CSV: 'CSV', JAVASCRIPT: 'JAVASCRIPT' },
  };

  const Logger = { log: (...a) => { logs.push(a.map(String).join(' ')); return Logger; }, getLog: () => logs.join('\n'), clear: () => { logs.length = 0; } };
  const Session = {
    getActiveUser: () => ({ getEmail: () => '' }),
    getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }),
    getScriptTimeZone: () => 'Asia/Tokyo',
    getTemporaryActiveUserKey: () => 'tmpkey',
  };

  const ctx = {
    SpreadsheetApp, PropertiesService, LockService, Utilities, ScriptApp, HtmlService, ContentService, Logger, Session,
    console: opts.console || { log() {}, info() {}, warn() {}, error() {} },
  };
  vm.createContext(ctx);
  if (opts.random) { Object.defineProperty(ctx, '__rand', { value: opts.random }); vm.runInContext('Math.random=function(){return __rand();};', ctx); }
  const codePath = opts.codePath || path.join(ROOT, 'gas', 'Code.gs');
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx, { filename: 'Code.gs' });

  Object.defineProperty(ctx, '__mock', {
    enumerable: false,
    value: {
      backend, logs, ui,
      get props() { return backend.props; },
      get spreadsheet() { return backend.active; },
      sheet: name => { for (const ss of backend.spreadsheets.values()) { const s = ss.getSheetByName(name); if (s) return s; } return null; },
      values: name => { const s = ctx.__mock.sheet(name); return s ? s._dump() : null; },
      setUrl: u => { url = u; },
      setUi: on => { uiEnabled = !!on; },
      setLockBusy: on => { backend.lock.busy = !!on; },
      run: code => vm.runInContext(code, ctx),
    },
  });
  return ctx;
}

function createUi(response) {
  const ui = {
    alerts: [], dialogs: [], menus: [],
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' },
    Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' },
    response,
    alert(...a) { ui.alerts.push(a); return a.length >= 3 ? ui.response : 'OK'; },
    showModalDialog(out, title) { ui.dialogs.push({ title, html: out.getContent(), width: out.getWidth(), height: out.getHeight() }); },
    showModelessDialog(out, title) { ui.dialogs.push({ title, html: out.getContent() }); },
    createMenu(name) {
      const m = { name, items: [] };
      const b = { addItem(label, fn) { m.items.push([label, fn]); return b; }, addSeparator() { return b; }, addToUi() { ui.menus.push(m); } };
      return b;
    },
  };
  return ui;
}

/*
 * google.script.run と同じように公開関数を呼ぶ。
 * ・末尾「_」の関数や存在しない関数は呼べない（実際の GAS と同じ）
 * ・引数と戻り値は JSON で直列化。オブジェクトの undefined のプロパティは消え、配列の中の undefined は null になる
 * ・戻り値に Date・関数・プレーンでないオブジェクトが含まれていると、実際の GAS と同じく戻り値全体が null になる
 * ・例外は { message } を持つ Error として投げ直す
 */
function isLegalValue(v, depth = 0) {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  if (t !== 'object' || depth > 50) return false;
  if (Array.isArray(v)) return v.every(x => isLegalValue(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  // vm のコンテキストで作られたオブジェクトは Object.prototype が別物なので、名前で判定する
  if (proto !== null && Object.prototype.toString.call(v) !== '[object Object]') return false;
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return false;
  return Object.keys(v).every(k => isLegalValue(v[k], depth + 1));
}
function callServer(ctx, name, args = []) {
  if (typeof name !== 'string' || /_$/.test(name) || !/^[A-Za-z$][\w$]*$/.test(name)) throw new Error('Script function not found: ' + name);
  const fn = ctx[name];
  if (typeof fn !== 'function') throw new Error('Script function not found: ' + name);
  const inArgs = JSON.parse(JSON.stringify(args));
  let result;
  try { result = fn.apply(null, inArgs); } catch (err) { const e = new Error(err && err.message !== undefined ? err.message : String(err)); e.name = 'ScriptError'; throw e; }
  if (result === undefined) return undefined;
  if (!isLegalValue(result)) return null;
  return JSON.parse(JSON.stringify(result));
}

module.exports = { createGasContext, createBackend, callServer, isLegalValue, fmtDate, MockSpreadsheet, HtmlOutput };
