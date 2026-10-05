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
  const colPerCust = pickIndex(idx, ['1客あたり']);

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
  // POSの実売（マルシェ）: カップ・フタは個数そのもの、それ以外は売上連動の比率に使う。
  // 取れなければ今日は減らさず、翌日まとめて引く
  const pos = loadPosCupUsage();

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(v => v === '' || v == null)) continue;

    const posKind = posLinkOf(colPos != null ? row[colPos] : '', row[colName]);
    // フタ: POSが持ち帰りを記録し始める前（その期間に記録のある日が1日も無い）は、下の「売上連動」で減らす
    const lidNotReady = posKind === 'LID' && pos.ok && pos.days.length > 0 && !pos.lidReady;
    // POSの設定（鍵）がまだ無いときは、カップ・フタも下の従来の減らし方に回す（在庫が止まらないように）
    if (posKind && posKind !== 'FIXED' && !lidNotReady && pos.configured) {
      if (!pos.ok) continue; // 基本量で減らすと、翌日の実売とで二重に引いてしまう
      // ロゴカップ(Sカップ)は店頭のS・Mに加えて発送セットにも使う（田川さん 2026-10-04）
      const used = posKind === 'W' ? pos.wCups : posKind === 'LID' ? pos.lids
        : posKind === 'PET' ? pos.namanoseTakeout + pos.wSpecial
        : posKind === 'NAMA_TO' ? pos.namanoseTakeout
        : posKind === 'OPP' ? pos.spoonYes
        : pos.sCups + pos.shipCups;
      if (used <= 0) continue;
      const before = num(row[colCur]);
      const after = Math.max(0, round2(before - used));
      toSet.push({ row: r + 1, col: colCur + 1, value: after });
      const what = posKind === 'W' ? 'W'
        : posKind === 'PET' ? '生のせ持ち帰り' + pos.namanoseTakeout + '+ギリシャ/生しぼりW' + pos.wSpecial
        : posKind === 'NAMA_TO' ? '生のせ持ち帰り' + pos.namanoseTakeout
        : posKind === 'OPP' ? 'スプーンあり' + pos.spoonYes
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

    // 1日あたりの基準量: アスクルの発注実績（refreshAskulRates が週1で更新）があればそれ、無ければ基本日次量
    const askulDaily = colAskul != null ? num(row[colAskul]) : 0;
    const perCustAskul = colPerCust != null ? num(row[colPerCust]) : 0;
    const rate = askulDaily > 0 ? askulDaily : base;
    if (rate <= 0 && perCustAskul <= 0) continue;

    // 客数連動（田川さん 2026-10-04「お客さんの数とトイレットペーパー等の減りは連動している。
    //   1年間の売上との兼ね合いから係数を作って減らしたい」）:
    //   減る量 = 前日までのマルシェの客数（会計件数） × 1客あたりの係数。休みの日は減らない。
    //   係数: アスクル品目は「1年の発送数量 ÷ 同じ期間の客数」（refreshAskulRates が計算して「1客あたり」列へ）。
    //         それ以外は「基本日次量 ÷ 1年の1日平均客数」。季節・土日の差は客数に出るので倍率は掛けない。
    // POS連動「なし」（固定）の品目と、POSの設定がまだ無いときは、従来の 基本量×季節×土日。
    let dec, kind;
    const coef = perCustAskul > 0 ? perCustAskul : (pos.ok && pos.avgDailyCustomers > 0 ? rate / pos.avgDailyCustomers : 0);
    if (posKind !== 'FIXED' && pos.ok && coef > 0) {
      dec = coef * pos.customers;
      kind = '客数連動(' + pos.label + ' ' + pos.customers + '客×' + Number(coef.toPrecision(2)) + (perCustAskul > 0 ? '・アスクル実績' : '') + ')';
    } else if (posKind !== 'FIXED' && pos.configured) {
      continue; // POSが一時的に取れない: 今日は減らさず、取れた日にまとめて引く（基本量で減らすと二重になる）
    } else {
      dec = askulDaily > 0 ? askulDaily : base * seasonFactor * weekendFactor;
      kind = askulDaily > 0 ? '自動減算(アスクル実績)' : '自動減算(' + tag + ')';
    }
    if (dec <= 0) continue;

    const before = cur;
    const after = Math.max(0, round2(cur - dec));
    if (after !== before) {
      toSet.push({ row: r + 1, col: colCur + 1, value: after });
      logChange({ name, before, delta: round2(after - before), after, kind: kind });
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
    sendAlertEmail(to, deficits, pos.ok || !pos.configured ? null : pos.error);
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
    lines.push(`⚠ POSの実売が取れなかったため、今日は在庫を減らしていません（取れた日にまとめて引きます）: ${posError}`);
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
// 品番 → 在庫一覧の商品名・換算（アスクル1個＝在庫の単位でいくつ）の初期値。
// 2026-10-04 にマルシェ宛て発送1年分（実質 2026-04〜09・21品番）を見て Claude が下書き。
// AskulHistory で田川さんが直したものが優先（ここは空欄のときだけ使う）。
// 商品名は候補を並べ、Items にある最初の名前を使う（無ければ紐付けない）。
const ASKUL_DEFAULT_MAP = {
  '1947584': { items: ['トイレットペーパー'], factor: 6 },          // 1パック6ロール → ロール
  '2501695': { items: ['ペーパータオル'], factor: 10 },             // 200枚入×10個 → 束
  '1251364': { items: ['茶ナプキン'], factor: 10 },                 // 未晒し 100枚入×10袋 → 束（未晒し＝茶と判断）
  '1251275': { items: ['白ナプキン'], factor: 1000 },               // 白無地 1000枚 → 枚
  '2797427': { items: ['マスク'], factor: 50 },                     // 1箱50枚 → 枚
  '8470086': { items: ['エンボス手袋 S', 'エンボス手袋S'], factor: 100 }, // 1箱100枚 → 枚
  '8470021': { items: ['エンボス手袋 L', 'エンボス手袋L'], factor: 100 },
  '1964146': { items: ['トイレのお掃除シート', 'トイレの掃除シート'], factor: 3 }, // 1セット3個 → パック
  '907029': { items: ['おしぼり'], factor: 1200 },                  // 1箱1200枚 → 個
  '853705': { items: ['ハンドソープ'], factor: 1 },                 // シャボネット1kg → 本
  '3457018': { items: ['アルコール（除菌）', 'アルコール'], factor: 5 }, // 5L → L
  '6006271': { items: ['水飲みカップ', '紙コップ'], factor: 1 },    // うがい用紙コップ1袋(100個) → 束（シートの単位が束）
  'H908232': { items: ['フォーム袋 小', 'フォーム袋小', '緩衝フォーム 小'], factor: 50 }, // 150×200 50枚
  'H908233': { items: ['フォーム袋 大', 'フォーム袋大', '緩衝フォーム 大'], factor: 50 }, // 200×300 50枚
  // 2026-10-04 田川さんの説明から（使い道）。シートの大小は1日の基本量（大2・小14）から Claude が推定
  'AH99569': { items: ['生のせプラカップ 小'], factor: 25 },        // クリスタルPETカップ9オンス 25個
  '3615627': { items: ['生のせプラカップ 大'], factor: 50 },        // ニュープロマックス325ml 50個
  '5781654': { items: ['生のせプラ フタ大'], factor: 50 },          // ニュープロマックス口径88mm用フタ 50個
  '884837': { items: ['OPP袋'], factor: 100 },                      // はがきサイズ透明袋 100枚（シートに行を足せば紐付く）
  '9398818': { items: ['OPP袋'], factor: 100 },                     // OPP袋（シールなし）はがき用 100枚
  '3473568': { items: ['OPPテープ'], factor: 1 },                   // 軽梱包用OPPテープ 1巻 → 個
  '1593772': { items: ['ジップロック'], factor: 72 },                // フリーザーバッグL 72枚 → 枚
  '6013374': { items: ['キッチンペーパー'], factor: 2 },             // リードペーパー 2ロール → ロール
  '514246': { items: ['ペン類'], factor: 1 },                       // ボールペン 1本
  '618705': { items: ['キッチン泡ハイター', '泡ハイター'], factor: 1 },
  '5785180': { items: ['漂白剤', 'キッチン漂白剤'], factor: 1 }
};
// この在庫管理はマルシェ店のもの（田川さん 2026-10-04）。本店宛ての発送は数えない
const ASKUL_STORE = 'マルシェ';
const ASKUL_WINDOW_DAYS = 365;
const ASKUL_HEADERS = ['品番', '商品名（アスクル）', '期間内の数量', '発送回数', '最初の発送', '最後の発送',
  '在庫管理の商品名', '換算（1個＝在庫いくつ）', '1日あたり（換算後）', '1客あたり（換算後）'];

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
  if (dest.indexOf('仲町463') >= 0) return '工房';
  return '不明';
}

// ソロエルアリーナ（アスクル）の注文履歴を貼ったシート「ソロエル注文履歴」を読む。
// 田川さんがChromeのClaudeに注文履歴ページから1年分を表にしてもらい、そのまま貼る運用（2026-10-05）。
// 個人アカウント（ADP…）とお店用アカウント（TAAA…）で履歴が分かれるので、両方を同じシートに貼り足す。
// 発送メールとの重複はオーダー管理番号で除く（シートに無い注文はメールから拾う）。
// 見出し: 注文日 / お届け日 / オーダー管理番号 / お申込番号 / 商品名 / 数量 / お届け先
// マルシェ宛て（お届け先に「マルシェ」か「本町1-20-14」）だけ使う。日付はお届け日、無ければ注文日。
const SOLOEL_HISTORY_SHEET = 'ソロエル注文履歴';
function loadSoloelOrderSheet(since) {
  const out = { rows: [], first: null, last: null, skipped: 0, orderIds: {} };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SOLOEL_HISTORY_SHEET);
  if (!sh) return out;
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return out;
  const idx = indexer(values[0]);
  const cDeliv = pickIndex(idx, ['お届け日']);
  const cOrder = pickIndex(idx, ['注文日', 'ご注文日']);
  const cCode = pickIndex(idx, ['お申込番号', '商品番号', '品番']);
  const cName = pickIndex(idx, ['商品名']);
  const cQty = pickIndex(idx, ['数量']);
  const cDest = pickIndex(idx, ['お届け先']);
  const cOrderId = pickIndex(idx, ['オーダー管理番号']);
  if (cCode == null || cQty == null || (cDeliv == null && cOrder == null)) {
    throw new Error('「' + SOLOEL_HISTORY_SHEET + '」の見出しが足りません（お申込番号・数量・お届け日か注文日）');
  }
  function toDate(v) {
    if (v instanceof Date) return v;
    const m = str(v).normalize('NFKC').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
  }
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const code = str(row[cCode]).normalize('NFKC');
    const qty = num(row[cQty]);
    if (!code || qty <= 0) continue;
    const at = toDate(cDeliv != null && str(row[cDeliv]) ? row[cDeliv] : row[cOrder]);
    if (!at || at < since) continue;
    if (cDest != null) {
      const dest = str(row[cDest]).normalize('NFKC').replace(/\s/g, '');
      if (dest && dest.indexOf('マルシェ') < 0 && dest.indexOf('本町1-20-14') < 0) { out.skipped++; continue; }
    }
    out.rows.push({ code: code, name: cName != null ? str(row[cName]) : '', qty: qty, at: at });
    if (cOrderId != null && str(row[cOrderId])) out.orderIds[str(row[cOrderId]).normalize('NFKC')] = true;
    if (!out.first || at < out.first) out.first = at;
    const d = jstDay(at);
    if (!out.last || d > out.last) out.last = d;
  }
  return out;
}

function refreshAskulRates() {
  const now = new Date();
  const since = new Date(now.getTime() - ASKUL_WINDOW_DAYS * 86400000);
  const byCode = {};
  const seen = {};
  let oldest = null;
  const skipped = { '本店': 0, '工房': 0, '不明': 0 };
  function addShip(code, name, qty, at) {
    const c = (byCode[code] = byCode[code] || { name: name, qty: 0, times: 0, first: at, last: at, ships: [] });
    c.qty += qty;
    c.ships.push({ day: jstDay(at), qty: qty });
    c.times += 1;
    if (at < c.first) c.first = at;
    if (at > c.last) { c.last = at; c.name = name; }
  }
  // ① ソロエルアリーナ（アスクル）の注文履歴を貼ったシート（あれば最優先。発送メールが来ない配達も入っている）
  const hist = loadSoloelOrderSheet(since);
  hist.rows.forEach(function (r) { addShip(r.code, r.name, r.qty, r.at); });
  if (hist.first) oldest = hist.first;
  skipped['本店'] += hist.skipped;
  // ② 発送メール（シートに同じオーダー管理番号がある注文は二重にならないよう読まない）。
  //    田川さんの個人アカウントとお店用アカウントで注文が分かれているため、期間ではなく注文番号で重複を見る
  for (let start = 0; start < 2000; start += 100) {
    // 2026-05頃までは前身の「ソロエルアリーナ」(soloel.com) から同じ書式で届いている
    const threads = GmailApp.search('from:(askul.co.jp OR soloel.com) subject:"商品発送のお知らせ" newer_than:' + ASKUL_WINDOW_DAYS + 'd', start, 100);
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
        const om = body.normalize('NFKC').match(/オーダー管理番号[:：]\s*([A-Z0-9]+)/);
        if (om && hist.orderIds[om[1]]) return; // 注文履歴シートに入っている注文
        const store = askulStoreOf(body);
        if (store !== ASKUL_STORE) { skipped[store] = (skipped[store] || 0) + 1; return; }
        parseAskulShipment(body).forEach(function (it) { addShip(it.code, it.name, it.qty, at); });
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
    if (!byCode[code] && prev[code].item) byCode[code] = { name: str(old.find(function (r) { return str(r[0]) === code; })[1]), qty: 0, times: 0, first: null, last: null, ships: [] };
  });

  // 1客あたりの係数 = 発送数量（換算後）÷ 同じ期間のマルシェの客数。
  // 期間は直近1年。POSの記録がそれより短い間（2026-05導入）は、POSに客数がある期間だけで割る（分子も同じ期間に揃える）
  // Items の商品名（空白・全半角ゆれを無視して引けるように）
  const itemNameSet = {};
  (function () {
    const iv = sheet('Items').getDataRange().getValues();
    const cn = pickIndex(indexer(iv[0]), ['商品名', '啁E��吁E']);
    iv.slice(1).forEach(function (r) { const n = str(r[cn]); if (n) itemNameSet[n.normalize('NFKC').replace(/\s/g, '')] = n; });
  })();

  const sales = fetchMarcheSales();
  const win = sales.ok ? customerWindow(sales.customers, jstDay(new Date(Date.now() - 86400000))) : null;

  const rows = Object.keys(byCode).sort(function (a, b) { return byCode[b].times - byCode[a].times; }).map(function (code) {
    const c = byCode[code];
    let p = prev[code] || { item: '', factor: '' };
    if (!p.item && ASKUL_DEFAULT_MAP[code]) {
      const d = ASKUL_DEFAULT_MAP[code];
      const hit = d.items.filter(function (n) { return itemNameSet[n.normalize('NFKC').replace(/\s/g, '')]; })[0];
      if (hit) p = { item: itemNameSet[hit.normalize('NFKC').replace(/\s/g, '')], factor: d.factor };
    }
    const factor = p.factor === '' || p.factor == null ? 1 : num(p.factor);
    let perCust = '';
    if (p.item && win && win.total > 0) {
      const inWin = c.ships.filter(function (x) { return x.day >= win.from && x.day <= win.to; })
        .reduce(function (a, x) { return a + x.qty; }, 0);
      perCust = Math.round(inWin * factor / win.total * 10000) / 10000;
    }
    return [code, c.name, c.qty, c.times, c.first || '', c.last || '', p.item, p.factor === '' || p.factor == null ? '' : p.factor,
      p.item ? round2(c.qty * factor / days) : '', perCust];
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
  const perCustItem = {};
  rows.forEach(function (r) {
    if (r[6] && r[8] !== '') perItem[r[6]] = (perItem[r[6]] || 0) + Number(r[8]);
    if (r[6] && r[9] !== '') perCustItem[r[6]] = (perCustItem[r[6]] || 0) + Number(r[9]);
  });
  // Items に「アスクル日次量」（参考）と「1客あたり」（毎朝の減算に使う係数）を書く。紐付けのない品目は空欄
  function writeItemsColumn(header, values, digits) {
    const hdr = itemsSh.getRange(1, 1, 1, itemsSh.getLastColumn()).getValues()[0];
    let col = indexer(hdr)[header];
    if (col == null) {
      col = hdr.length;
      itemsSh.getRange(1, col + 1).setValue(header);
    }
    const out = itemValues.slice(1).map(function (r) {
      const v = values[str(r[colName])];
      return [v != null ? Math.round(v * digits) / digits : ''];
    });
    if (out.length) itemsSh.getRange(2, col + 1, out.length, 1).setValues(out);
  }
  writeItemsColumn('アスクル日次量', perItem, 100);
  writeItemsColumn('1客あたり', perCustItem, 10000);

  // 不明が多いときは届け先の書式が変わった可能性がある（マルシェ分の取りこぼし）
  return { codes: rows.length, linked: Object.keys(perItem).length, days: Math.round(days), skippedHonten: skipped['本店'], skippedKobo: skipped['工房'], skippedUnknown: skipped['不明'],
    customerWindow: win, salesError: sales.ok ? null : sales.error };
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
    // 「なし」「固定」= 売上に連動させず、従来どおり 基本量×季節×土日 で減らす
    if (v === 'なし' || v === '固定' || v === 'FALSE' || v === 'OFF') return 'FIXED';
    if (v.indexOf('PET') >= 0 || v.indexOf('クリスタル') >= 0) return 'PET';
    if (v.indexOf('生のせ') >= 0) return 'NAMA_TO';
    if (v.indexOf('OPP') >= 0 || v.indexOf('スプーン') >= 0) return 'OPP';
    if (v.indexOf('フタ') >= 0 || v.indexOf('蓋') >= 0) return 'LID';
    if (v === 'W' || v.indexOf('ダブル') >= 0) return 'W';
    if (v.indexOf('S') >= 0 || v.indexOf('M') >= 0) return 'SM';
    return null; // 「なし」等
  }
  const n = str(name).normalize('NFKC').replace(/\s/g, '');
  if (n === 'Sカップ' || n === 'ロゴカップ') return 'SM';
  if (n === 'Wカップ' || n === 'ダブルカップ') return 'W';
  if (n === 'Sフタ' || n === 'S蓋') return 'LID';
  // 田川さん 2026-10-04: PETカップ9オンス=生のせ持ち帰り＋ギリシャ/生しぼり入りダブル、
  // ニュープロマックス325ml=生のせの台の持ち帰りだけ、OPP袋=持ち帰りでスプーンあり。
  // シートの大小は基本量（大2・小14/日）から推定: 小=PET9オンス、大=325ml（フタ大も325ml用）
  if (n === '生のせプラカップ小') return 'PET';
  if (n === '生のせプラカップ大' || n === '生のせプラフタ大') return 'NAMA_TO';
  if (n === 'OPP袋') return 'OPP';
  return null;
}

function jstDay(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
}

// マルシェのPOS実売と客数を在庫APIから取る（在庫の減算・係数づくりの両方で使う）
function fetchMarcheSales() {
  const url = prop('ORDERING_API_URL');
  const token = prop('ORDERING_API_TOKEN');
  if (!url || !token) return { ok: false, configured: false, error: 'ORDERING_API_URL / ORDERING_API_TOKEN 未設定' };
  try {
    const res = UrlFetchApp.fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'store=marche', {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return { ok: false, configured: true, error: 'EC ' + res.getResponseCode() };
    const body = JSON.parse(res.getContentText());
    // 店で絞れていない（2店計の）実売で引くと倍速で減るので使わない
    if (!body.actuals || body.actuals.store !== 'marche') return { ok: false, configured: true, error: '実売データなし（店舗絞り込み未対応のAPI）' };
    if (!body.customers || body.customers.store !== 'marche') return { ok: false, configured: true, error: '客数データなし（客数に未対応のAPI）' };
    return { ok: true, configured: true, actuals: body.actuals, customers: body.customers.days || {} };
  } catch (e) {
    return { ok: false, configured: true, error: String(e) };
  }
}

// 客数の「1日平均」と、その期間（係数の物差し）。直近365日（POSの記録がそれより短ければ記録の初日から）
function customerWindow(custDays, yesterday) {
  const yearAgo = jstDay(new Date(new Date(yesterday + 'T00:00:00+09:00').getTime() - 364 * 86400000));
  const keys = Object.keys(custDays).filter(d => d >= yearAgo && d <= yesterday).sort();
  if (!keys.length) return { from: null, to: yesterday, total: 0, days: 0, avg: 0 };
  const from = keys[0];
  let total = 0;
  keys.forEach(d => { total += num(custDays[d]); });
  const days = Math.max(1, Math.round((new Date(yesterday) - new Date(from)) / 86400000) + 1); // 休みの日も含む暦日
  return { from: from, to: yesterday, total: total, days: days, avg: total / days };
}

function loadPosCupUsage() {
  const today = jstDay(new Date());
  const yesterday = jstDay(new Date(Date.now() - 86400000));
  // 初回は前日分だけ引く（過去の分は棚卸し済みの在庫に含まれている前提）
  const last = prop('POS_CUPS_LAST_DAY') || jstDay(new Date(Date.now() - 2 * 86400000));
  const sales = fetchMarcheSales();
  if (!sales.ok) return sales;
  try {
    const actuals = sales.actuals;
    const custDays = sales.customers;
    const dayset = {};
    Object.keys(actuals.days || {}).concat(Object.keys(custDays)).forEach(d => { if (d > last && d < today) dayset[d] = true; });
    const days = Object.keys(dayset).sort();
    let customers = 0;
    days.forEach(d => { customers += num(custDays[d]); });
    let sCups = 0, wCups = 0, takeoutCups = 0, shipCups = 0, lidReady = false, namanoseTakeout = 0, wSpecial = 0, spoonYes = 0;
    days.forEach(d => {
      const a = actuals.days[d];
      if (!a) return;
      sCups += num(a.sCups);
      wCups += num(a.wCups);
      takeoutCups += num(a.takeoutCups);
      shipCups += num(a.shipCups);
      namanoseTakeout += num(a.namanoseTakeout);
      wSpecial += num(a.wSpecial);
      spoonYes += num(a.spoonYes);
      if (a.takeoutTracked) lidReady = true;
    });
    // 係数の物差し: 1年（POSの記録がそれより短ければ記録のある期間）の1日平均の客数
    const win = customerWindow(custDays, yesterday);
    const label = days.length === 0 ? '営業なし' : days.length === 1 ? days[0].slice(5).replace('-', '/') : days[0].slice(5).replace('-', '/') + '〜' + days[days.length - 1].slice(5).replace('-', '/');
    return { ok: true, configured: true, customers: customers, avgDailyCustomers: win.avg, customerWindow: win, sCups: sCups, wCups: wCups, takeoutCups: takeoutCups, shipCups: shipCups, lids: takeoutCups + shipCups,
      namanoseTakeout: namanoseTakeout, wSpecial: wSpecial, spoonYes: spoonYes,
      lidReady: lidReady, days: days, through: yesterday > last ? yesterday : last, label: label };
  } catch (e) {
    return { ok: false, configured: true, error: String(e) };
  }
}
