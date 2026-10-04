// 在庫管理 Apps Script Web API + 自動減算 + メール通知 + ログ
// シート: Items / Settings / StockLog
// エントリ: doGet(e), doPost(e)
// 主関数: getItems, getShortages, updateStock, runDailyDecrement, sendAlertEmail,
//         logChange, getSeasonFactor, seasonTag, installDaily, ping

// ===== エントリポイント =====
function doGet(e) {
  try {
    const path = (e && e.parameter && e.parameter.path) || '';
    if (path === '/items') {
      return json({ ok: true, data: getItems() });
    }
    if (path === '/shortages') {
      return json({ ok: true, data: getShortages() });
    }
    if (path === '/ping') {
      return json({ ok: true, data: ping() });
    }
    if (path === '/food/status') {
      return json({ ok: true, data: getFoodStatus() });
    }
    return json({ ok: false, error: 'Unknown path' }, 404);
  } catch (err) {
    return json({ ok: false, error: String(err && err.stack || err) }, 500);
  }
}

function doPost(e) {
  try {
    const path = (e && e.parameter && e.parameter.path) || '';
    const bodyText = (e && e.postData && e.postData.contents) || '{}';
    const body = JSON.parse(bodyText);

    if (path === '/stock/update') {
      var id = Number(body.id);
      var value = Number(body.value);
      if (!isFinite(id) || id <= 0) throw new Error('不正なID: ' + body.id);
      if (!isFinite(value) || value < 0 || value > 99999) throw new Error('不正な値: ' + body.value);
      updateStock(id, value);
      return json({ ok: true, data: { id: id, value: value } });
    }
    if (path === '/stock/batch-update') {
      const items = body.items; // [{id, value}, ...]
      if (!Array.isArray(items)) throw new Error('items配列が必要です');
      if (items.length > 500) throw new Error('一度に更新できるのは500件までです');
      const results = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var bid = Number(item.id);
        var bval = Number(item.value);
        if (!isFinite(bid) || bid <= 0) throw new Error('不正なID: ' + item.id);
        if (!isFinite(bval) || bval < 0 || bval > 99999) throw new Error('不正な値: ' + item.value);
        updateStock(bid, bval);
        results.push({ id: bid, value: bval });
      }
      return json({ ok: true, data: { updated: results.length, items: results } });
    }
    if (path === '/food/snapshot') {
      saveFoodSnapshot(body);
      return json({ ok: true, data: { saved: true } });
    }
    if (path === '/food/pin-check') {
      checkFoodPin(body.pin);
      return json({ ok: true, data: { valid: true } });
    }
    if (path === '/food/event') {
      checkFoodPin(body.pin);
      return json({ ok: true, data: recordFoodEvent(body) });
    }
    if (path === '/decrement/run') {
      const result = runDailyDecrement();
      return json({ ok: true, data: result });
    }
    return json({ ok: false, error: 'Unknown path' }, 404);
  } catch (err) {
    return json({ ok: false, error: String(err && err.stack || err) }, 500);
  }
}

// ===== ユーティリティ =====
function json(obj, status) {
  const out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  out.setContent(JSON.stringify(obj));
  return out;
}

function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('シートが見つかりません: ' + name);
  return sh;
}

function indexer(headers) {
  const idx = {};
  headers.forEach((h, i) => { idx[String(h).trim()] = i; });
  return idx;
}

// 文字化け・表記ゆれに強い列解決
function pickIndex(idx, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var key = String(candidates[i]).trim();
    if (idx.hasOwnProperty(key)) return idx[key];
  }
  return null;
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function str(v) {
  return (v == null ? '' : String(v)).trim();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function getSettingsMap() {
  const sh = sheet('Settings');
  const values = sh.getDataRange().getValues();
  const map = {};
  for (let r = 1; r < values.length; r++) {
    const k = str(values[r][0]);
    const v = values[r][1];
    if (!k) continue;
    map[k] = v;
  }
  return map;
}

// ===== データ取得 =====
function getItems() {
  const sh = sheet('Items');
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const result = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(v => v === '' || v == null)) continue;
    const obj = {};
    headers.forEach((h, i) => obj[String(h).trim()] = row[i]);
    result.push(obj);
  }
  return result;
}

function getShortages() {
  var list = getItems();
  return list.filter(function (it) {
    var cur = num(it['現在庫数']);
    var min = num(it['最低在庫数']);
    return cur < min;
  });
}

// ===== 在庫更新・ログ =====
function updateStock(id, newValue) {
  if (!isFinite(id) || id <= 0) throw new Error('IDが不正です: ' + id);
  const sh = sheet('Items');
  const values = sh.getDataRange().getValues();
  if (values.length < 2) throw new Error('Itemsにデータがありません');
  const headers = values[0];
  const idx = indexer(headers);
  const colId = pickIndex(idx, ['ID', 'Id', 'id']);
  const colCur = pickIndex(idx, ['現在庫数']);
  const colName = pickIndex(idx, ['商品名', '啁E��吁E']);
  if (colId == null || colCur == null || colName == null) throw new Error('必要な列がありません');

  for (let r = 1; r < values.length; r++) {
    const rid = Number(values[r][colId]);
    if (rid === Number(id)) {
      const before = num(values[r][colCur]);
      const after = Math.max(0, round2(num(newValue)));
      sh.getRange(r + 1, colCur + 1).setValue(after);
      logChange({ name: values[r][colName], before, delta: round2(after - before), after, kind: '手動' });
      return;
    }
  }
  throw new Error('指定IDが見つかりません: ' + id);
}

function logChange(rec) {
  const sh = sheet('StockLog');
  sh.appendRow([
    new Date(), // 日時
    rec.name || '', // 商品名
    num(rec.before), // 前在庫
    num(rec.delta), // 変化量
    num(rec.after), // 後在庫
    rec.kind || '' // 種別
  ]);
}

// ===== 自動減算 =====
function runDailyDecrement() {
  const itemsSh = sheet('Items');
  const values = itemsSh.getDataRange().getValues();
  if (values.length < 2) return { updated: 0, shortages: [] };
  const headers = values[0];
  const idx = indexer(headers);
  const colId = pickIndex(idx, ['ID', 'Id', 'id']);
  const colName = pickIndex(idx, ['商品名', '啁E��吁E']);
  const colCur = pickIndex(idx, ['現在庫数']);
  const colBase = pickIndex(idx, ['基本日次量', '基本日次釁E']);
  const colUnit = pickIndex(idx, ['単位', '単佁E']);
  const colMin = pickIndex(idx, ['最低在庫数']);
  const colSkipSummer = pickIndex(idx, ['夏は自動減算オフ', '夏の自動減算オフ', '夏�E自動減算オチE']);
  const colAskul = pickIndex(idx, ['アスクル日次量']);
  const colPos = pickIndex(idx, ['POS連動']);

  if ([colId, colName, colCur, colBase].some(v => v == null)) {
    throw new Error('必要な列が不足しています（ID/商品名/現在庫数/基本日次量）');
  }

  const today = new Date();
  const tag = seasonTag(today);
  const settings = getSettingsMap();
  const seasonFactor = getSeasonFactor(tag, settings);
  const isWeekend = [0, 6].indexOf(today.getDay()) >= 0;
  const weekendFactor = isWeekend ? Number(settings['WEEKEND_FACTOR'] || 1.2) : 1.0;

  let updated = 0;
  const toSet = [];
  // カップはPOSの実売（マルシェ）で減らす。取れなければカップだけ今日は減らさず、翌日まとめて引く
  const pos = loadPosCupUsage();

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(v => v === '' || v == null)) continue;

    const posKind = posLinkOf(colPos != null ? row[colPos] : '', row[colName]);
    // フタ: POSが持ち帰りを記録し始める前（その期間に記録のある日が1日も無い）は従来の基本量で減らす
    const lidNotReady = posKind === 'LID' && pos.ok && pos.days.length > 0 && !pos.lidReady;
    if (posKind && !lidNotReady) {
      if (!pos.ok) continue; // 基本量で減らすと、翌日の実売とで二重に引いてしまう
      // ロゴカップ(Sカップ)は店頭のS・Mに加えて発送セットにも使う（田川さん 2026-10-04）
      const used = posKind === 'W' ? pos.wCups : posKind === 'LID' ? pos.lids : pos.sCups + pos.shipCups;
      if (used <= 0) continue;
      const before = num(row[colCur]);
      const after = Math.max(0, round2(before - used));
      toSet.push({ row: r + 1, col: colCur + 1, value: after });
      const what = posKind === 'W' ? 'W'
        : posKind === 'LID' ? '持ち帰り' + pos.takeoutCups + '+発送' + pos.shipCups
        : 'S・M' + pos.sCups + (pos.shipCups ? '+発送' + pos.shipCups : '');
      logChange({ name: row[colName], before, delta: round2(after - before), after, kind: 'POS実売(' + pos.label + ' ' + what + ')' });
      updated++;
      continue;
    }

    const name = row[colName];
    const base = num(row[colBase]);
    let cur = num(row[colCur]);
    const unit = str(colUnit != null ? row[colUnit] : '');
    const skipSummer = colSkipSummer != null ? String(row[colSkipSummer]).toUpperCase() === 'TRUE' : false;

    if (tag === 'summer' && skipSummer) {
      continue; // 夏の自動減算オフ
    }

    // アスクルの発注実績から出した1日あたり（refreshAskulRates が週1で更新）があればそちらを使う。
    // 1年の平均なので季節・土日の係数は掛けない（掛けると平均より多く減る）
    const askulDaily = colAskul != null ? num(row[colAskul]) : 0;
    const dec = askulDaily > 0 ? askulDaily : base * seasonFactor * weekendFactor;
    if (dec <= 0) continue;

    const before = cur;
    const after = Math.max(0, round2(cur - dec));
    if (after !== before) {
      toSet.push({ row: r + 1, col: colCur + 1, value: after });
      logChange({ name, before, delta: round2(after - before), after, kind: askulDaily > 0 ? '自動減算(アスクル実績)' : '自動減算(' + tag + ')' });
      updated++;
    }
  }

  // バッチで反映
  toSet.forEach(x => itemsSh.getRange(x.row, x.col).setValue(x.value));
  // 反映し終えてから「どの営業日まで引いたか」を進める（途中で落ちたら翌日やり直せるように）
  if (pos.ok) PropertiesService.getScriptProperties().setProperty('POS_CUPS_LAST_DAY', pos.through);

  // 不足抽出 + メール送信
  const deficits = [];
  if (colMin != null) {
    const afterValues = itemsSh.getDataRange().getValues();
    for (let r = 1; r < afterValues.length; r++) {
      const row = afterValues[r];
      if (row.every(v => v === '' || v == null)) continue;
      const cur = num(row[colCur]);
      const min = num(row[colMin]);
      if (cur < min) {
        deficits.push({
          name: row[colName],
          current: cur,
          min: min,
          unit: colUnit != null ? str(row[colUnit]) : ''
        });
      }
    }
  }

  const to = str(settings['ALERT_EMAIL_TO']);
  if (to) {
    sendAlertEmail(to, deficits, pos.ok ? null : pos.error);
  }

  return { updated: updated, shortages: deficits, posCups: pos };
}

function seasonTag(date) {
  const m = (date.getMonth() + 1); // 1-12
  if (m === 11 || m === 12 || m === 1 || m === 2) return 'winter';
  if (m >= 6 && m <= 9) return 'summer';
  return 'mid';
}

function getSeasonFactor(tag, settings) {
  if (tag === 'winter') return Number(settings['FACTOR_WINTER'] || 0.5);
  if (tag === 'summer') return Number(settings['FACTOR_SUMMER'] || 1.5);
  return Number(settings['FACTOR_MID'] || 1.0);
}

// ===== 通知メール =====
function sendAlertEmail(to, deficits, posError) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = ('0' + (now.getMonth() + 1)).slice(-2);
  const dd = ('0' + now.getDate()).slice(-2);
  const dateStr = `${yyyy}/${mm}/${dd}`;
  const cnt = deficits.length;

  const subject = `【在庫アラート】${dateStr} 不足: ${cnt}件`;

  const lines = [];
  lines.push(`【在庫アラート】${dateStr}`);
  if (posError) {
    lines.push(`⚠ POSの実売が取れなかったため、カップは今日は減らしていません（明日まとめて引きます）: ${posError}`);
    lines.push('');
  }
  lines.push('下限を下回った品目です:');
  deficits.forEach(d => {
    lines.push(`・${d.name} 現在${round2(d.current)}${d.unit} / 下限${round2(d.min)}${d.unit}`);
  });
  lines.push('');
  lines.push('ソロエル検索リンク:');
  deficits.forEach(d => {
    const url = soloelUrlForMail(d.name);
    lines.push(url);
  });
  const body = lines.join('\n');

  MailApp.sendEmail({ to: to, subject: subject, body: body });
}

function soloelUrlForMail(itemName) {
  // Itemsの「ソロエルURL（任意）」が空なら検索リンク
  try {
    const sh = sheet('Items');
    const values = sh.getDataRange().getValues();
    if (values.length < 2) return `https://solution.soloel.com/s/?q=${encodeURIComponent(itemName)}`;
    const headers = values[0];
    const idx = indexer(headers);
    const colName = pickIndex(idx, ['商品名', '啁E��吁E']);
    const colSoloel = pickIndex(idx, ['ソロエルURL（任意）', 'ソロエルURL', 'ソロエルURL�E�任意！E']);
    for (let r = 1; r < values.length; r++) {
      if (values[r][colName] === itemName) {
        const direct = colSoloel != null ? str(values[r][colSoloel]) : '';
        if (direct) return direct;
        break;
      }
    }
  } catch (e) {}
  return `https://solution.soloel.com/s/?q=${encodeURIComponent(itemName)}`;
}

// ===== トリガー設定 =====
function installDaily() {
  // 既存の runDailyDecrement トリガーを削除
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction && t.getHandlerFunction() === 'runDailyDecrement') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // 毎日 8:00 に実行
  ScriptApp.newTrigger('runDailyDecrement').timeBased().atHour(8).everyDays(1).create();
}

// アスクル実績の週1更新（月曜7時）。初回は手動で refreshAskulRates を実行してGmailの権限を許可する
function installAskulWeekly() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction && t.getHandlerFunction() === 'refreshAskulRates') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshAskulRates').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
}

// ===== ヘルスチェック =====
function ping() {
  return { time: new Date().toISOString() };
}



// ===== 食材（需要予測・POS実売連携） =====
// 食材14品目の在庫計算は gojiemon/woodberrys-demand-forecast（POS実売ベース）が正。
// ここはその「画面」: 朝バッチの判定結果を預かって見せ、アプリからの記録を woodberrys-ec へ中継する。
// 鍵はすべてスクリプトプロパティに置く（このリポジトリは公開なのでコードに書かない）:
//   ZAIKO_SNAPSHOT_SECRET … 朝バッチ（GitHub Actions secrets の同名値）と一致させる
//   FOOD_PIN             … アプリで記録するときの合言葉（田川さんが決める）
//   ORDERING_API_URL     … https://<ECのドメイン>/api/ordering/stock
//   ORDERING_API_TOKEN   … 読み取り用（朝バッチと同じ値）
//   ORDERING_WRITE_TOKEN … 書き込み用（EC側 Vercel env と同じ値）
function prop(key) {
  return str(PropertiesService.getScriptProperties().getProperty(key));
}

function saveFoodSnapshot(body) {
  const secret = prop('ZAIKO_SNAPSHOT_SECRET');
  if (!secret) throw new Error('ZAIKO_SNAPSHOT_SECRET 未設定');
  if (str(body.secret) !== secret) throw new Error('unauthorized');
  const snap = body.snapshot;
  if (!snap || !Array.isArray(snap.items)) throw new Error('snapshot.items が必要です');
  const text = JSON.stringify(snap);
  // スクリプトプロパティは1値9KBまで（14品目でおよそ3KB）
  if (text.length > 9000) throw new Error('snapshot が大きすぎます: ' + text.length);
  PropertiesService.getScriptProperties().setProperty('FOOD_SNAPSHOT', text);
}

function checkFoodPin(pin) {
  const expected = prop('FOOD_PIN');
  if (!expected) throw new Error('FOOD_PIN 未設定（スクリプトプロパティに合言葉を設定してください）');
  if (str(pin) !== expected) throw new Error('合言葉が違います');
}

// 朝の判定結果 + その後の記録（LINE・アプリ両方）。記録の取得に失敗しても判定結果は返す
function getFoodStatus() {
  const raw = prop('FOOD_SNAPSHOT');
  const snapshot = raw ? JSON.parse(raw) : null;
  let events = null;
  let eventsError = null;
  const url = prop('ORDERING_API_URL');
  const token = prop('ORDERING_API_TOKEN');
  if (url && token) {
    try {
      const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
      if (res.getResponseCode() === 200) events = JSON.parse(res.getContentText()).items || null;
      else eventsError = 'EC ' + res.getResponseCode();
    } catch (e) {
      eventsError = String(e);
    }
  }
  return { snapshot: snapshot, events: events, eventsError: eventsError };
}

function recordFoodEvent(body) {
  const url = prop('ORDERING_API_URL');
  const token = prop('ORDERING_WRITE_TOKEN');
  if (!url || !token) throw new Error('ORDERING_API_URL / ORDERING_WRITE_TOKEN 未設定');
  const payload = {
    kind: str(body.kind),
    item: str(body.item),
    qty: Number(body.qty),
    unit: body.unit ? str(body.unit) : null
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const out = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200 || !out.ok) throw new Error('記録に失敗: ' + (out.error || res.getResponseCode()));
  return { duplicate: !!out.duplicate, at: out.at };
}


// ===== アスクルの発注実績から「1日あたりの減り方」を出す =====
// 考え方: 消耗品は「買った量 ≒ 使った量」（長い目で見れば在庫は増え続けも減り続けもしない）。
// だから直近1年の発送数量 ÷ 日数 を、その品目の実績の減り方とみなす。
// 元データはGmailの「【アスクル】商品発送のお知らせ」（届いた＝実際に買った分。注文取消しは含まれない）。
//
// 手順:
// 1. refreshAskulRates を実行 → シート「AskulHistory」に品番ごとの1年の数量が並ぶ
// 2. AskulHistory の「在庫管理の商品名」に Items の商品名を選ぶ（同じ品目に複数の品番を紐付けてOK）
//    「換算」に 1個（1箱）が在庫の単位でいくつか を入れる（例: エンボス手袋100枚入×在庫単位が枚 → 100）
// 3. もう一度 refreshAskulRates → Items の「アスクル日次量」が埋まり、毎朝の自動減算がそれを使う
const ASKUL_SHEET = 'AskulHistory';
// この在庫管理はマルシェ店のもの（田川さん 2026-10-04）。本店宛ての発送は数えない
const ASKUL_STORE = 'マルシェ';
const ASKUL_WINDOW_DAYS = 365;
const ASKUL_HEADERS = ['品番', '商品名（アスクル）', '期間内の数量', '発送回数', '最初の発送', '最後の発送',
  '在庫管理の商品名', '換算（1個＝在庫いくつ）', '1日あたり（換算後）'];

// 発送メール本文から [{code, name, qty}] を取り出す（「お申込番号 商品名 数量」の表。メーカー直送は「商品番号」）
function parseAskulShipment(body) {
  const out = [];
  let inTable = false;
  String(body).normalize('NFKC').split(/\r?\n/).forEach(function (raw) {
    const line = raw.trim();
    if (/^(お申込番号|商品番号)\s+商品名\s+数量$/.test(line)) { inTable = true; return; }
    if (!inTable) return;
    if (/^-{10,}$/.test(line)) return; // 表の罫線（見出しの直後と表の終わり）
    const m = line.match(/^([0-9A-Z]{4,10})\s+(.+?)\s+(\d+)$/);
    if (m) out.push({ code: m[1], name: m[2].replace(/\s+/g, ' '), qty: Number(m[3]) });
    else if (line && !/^-+$/.test(line)) inTable = false; // 表の外に出た
  });
  return out;
}

// 届け先からどの店宛てかを判定。「お届け先情報」欄の会社名/部署名/住所で見る
// マルシェ: 吉祥寺本町1-20-14 クスミビル / 本店: 吉祥寺南町1-4-1 井の頭ビル
function askulStoreOf(body) {
  const text = String(body).normalize('NFKC');
  const i = text.indexOf('お届け先情報');
  const dest = (i >= 0 ? text.slice(i, i + 400) : text).replace(/\s+/g, '');
  if (dest.indexOf('マルシェ') >= 0 || dest.indexOf('本町1-20-14') >= 0) return 'マルシェ';
  if (dest.indexOf('本店') >= 0 || dest.indexOf('南町1-4-1') >= 0) return '本店';
  return '不明';
}

function refreshAskulRates() {
  const now = new Date();
  const since = new Date(now.getTime() - ASKUL_WINDOW_DAYS * 86400000);
  const byCode = {};
  const seen = {};
  let oldest = null;
  const skipped = { '本店': 0, '不明': 0 };
  for (let start = 0; start < 2000; start += 100) {
    const threads = GmailApp.search('from:askul.co.jp subject:"商品発送のお知らせ" newer_than:' + ASKUL_WINDOW_DAYS + 'd', start, 100);
    if (!threads.length) break;
    threads.forEach(function (th) {
      th.getMessages().forEach(function (msg) {
        if (seen[msg.getId()]) return;
        seen[msg.getId()] = true;
        if (msg.getSubject().indexOf('発送') < 0) return;
        const at = msg.getDate();
        if (at < since) return;
        if (!oldest || at < oldest) oldest = at; // 期間の判定は店に関係なく（メールの残り具合を見る）
        const body = msg.getPlainBody();
        const store = askulStoreOf(body);
        if (store !== ASKUL_STORE) { skipped[store] = (skipped[store] || 0) + 1; return; }
        parseAskulShipment(body).forEach(function (it) {
          const c = (byCode[it.code] = byCode[it.code] || { name: it.name, qty: 0, times: 0, first: at, last: at });
          c.qty += it.qty;
          c.times += 1;
          if (at < c.first) c.first = at;
          if (at > c.last) { c.last = at; c.name = it.name; }
        });
      });
    });
    if (threads.length < 100) break;
  }
  // メールが1年分そろっていない場合は、ある期間で割る（短すぎると暴れるので最低30日）
  const days = Math.max(30, oldest ? Math.min(ASKUL_WINDOW_DAYS, (now - oldest) / 86400000) : ASKUL_WINDOW_DAYS);

  // 田川さんが入れた紐付け・換算は品番をキーに引き継ぐ
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(ASKUL_SHEET) || ss.insertSheet(ASKUL_SHEET);
  const prev = {};
  const old = sh.getDataRange().getValues();
  for (let r = 1; r < old.length; r++) {
    const code = str(old[r][0]);
    if (code) prev[code] = { item: str(old[r][6]), factor: old[r][7] };
  }
  Object.keys(prev).forEach(function (code) {
    // 1年以内に発送がなくなった品番も、紐付けが入っていれば行を残す（数量0＝もう買っていない）
    if (!byCode[code] && prev[code].item) byCode[code] = { name: str(old.find(function (r) { return str(r[0]) === code; })[1]), qty: 0, times: 0, first: null, last: null };
  });

  const rows = Object.keys(byCode).sort(function (a, b) { return byCode[b].times - byCode[a].times; }).map(function (code) {
    const c = byCode[code];
    const p = prev[code] || { item: '', factor: '' };
    const factor = p.factor === '' || p.factor == null ? 1 : num(p.factor);
    return [code, c.name, c.qty, c.times, c.first || '', c.last || '', p.item, p.factor === '' || p.factor == null ? '' : p.factor,
      p.item ? round2(c.qty * factor / days) : ''];
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, ASKUL_HEADERS.length).setValues([ASKUL_HEADERS]);
  if (rows.length) sh.getRange(2, 1, rows.length, ASKUL_HEADERS.length).setValues(rows);
  sh.getRange(1, 1, 1, ASKUL_HEADERS.length).setFontWeight('bold');
  sh.setFrozenRows(1);

  // 「在庫管理の商品名」を Items の商品名から選べるようにする
  const itemsSh = sheet('Items');
  const itemValues = itemsSh.getDataRange().getValues();
  const idx = indexer(itemValues[0]);
  const colName = pickIndex(idx, ['商品名', '啁E��吁E']);
  const names = itemValues.slice(1).map(function (r) { return str(r[colName]); }).filter(String);
  if (rows.length && names.length) {
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(names, true).setAllowInvalid(true).build();
    sh.getRange(2, 7, rows.length, 1).setDataValidation(rule);
  }

  // Items に「アスクル日次量」を書く（紐付けのない品目は空欄＝従来の基本日次量×係数のまま）
  const perItem = {};
  rows.forEach(function (r) {
    if (r[6] && r[8] !== '') perItem[r[6]] = (perItem[r[6]] || 0) + Number(r[8]);
  });
  let colAskul = pickIndex(idx, ['アスクル日次量']);
  if (colAskul == null) {
    colAskul = itemValues[0].length;
    itemsSh.getRange(1, colAskul + 1).setValue('アスクル日次量');
  }
  const out = itemValues.slice(1).map(function (r) {
    const v = perItem[str(r[colName])];
    return [v != null ? round2(v) : ''];
  });
  if (out.length) itemsSh.getRange(2, colAskul + 1, out.length, 1).setValues(out);

  // 不明が多いときは届け先の書式が変わった可能性がある（マルシェ分の取りこぼし）
  return { codes: rows.length, linked: Object.keys(perItem).length, days: Math.round(days), skippedHonten: skipped['本店'], skippedUnknown: skipped['不明'] };
}


// ===== カップはPOSの実売で減らす（マルシェ） =====
// 田川さん 2026-10-04: フロヨのS・Mは全部ロゴカップ、ダブル(W)は大きいカップを使う。発送セットもロゴカップ。
// （シート上の名前: ロゴカップ＝「Sカップ」、大きいカップ＝「Wカップ」または「ダブルカップ」）
// → Items の「POS連動」列に「S・M」か「W」を入れた品目は、基本日次量ではなく
//    前日までのマルシェのPOS実売の個数で減らす（列が無ければ商品名 Sカップ/ロゴカップ/Wカップ/ダブルカップ で判定）。
// 実売は woodberrys-ec の在庫API（?store=marche）の actuals から取る。S・M=sCups、W=wCups。
// フタ（Sフタ / POS連動「フタ」）: 田川さん「フタは持ち帰りと発送にしか使わない」→ 持ち帰りS・M＋発送セットのカップ数。
//   POSが持ち帰りを保存するのは 2026-10-04 の変更以降。記録のある日が無い間は従来の基本量で減らす。
// 引いた営業日はスクリプトプロパティ POS_CUPS_LAST_DAY に記録し、
// トリガーが止まった日があっても次の実行でその分までまとめて引く（直近35日まで）。
function posLinkOf(cell, name) {
  const v = str(cell).normalize('NFKC').toUpperCase().replace(/\s/g, '');
  if (v) {
    if (v.indexOf('フタ') >= 0 || v.indexOf('蓋') >= 0) return 'LID';
    if (v === 'W' || v.indexOf('ダブル') >= 0) return 'W';
    if (v.indexOf('S') >= 0 || v.indexOf('M') >= 0) return 'SM';
    return null; // 「なし」等
  }
  const n = str(name).normalize('NFKC').replace(/\s/g, '');
  if (n === 'Sカップ' || n === 'ロゴカップ') return 'SM';
  if (n === 'Wカップ' || n === 'ダブルカップ') return 'W';
  if (n === 'Sフタ' || n === 'S蓋') return 'LID';
  return null;
}

function jstDay(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function loadPosCupUsage() {
  const today = jstDay(new Date());
  const yesterday = jstDay(new Date(Date.now() - 86400000));
  // 初回は前日分だけ引く（過去の分は棚卸し済みの在庫に含まれている前提）
  const last = prop('POS_CUPS_LAST_DAY') || jstDay(new Date(Date.now() - 2 * 86400000));
  const url = prop('ORDERING_API_URL');
  const token = prop('ORDERING_API_TOKEN');
  if (!url || !token) return { ok: false, error: 'ORDERING_API_URL / ORDERING_API_TOKEN 未設定' };
  try {
    const res = UrlFetchApp.fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'store=marche', {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return { ok: false, error: 'EC ' + res.getResponseCode() };
    const actuals = JSON.parse(res.getContentText()).actuals;
    // 店で絞れていない（2店計の）実売で引くと倍速で減るので使わない
    if (!actuals || actuals.store !== 'marche') return { ok: false, error: '実売データなし（店舗絞り込み未対応のAPI）' };
    const days = Object.keys(actuals.days || {}).filter(d => d > last && d < today).sort();
    let sCups = 0, wCups = 0, takeoutCups = 0, shipCups = 0, lidReady = false;
    days.forEach(d => {
      const a = actuals.days[d];
      sCups += num(a.sCups);
      wCups += num(a.wCups);
      takeoutCups += num(a.takeoutCups);
      shipCups += num(a.shipCups);
      if (a.takeoutTracked) lidReady = true;
    });
    const label = days.length === 0 ? '営業なし' : days.length === 1 ? days[0].slice(5).replace('-', '/') : days[0].slice(5).replace('-', '/') + '〜' + days[days.length - 1].slice(5).replace('-', '/');
    return { ok: true, sCups: sCups, wCups: wCups, takeoutCups: takeoutCups, shipCups: shipCups, lids: takeoutCups + shipCups,
      lidReady: lidReady, days: days, through: yesterday > last ? yesterday : last, label: label };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
