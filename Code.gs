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
  const colSkipSummer = pickIndex(idx, ['夏の自動減算オフ', '夏�E自動減算オチE']);

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

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(v => v === '' || v == null)) continue;

    const name = row[colName];
    const base = num(row[colBase]);
    let cur = num(row[colCur]);
    const unit = str(colUnit != null ? row[colUnit] : '');
    const skipSummer = colSkipSummer != null ? String(row[colSkipSummer]).toUpperCase() === 'TRUE' : false;

    if (tag === 'summer' && skipSummer) {
      continue; // 夏の自動減算オフ
    }

    const dec = base * seasonFactor * weekendFactor;
    if (dec <= 0) continue;

    const before = cur;
    const after = Math.max(0, round2(cur - dec));
    if (after !== before) {
      toSet.push({ row: r + 1, col: colCur + 1, value: after });
      logChange({ name, before, delta: round2(after - before), after, kind: '自動' });
      updated++;
    }
  }

  // バッチで反映
  toSet.forEach(x => itemsSh.getRange(x.row, x.col).setValue(x.value));

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
    sendAlertEmail(to, deficits);
  }

  return { updated: updated, shortages: deficits };
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
function sendAlertEmail(to, deficits) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = ('0' + (now.getMonth() + 1)).slice(-2);
  const dd = ('0' + now.getDate()).slice(-2);
  const dateStr = `${yyyy}/${mm}/${dd}`;
  const cnt = deficits.length;

  const subject = `【在庫アラート】${dateStr} 不足: ${cnt}件`;

  const lines = [];
  lines.push(`【在庫アラート】${dateStr}`);
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
