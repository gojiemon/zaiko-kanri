// 在庫管理 PWA フロントエンド
// - Service Worker 登録
// - GAS API ラッパー
// - タブ切替とイベント初期化
// - /items 取得、一覧と不足描画
// - 在庫更新: 変更を保留 → まとめて一括登録
// - Badging API で不足件数表示

(() => {
  'use strict';

  // API ベース URL は env.js で設定
  const API_BASE = (typeof GAS_API_BASE === 'string') ? GAS_API_BASE : '';
  if (!API_BASE) {
    console.warn('GAS_API_BASE が未設定です。env.js を設定してください');
  }

  // グローバル状態
  let allItems = [];
  let shortages = [];

  // 未保存の変更を保持 (id → newValue)
  const pendingChanges = new Map();

  // 発注数量マスター（商品名 → 補充数量）
  // ボタン1つで在庫をこの数量にセットする
  const RESTOCK_QTY = {
    '冷凍いちご': 10,
    '冷凍マンゴー': 20,
    '冷凍ブルーベリー': 15,
    '冷凍ラズベリー': 1,
    '冷凍ブラックベリー': 1,
    'バナナ': 13,
    'クリームチーズ': 12,
    'コーヒー豆': 3,
    'ガムシロップ': 50,
    'スティックシュガー': 100,
    'ミルクポーション': 100,
    'フロスト': 1,
    'グラニュー糖': 1,
    'グラノーラ': 3,
    'ミント': 1,
    '牛乳': 1,
    'エンボス手袋S': 50,
    'エンボス手袋M': 50,
    'エンボス手袋L': 50,
    'ゴム手袋M': 5,
    'ゴム手袋L': 5,
    'マスク': 100,
    'ゴミ袋45L': 200,
    'ゴミ袋20L': 100,
    'サニタリー袋': 50,
    'セロテープ': 1,
    'マスキングテープ': 5,
    'レジロール': 50,
    'ステラレジロール': 20,
    'ペーパータオル': 10,
    'スポンジ': 3,
    'ハンドソープ': 1,
    '布巾': 5,
    'ふきん': 5,
    'トイレットペーパー': 6,
    'トイレの掃除シート': 5,
    'トイレのお掃除シート': 5,
    '消臭スプレー': 1,
    'クレンザー': 1,
    'コロコロシート': 5,
    'アルコール': 1,
    '食器用洗剤': 3,
    'キッチンペーパー': 1,
    'ジップロック': 100,
    'ラップ': 6,
    'ナプキン': 10,
    'おしぼり': 50,
    'ペン': 1,
    'ホワイトボードマーカー': 1,
    'エスカップ': 1000,
    'Sカップ': 1000,
    'ダブルカップ': 1000,
    'Wカップ': 1000,
    'エスフタ': 1500,
    'Sフタ': 1500,
    'ホットドリンクカップ': 50,
    'ホットドリンクフタ': 50,
    '生乗せプラカップ大': 50,
    '生乗せプラカップ小': 50,
    '生乗せプラフタ大': 50,
    '生乗せプラフタ小': 50,
    'スプーン': 2000,
    '生乗せプラスプーン': 500,
    '飲むヨーグルトストロー': 50,
    'アイスコーヒーストロー': 50,
    'フォーム袋大': 30,
    'フォーム袋小': 50,
    'レジ袋': 100,
    'ケーキ袋大': 10,
    'ケーキ袋小': 10,
    '紙袋茶色': 50,
    'サンド袋テイクアウト': 100,
    'サンド袋': 100,
    'サンドフィルム': 100,
    '持ち帰り用箱': 20,
    'ケーキ箱大': 10,
    'ケーキ箱小': 10,
    'ケーキドーム大': 25,
    'ケーキドーム小': 25,
    'ケーキ底台': 25,
    'ケーキ底生': 2,
    'ケーキ台紙大': 200,
    'ケーキ台紙小': 200,
    'ケーキの型大': 50,
    'ケーキの型小': 50,
    'バースデープレート': 10,
    'キャンドル': 10,
    '緩衝材スチロール': 1,
    'OPPテープ': 1,
    'ヤマト伝票': 50,
    '和伝票': 50,
    '保冷剤': 20,
    '保冷バッグ': 10,
    '水飲みカップ': 200,
    'ポイントカード': 100,
    '青パンフ': 100,
    'トイレマジックリン': 1,
    'ロゴシール': 1,
    // シートの実際の名前（上の古い名前「生乗せ」「ホットドリンク」「ケーキの型」等とずれていてボタンが出ていなかった）
    // アスクルで買っている品目は、シートの「補充単位」（アスクルで届く1単位）がこちらより優先される
    '生のせプラカップ大': 50,
    '生のせプラカップ小': 50,
    '生のせプラフタ大': 50,
    '生のせプラフタ小': 50,
    '生のせプラスプーン': 500,
    'Hotドリンクカップ': 50,
    'Hotドリンクフタ': 50,
    'ケーキ底大': 25,
    'ケーキ底小': 25,
    'ケーキ型大': 50,
    'ケーキ型小': 50,
    '紙袋（茶色）': 50,
  };

  // 商品名から発注数量を検索（スペース無視・大小文字無視・部分一致）
  function getRestockQty(itemName) {
    const name = String(itemName || '').trim();
    if (!name) return null;
    // 完全一致
    if (RESTOCK_QTY[name] != null) return RESTOCK_QTY[name];
    // 正規化して比較（スペース除去+小文字化）
    const norm = s => s.replace(/\s+/g, '').toLowerCase();
    const nameNorm = norm(name);
    const keys = Object.keys(RESTOCK_QTY).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (nameNorm.includes(norm(key))) return RESTOCK_QTY[key];
    }
    return null;
  }

  // PWA: Service Worker 登録
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('Service Worker 登録に失敗しました', err);
      });
    });
  }

  // API ラッパー
  async function api(path, { method = 'GET', body = undefined, query = undefined } = {}) {
    if (!API_BASE) throw new Error('GAS_API_BASE 未設定');
    const params = new URLSearchParams();
    params.set('path', path);
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) params.set(k, String(v));
    }
    const url = `${API_BASE}?${params.toString()}`;
    const init = { method };
    if (body != null) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    const json = await res.json().catch(() => ({}));
    if (!json || json.ok === false) {
      const msg = json && json.error ? json.error : `APIエラー: ${res.status}`;
      throw new Error(msg);
    }
    return json.data;
  }

  // 数値フォーマット（小数第2位）
  function fmt2(n) {
    return (Math.round(Number(n) * 100) / 100).toFixed(2);
  }

  // 候補から最初に見つかった値を取る
  function firstField(obj, keys) {
    for (const k of keys) {
      if (obj != null && obj[k] != null && obj[k] !== '') return obj[k];
    }
    return undefined;
  }

  // 受け取った1行を正規化
  function readFields(it) {
    const id = Number(it['ID'] ?? it['Id'] ?? it['id']);
    const name = firstField(it, ['商品名', '品名', '名称']) || '';
    const unit = firstField(it, ['単位']) || '';
    const cur = Number(firstField(it, ['現在庫数', '現在在庫'])) || 0;
    const min = Number(firstField(it, ['最低在庫数', '下限'])) || 0;
    const category = firstField(it, ['カテゴリー', 'カテゴリ', '分類']) || '';
    let soloel = firstField(it, [
      'ソロURLアリーナURL',
      'ソロエルURLアリーナURL',
      'ソロエルアリーナURL',
      'ソロエルアリーナ',
      'ソロエルURL（任意）',
      'ソロエルURL',
      'ソロURL',
      'アリーナURL'
    ]) || '';
    if (!soloel) {
      try {
        for (const k of Object.keys(it)) {
          const ks = String(k);
          const hasSolo = ks.includes('ソロ') || ks.includes('ソロエル') || ks.toLowerCase().includes('soloel');
          const hasArena = ks.includes('アリ') || ks.includes('アリーナ');
          const hasUrl = ks.toLowerCase().includes('url') || ks.includes('ＵＲＬ');
          if ((hasSolo && hasUrl) || (hasArena && hasUrl) || ks.includes('ソロURLアリーナURL')) {
            const v = it[k];
            if (v != null && String(v).trim() !== '') {
              soloel = v;
              break;
            }
          }
        }
      } catch (_) {}
    }
    const askulDaily = Number(firstField(it, ['アスクル日次量'])) || 0;
    const perCust = Number(firstField(it, ['1客あたり'])) || 0;
    // アスクルで届く1単位（refreshAskulRates がシートに書く）。あれば青い補充ボタンはこの数
    const restockUnit = Number(firstField(it, ['補充単位'])) || 0;
    const restockUnitLabel = String(firstField(it, ['補充単位名']) || '');
    const baseDaily = Number(firstField(it, ['基本日次量'])) || 0;
    // 季節物（Itemsの「使う月」）。季節外はGASが「季節外」をつけてくる → 不足に出さない
    const useMonths = String(firstField(it, ['使う月']) || '');
    const offSeason = it['季節外'] === true;
    // GASの posLinkOf と同じ判定（POS連動列 → 無ければ商品名）
    const posCell = String(firstField(it, ['POS連動']) || '').normalize('NFKC').toUpperCase().replace(/\s/g, '');
    const nm = String(name).normalize('NFKC').replace(/\s/g, '');
    const posLink = posCell
      ? (posCell.includes('PET') || posCell.includes('クリスタル') ? 'PET'
        : posCell.includes('生のせ') ? 'NAMA_TO'
        : posCell.includes('OPP') || posCell.includes('スプーン') ? 'OPP'
        : posCell.includes('フタ') || posCell.includes('蓋') ? 'LID'
        : posCell === 'W' || posCell.includes('ダブル') ? 'W' : (/[SM]/.test(posCell) ? 'S・M' : ''))
      : (nm === 'Sカップ' || nm === 'ロゴカップ' ? 'S・M' : (nm === 'Wカップ' || nm === 'ダブルカップ') ? 'W'
        : (nm === 'Sフタ' || nm === 'S蓋') ? 'LID'
        : nm === '生のせプラカップ小' ? 'PET'
        : (nm === '生のせプラカップ大' || nm === '生のせプラフタ大') ? 'NAMA_TO'
        : nm === 'OPP袋' ? 'OPP'
        : ['クリームチーズ', '冷凍いちご', '冷凍マンゴー', '冷凍ラズベリー', '冷凍ブラックベリー', 'バナナ'].includes(nm) ? 'ING' : '');
    const posFixed = ['なし', '固定', 'FALSE', 'OFF'].includes(posCell);
    return { id, name, unit, cur, min, category, soloel, askulDaily, perCust, baseDaily, restockUnit, restockUnitLabel, posLink: posFixed ? '' : posLink, posFixed, useMonths, offSeason };
  }

  // リンク決定（URL未設定時は検索）
  function soloelLink(itemName, directUrl) {
    const direct = String(directUrl || '').trim();
    if (direct) return direct;
    const q = encodeURIComponent(String(itemName || ''));
    return `https://solution.soloel.com/s/?q=${q}`;
  }

  // 不足件数バッジ更新
  function updateBadge(count) {
    try {
      if ('setAppBadge' in navigator) navigator.setAppBadge(count);
    } catch (_) {}
    const badge = document.getElementById('shortageBadge');
    if (badge) badge.textContent = `不足 ${count}`;
  }

  // ===== 保留変更の管理 =====
  function addPending(id, value) {
    pendingChanges.set(String(id), Math.max(0, Number(value) || 0));
    updateSaveBar();
  }

  function updateSaveBar() {
    const bar = document.getElementById('saveBar');
    const count = pendingChanges.size;
    if (count > 0) {
      bar.classList.add('visible');
      document.getElementById('saveCount').textContent = count;
    } else {
      bar.classList.remove('visible');
    }
  }

  async function submitAllChanges() {
    if (pendingChanges.size === 0) return;
    const saveBtn = document.getElementById('saveAllBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = '送信中...';
    disableButtons(true);
    saveBtn.disabled = true; // disableButtons で解除されないように再設定

    const entries = [];
    for (const [id, value] of pendingChanges) {
      entries.push({ id: Number(id), value });
    }

    const failed = [];
    let doneCount = 0;
    for (const { id, value } of entries) {
      try {
        await api('/stock/update', { method: 'POST', body: { id, value } });
        // 送信成功 → pendingから即削除
        pendingChanges.delete(String(id));
        doneCount++;
        saveBtn.textContent = `送信中... ${doneCount}/${entries.length}`;
        // ローカル整合性
        const idx = allItems.findIndex(it => Number(readFields(it).id) === id);
        if (idx >= 0) {
          const stockKey = ['現在庫数', '現在在庫'].find(k => allItems[idx][k] != null) || '現在庫数';
          allItems[idx][stockKey] = value;
        }
      } catch (e) {
        failed.push({ id, error: e.message });
      }
    }
    updateSaveBar();
    if (failed.length > 0) {
      alert(`${doneCount}件成功、${failed.length}件失敗しました。失敗分は未保存のまま残っています。`);
    }
    try {
      await loadItems();
    } catch (_) {
      if (failed.length === 0) alert('登録完了。「最新データ取得」で画面を更新してください。');
    }
    disableButtons(false);
    saveBtn.disabled = false;
    saveBtn.textContent = 'まとめて登録';
  }

  // 画面初期化
  function initUI() {
    // タブ切替
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        const viewId = tab.getAttribute('aria-controls');
        const view = document.getElementById(viewId);
        if (view) view.classList.add('active');
      });
    });

    // ソロエルトップ
    document.getElementById('openSoloelTop')?.addEventListener('click', () => {
      window.open('https://solution.soloel.com/', '_blank');
    });

    // 自動減算（テスト）
    document.getElementById('runDecrement')?.addEventListener('click', async () => {
      try {
        disableButtons(true);
        await api('/decrement/run', { method: 'POST' });
        await loadItems();
        alert('自動減算を実行しました');
      } catch (e) {
        alert(`エラー: ${e.message}`);
      } finally {
        disableButtons(false);
      }
    });

    // 最新データ取得
    document.getElementById('reloadItems')?.addEventListener('click', async () => {
      try {
        disableButtons(true);
        await loadItems();
      } catch (e) {
        alert(`エラー: ${e.message}`);
      } finally {
        disableButtons(false);
      }
    });

    // 食材タブ
    document.getElementById('reloadFood')?.addEventListener('click', () => loadFood());
    document.getElementById('foodContainer')?.addEventListener('click', onFoodClick);
    const faxPanel = document.getElementById('faxPanel');
    faxPanel?.addEventListener('click', onFaxClick);
    faxPanel?.addEventListener('input', onFaxInput);
    faxPanel?.addEventListener('change', onFaxInput);

    // まとめて登録ボタン
    document.getElementById('saveAllBtn')?.addEventListener('click', () => {
      submitAllChanges();
    });

    // フィルタ
    document.getElementById('searchInput')?.addEventListener('input', () => renderItems());
    document.getElementById('categorySelect')?.addEventListener('change', () => renderItems());

    // イベント委譲（不足・一覧）— すべてローカル保留のみ
    // blur はバブリングしないのでキャプチャフェーズで委譲
    document.getElementById('shortagesContainer')?.addEventListener('click', onCardClick);
    document.getElementById('shortagesContainer')?.addEventListener('blur', onQtyBlur, true);
    document.getElementById('shortagesContainer')?.addEventListener('keydown', onQtyKeydown);
    document.getElementById('itemsContainer')?.addEventListener('click', onCardClick);
    document.getElementById('itemsContainer')?.addEventListener('blur', onQtyBlur, true);
    document.getElementById('itemsContainer')?.addEventListener('keydown', onQtyKeydown);
  }

  function disableButtons(disabled) {
    document.querySelectorAll('button').forEach(b => b.disabled = !!disabled);
  }

  // ボタンクリック（±、補充）→ ローカル保留のみ
  function onCardClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    // 同じ品目が「今日の不足」と「在庫一覧」の両方にあるので、押したカード内の入力欄を使う
    const input = btn.closest('.card')?.querySelector('input.qty-input');
    if (!id || !input) return;
    const current = Number(input.value) || 0;
    if (action === 'dec') {
      const next = Math.max(0, Math.round((current - 1) * 100) / 100);
      input.value = fmt2(next);
      addPending(id, next);
      markChanged(input);
    } else if (action === 'inc') {
      const next = Math.round((current + 1) * 100) / 100;
      input.value = fmt2(next);
      addPending(id, next);
      markChanged(input);
    } else if (action === 'restock') {
      const qty = Number(btn.getAttribute('data-qty')) || 0;
      if (qty <= 0) return;
      const next = Math.round((current + qty) * 100) / 100;
      input.value = fmt2(next);
      addPending(id, next);
      markChanged(input);
    }
  }

  // 数値入力 — Enter または blur で保留に追加（APIは叩かない）
  function onQtyBlur(e) {
    const input = e.target.closest('input.qty-input');
    if (!input) return;
    const id = input.getAttribute('data-id');
    const raw = input.value.trim();
    const v = Number(raw);
    if (raw === '' || Number.isNaN(v)) {
      alert('数値を入力してください');
      return;
    }
    // タップして離れただけ（値が変わっていない）なら保留にしない。
    // 古い値で「まとめて登録」すると自動減算後の在庫を上書きしてしまうため
    if (!pendingChanges.has(String(id)) && Number(input.defaultValue) === v) return;
    addPending(id, v);
    input.value = fmt2(v);
    markChanged(input);
  }

  // Enter キーで確定（blur を発火させる）
  function onQtyKeydown(e) {
    if (e.key === 'Enter') {
      e.target.blur();
    }
  }

  // 変更済みカードにハイライト
  function markChanged(input) {
    const card = input.closest('.card');
    if (card) card.classList.add('changed');
  }

  // アイテム読み込み
  async function loadItems() {
    try {
      const data = await api('/items');
      allItems = Array.isArray(data) ? data : [];
      shortages = allItems.filter(it => {
        const f = readFields(it);
        return !f.offSeason && Number(f.cur) < Number(f.min);
      });
      updateBadge(shortages.length);
      renderShortages();
      renderItems();
    } catch (e) {
      alert(`データ取得に失敗しました: ${e.message}`);
      throw e;
    }
  }

  function renderShortages() {
    const wrap = document.getElementById('shortagesContainer');
    if (!wrap) return;
    const list = shortages.map(renderItemCard).join('');
    wrap.innerHTML = list || '<p>不足はありません</p>';
  }

  function renderItems() {
    const wrap = document.getElementById('itemsContainer');
    if (!wrap) return;
    const q = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
    const cat = document.getElementById('categorySelect')?.value || '';
    const list = allItems.filter(it => {
      const f = readFields(it);
      const okQ = !q || String(f.name).toLowerCase().includes(q);
      const okC = !cat || String(f.category) === cat;
      return okQ && okC;
    });
    const html = list.map(renderItemCard).join('');
    wrap.innerHTML = html || '<p>データがありません</p>';
  }

  function renderItemCard(it) {
    const f = readFields(it);
    const id = f.id;
    const name = f.name;
    const unit = f.unit || '';
    const cur = Number(f.cur) || 0;
    const min = Number(f.min) || 0;
    const shortage = !f.offSeason && cur < min;
    const direct = String(f.soloel || '').trim();
    let linkHtml = '';
    if (direct) {
      const lower = direct.toLowerCase();
      if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:') || lower.startsWith('tel:')) {
        linkHtml = `<a class="link" href="${direct}" target="_blank" rel="noopener noreferrer">${escapeHtml(direct)}</a>`;
      } else {
        linkHtml = `<span class="note">${escapeHtml(direct)}</span>`;
      }
    }
    // アスクルで届く単位があればそれ（例: ＋1200個 補充（アスクル1箱））、無ければ従来の決め打ち数
    const restockQty = f.restockUnit > 0 ? f.restockUnit : getRestockQty(name);
    const restockNote = f.restockUnit > 0 && f.restockUnitLabel ? `（${escapeHtml(f.restockUnitLabel)}）` : '';
    const restockBtn = restockQty != null
      ? `<button class="btn restock" data-action="restock" data-id="${id}" data-qty="${restockQty}" aria-label="${restockQty}追加">＋${restockQty}${escapeHtml(unit)} 補充${restockNote}</button>`
      : '';
    // 保留中の値があればそちらを表示
    const displayValue = pendingChanges.has(String(id)) ? pendingChanges.get(String(id)) : cur;
    const isChanged = pendingChanges.has(String(id));
    return `
<article class="card ${shortage ? 'shortage' : ''} ${isChanged ? 'changed' : ''}" aria-label="${escapeHtml(name)}">
  <div class="card-header">
    <h3 class="item-title">${escapeHtml(name)}</h3>
    <small class="item-meta">${escapeHtml(f.category)}</small>
  </div>
  ${f.useMonths ? `<small class="item-meta">🗓 季節物（${escapeHtml(f.useMonths.replace(/[-~〜～]/, '〜'))}月に使う）${f.offSeason ? '・今は季節外なので減らさず、不足にも出しません' : ''}</small>` : ''}
  <div class="item-stock">在庫 <strong>${fmt2(cur)}</strong>${escapeHtml(unit)} / 下限 ${fmt2(min)}${escapeHtml(unit)}${isChanged ? ` <span class="pending-value">→ ${fmt2(displayValue)}</span>` : ''}</div>
  <small class="item-meta">${f.posLink
    ? (f.posLink === 'PET' ? '減り方: POS実売（生のせ持ち帰り＋ギリシャ・生しぼり入りダブルの数）'
      : f.posLink === 'NAMA_TO' ? '減り方: POS実売（生のせ持ち帰りの数）'
      : f.posLink === 'OPP' ? '減り方: POS実売（持ち帰りスプーンありの数）'
      : f.posLink === 'ING' ? (String(f.name).replace(/\s/g, '') === 'クリームチーズ' ? '減り方: POS実売（本店＋マルシェのクリームチーズの数×17g）' : '減り方: POS実売（そのフレーバーの数×グラム）')
      : f.posLink === 'LID' ? '減り方: POS実売（マルシェの持ち帰りS・M＋発送セットの数）' : (f.posLink === 'S・M' ? '減り方: POS実売（マルシェのS・M＋発送セットの数）' : `減り方: POS実売（マルシェの${f.posLink}の数）`))
    : f.posFixed
    ? (f.baseDaily > 0 ? `減り方: 固定 1日${f.baseDaily}${escapeHtml(unit)}×季節・土日` : '')
    : f.perCust > 0
    ? `減り方: 客数×1客あたり${f.perCust}${escapeHtml(unit)}（アスクル1年の実績）`
    : (f.askulDaily || f.baseDaily) > 0
    ? `減り方: 客数連動（平均的な日に${f.askulDaily || f.baseDaily}${escapeHtml(unit)}）`
    : ''}</small>
  ${restockBtn}
  <div class="controls">
    <div class="stepper">
      <button class="step" aria-label="1減らす" data-action="dec" data-id="${id}">−</button>
      <button class="step" aria-label="1増やす" data-action="inc" data-id="${id}">＋</button>
    </div>
    <input class="qty-input" type="number" step="0.01" inputmode="decimal" value="${fmt2(displayValue)}" data-id="${id}" aria-label="数量を直接入力" />
    <div class="links">${linkHtml}</div>
  </div>
</article>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // ===== 食材（需要予測・POS実売ベース） =====
  // 計算は woodberrys-demand-forecast の朝バッチ（POSの実売から消費を引く）。
  // ここは見る・記録するだけ。記録はGAS経由でLINE返信と同じ在庫イベントに入る。
  let foodData = null;
  const FOOD_PIN_KEY = 'zaiko-food-pin';
  const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
  // 急ぐ順（上から並べる）
  const FOOD_STATUS = {
    tonight: { order: 0, label: '今夜発注', cls: 'urgent' },
    ordernow: { order: 0, label: '今日発注', cls: 'urgent' },
    early: { order: 1, label: '次の発注日まで持たない', cls: 'warn' },
    stale: { order: 2, label: '数え直して', cls: 'warn' },
    nodata: { order: 3, label: '未登録', cls: 'muted' },
    ok: { order: 4, label: '余裕あり', cls: 'ok' },
    unused: { order: 5, label: '消費なし', cls: 'muted' },
    manual: { order: 6, label: '目視で管理', cls: 'muted' },
  };

  function getPin() {
    try { return localStorage.getItem(FOOD_PIN_KEY) || ''; } catch (_) { return ''; }
  }
  function setPin(v) {
    try { if (v) localStorage.setItem(FOOD_PIN_KEY, v); else localStorage.removeItem(FOOD_PIN_KEY); } catch (_) {}
  }
  async function ensurePin() {
    let pin = getPin();
    if (pin) return pin;
    pin = (prompt('記録用の合言葉を入力してください（この端末に保存されます）') || '').trim();
    if (!pin) return '';
    await api('/food/pin-check', { method: 'POST', body: { pin } });
    setPin(pin);
    return pin;
  }

  // ロットの呼び名（「箱(10kg)」→「箱」）。在庫イベントが受け付ける単位に限る
  function lotWord(it) {
    const w = String(it.lotLabel || '').replace(/[（(].*$/, '').trim();
    return ['箱', 'ケース', '袋', '束', '個', '本'].includes(w) ? w : '箱';
  }
  // 記録をその品目の基準単位に（demand-forecast の toBaseUnits と同じ換算）
  function toBase(it, rec) {
    const u = rec.unit;
    if (!u || u === 'kg') return rec.qty;
    if (['箱', 'ケース', '袋', '束'].includes(u)) return rec.qty * it.lot;
    if (u === '個' || u === '本') return it.unit === 'kg' ? rec.qty * it.lot : rec.qty;
    return rec.qty;
  }
  function fmtAmount(it, v) {
    if (v == null || !isFinite(v)) return '-';
    return it.unit === 'kg' ? `${v.toFixed(1)}kg` : `${Math.round(v)}${it.unit}`;
  }
  // 棚卸しは袋で数える（目で見て分かるので。田川さん 2026-10-07）。品目ごとの1袋のkg。
  // 記録はkgに直してから送る（在庫イベントの「袋」はロット=1箱扱いになるため、ここで換算しておく）
  const BAG_KG = { '甘味ベース': 5, 'ヨーグルト': 10 }; // ヨーグルトは箱に入らず10kgの袋のまま置く（田川さん 2026-10-07）
  function bagKg(it) { return it.unit === 'kg' ? (BAG_KG[it.name] || 0) : 0; }
  function fmtBags(it, kg) {
    const b = bagKg(it);
    if (!b || kg == null || !isFinite(kg)) return '';
    return `（約${(Math.round(kg / b * 10) / 10)}袋）`;
  }
  function fmtRec(it, rec) {
    return rec.unit ? `${rec.qty}${rec.unit}` : `${rec.qty}${it.unit}`;
  }
  function fmtWhen(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}(${DOW_JA[d.getDay()]}) ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function fmtDay(ymd) {
    const d = new Date(ymd + 'T00:00:00');
    return `${d.getMonth() + 1}/${d.getDate()}(${DOW_JA[d.getDay()]})`;
  }

  async function loadFood() {
    const wrap = document.getElementById('foodContainer');
    try {
      foodData = await api('/food/status');
      renderFood();
    } catch (e) {
      if (wrap) wrap.innerHTML = `<p>食材の取得に失敗しました: ${escapeHtml(e.message)}</p>`;
    }
  }

  // 朝の判定より後に記録したもの（LINE・アプリ両方）。明朝の計算までの概算に使う
  function recordsSince(it, sinceIso) {
    const ev = foodData && foodData.events && foodData.events[it.name];
    if (!ev) return { count: null, receives: [], orders: [] };
    const after = r => r && r.at > sinceIso;
    return {
      count: after(ev.lastCount) ? ev.lastCount : null,
      receives: (ev.receives || []).filter(after),
      orders: (ev.orders || []).filter(after),
    };
  }

  function renderFood() {
    const wrap = document.getElementById('foodContainer');
    const meta = document.getElementById('foodMeta');
    if (!wrap) return;
    const snap = foodData && foodData.snapshot;
    if (!snap) {
      if (meta) meta.textContent = '';
      wrap.innerHTML = '<p>まだ朝の計算結果が届いていません。明朝の予測LINEのあとに表示されます。</p>';
      renderFax();
      return;
    }
    if (meta) {
      const base = snap.posBased ? 'POSの実売から計算' : '予測から計算（実売データなし）';
      const evNote = foodData.eventsError ? ` ／ ⚠ 最新の記録を取得できませんでした（${foodData.eventsError}）` : '';
      meta.textContent = `${fmtWhen(snap.generatedAt)} の計算（${base}）${evNote}`;
    }
    const items = [...snap.items].sort((a, b) =>
      (FOOD_STATUS[a.status]?.order ?? 9) - (FOOD_STATUS[b.status]?.order ?? 9));
    wrap.innerHTML = items.map(it => renderFoodCard(it, snap)).join('');
    renderFax();
  }

  function renderFoodCard(it, snap) {
    const st = FOOD_STATUS[it.status] || { label: it.status, cls: 'muted' };
    const since = recordsSince(it, snap.generatedAt);
    const lines = [];

    if (it.stock != null) {
      const days = it.daysLeft != null ? ` ≒ <strong>${it.daysLeft.toFixed(1)}日分</strong>` : '';
      lines.push(`残り 約${fmtAmount(it, it.stock)}${fmtBags(it, it.stock)}${days}`);
    }
    if (it.status === 'tonight' || it.status === 'ordernow') {
      const arrive = it.arriveDow != null ? `→ ${DOW_JA[it.arriveDow]}着` : '';
      const recoBags = bagKg(it) ? `＝${Math.round(it.lots * it.lot / bagKg(it))}袋` : '';
      lines.push(`<span class="food-reco">推奨 ${it.lots}${escapeHtml(it.lotLabel || lotWord(it))}${recoBags} ${arrive}</span>`);
    }
    if (it.status === 'early' && it.nextOrderDow != null) {
      lines.push(`次の発注日（${DOW_JA[it.nextOrderDow]}）の入荷まで持たない見込み`);
    }
    if (it.status === 'stale') lines.push(`棚卸しが${it.staleDays}日前で古く、計算できません。数えて記録してください。`);
    if (it.status === 'nodata') lines.push('まだ一度も数えていません。棚卸しを記録すると明朝から計算されます。');
    if (it.warn) lines.push(`⚠ ${escapeHtml(it.warn)}`);
    for (const p of it.pendings || []) lines.push(`📦 入荷待ち ${escapeHtml(p.label)}（${fmtDay(p.eta)}着予定）`);

    // 朝の計算より後の記録 → 明朝反映。棚卸しがあれば概算も出す
    const recNotes = [];
    if (since.count) {
      let est = toBase(it, since.count);
      for (const r of since.receives) if (r.at > since.count.at) est += toBase(it, r);
      const d = it.avgDaily > 0 ? ` ≒ ${(est / it.avgDaily).toFixed(1)}日分` : '';
      recNotes.push(`棚卸し ${fmtRec(it, since.count)}（${fmtWhen(since.count.at)}）→ 概算 ${fmtAmount(it, est)}${fmtBags(it, est)}${d}`);
    }
    for (const r of since.receives) recNotes.push(`入荷 ${fmtRec(it, r)}（${fmtWhen(r.at)}）`);
    for (const r of since.orders) recNotes.push(`発注 ${fmtRec(it, r)}（${fmtWhen(r.at)}）`);
    const recHtml = recNotes.length
      ? `<div class="food-recent">📝 朝の計算のあとの記録（明朝の計算に反映）<br>${recNotes.map(escapeHtml).join('<br>')}</div>`
      : '';

    const lw = lotWord(it);
    const orderQty = it.lots > 0 ? it.lots : 1;
    const key = escapeHtml(it.name);
    return `
<article class="card food-card food-${st.cls}" aria-label="${key}">
  <div class="card-header">
    <h3 class="item-title">${key}</h3>
    <span class="food-status food-status-${st.cls}">${escapeHtml(st.label)}</span>
  </div>
  <div class="item-stock">${lines.join('<br>')}</div>
  <small class="item-meta">${escapeHtml(it.supplier || '')}${it.method ? '・' + escapeHtml(it.method) : ''}</small>
  ${recHtml}
  <div class="food-actions">
    <button class="btn" data-food="count" data-item="${key}">棚卸し</button>
    <button class="btn" data-food="receive" data-item="${key}" data-qty="1" data-unit="${escapeHtml(lw)}">入荷</button>
    <button class="btn" data-food="order" data-item="${key}" data-qty="${orderQty}" data-unit="${escapeHtml(lw)}">発注した</button>
  </div>
  <div class="food-form" data-form-for="${key}" hidden></div>
</article>`;
  }

  // ボタン → その場に小さな入力欄を出す（数量と単位を確認してから記録）
  function onFoodClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const card = btn.closest('.food-card');
    if (!card) return;
    const form = card.querySelector('.food-form');
    if (btn.dataset.food) {
      const it = foodData.snapshot.items.find(x => x.name === btn.dataset.item);
      if (!it) return;
      const kind = btn.dataset.food;
      const lw = lotWord(it);
      const baseLabel = it.unit;
      const defUnit = btn.dataset.unit || '';
      const title = { count: '今ある量（棚卸し）', receive: '届いた量（入荷）', order: '発注した量' }[kind];
      form.innerHTML = `
        <label>${title}
          <input class="food-qty" type="number" inputmode="decimal" min="0" step="any" value="${btn.dataset.qty || ''}">
        </label>
        <select class="food-unit">
          ${bagKg(it) ? `<option value="__bag" ${kind === 'count' ? 'selected' : ''}>袋（1袋${bagKg(it)}kg）</option>` : ''}
          <option value="">${escapeHtml(baseLabel)}</option>
          <option value="${escapeHtml(lw)}" ${defUnit === lw && !(bagKg(it) && kind === 'count') ? 'selected' : ''}>${escapeHtml(it.lotLabel || lw)}</option>
        </select>
        <button class="btn primary" data-submit="${kind}">記録</button>
        <button class="btn" data-cancel="1">やめる</button>`;
      form.hidden = false;
      form.querySelector('.food-qty').focus();
      return;
    }
    if (btn.dataset.cancel) { form.hidden = true; form.innerHTML = ''; return; }
    if (btn.dataset.submit) submitFoodEvent(card, btn);
  }

  async function submitFoodEvent(card, btn) {
    const item = card.querySelector('[data-item]').dataset.item;
    const kind = btn.dataset.submit;
    const raw = card.querySelector('.food-qty').value.trim();
    let qty = Number(raw);
    let unit = card.querySelector('.food-unit').value || null;
    if (unit === '__bag') {
      const it = foodData.snapshot.items.find(x => x.name === item);
      qty = Math.round(qty * bagKg(it) * 100) / 100; // 袋 → kg
      unit = null;
    }
    if (raw === '' || !isFinite(qty) || qty < 0) { alert('数量を入れてください'); return; }
    if (kind !== 'count' && qty <= 0) { alert('入荷・発注は1以上で入れてください'); return; }
    btn.disabled = true;
    try {
      const pin = await ensurePin();
      if (!pin) return;
      const res = await api('/food/event', { method: 'POST', body: { pin, kind, item, qty, unit } });
      if (res && res.duplicate) alert('同じ内容をついさっき記録済みです（二重にはなりません）');
      await loadFood();
    } catch (e) {
      if (/合言葉/.test(e.message)) setPin('');
      alert(`記録できませんでした: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  // ===== 八ヶ岳乳業 FAX発注書 =====
  // 2枚ある。紙の様式（田川さんの手書き原本）と同じ並びで描く:
  //   ・マルシェ店納品分 … 朝バッチ（demand-forecast）が発注日（日・水・金）に faxSheet で数量を送ってくる
  //   ・小平工場納品分   … 工場の仕込みで決まるので数量は全部手入力（別紙・リードタイムが違うので混ぜない）
  // 食材タブで「描画 → その場で編集 → 画像保存」。保存した画像を FAXアプリ（写真から選ぶ）で送る運用。
  // 画像は端末のcanvasで作る（日本語フォントを端末に任せるため）。
  // 守ること（田川さん確認 2026-10-05・10-07）:
  //   - 数量0の行も空欄にせず「0」と印字する（書き忘れと区別）。空欄のままでは保存させない
  //   - マルシェ店: 納品指定日 = 発注日の翌日 / 小平工場: 最低3日前に発注
  //   - 宛先・納品場所・担当名は GAS のスクリプトプロパティ FAX_PROFILE から（公開リポジトリに住所を書かない）。
  //     アプリ側で直した場合はこの端末に保存して優先する
  const FAX_DRAFT_KEY = 'zaiko-fax-draft2';
  const FAX_PROFILE_KEY = 'zaiko-fax-profile';
  // 小平工場の行（紙の原本から。ビートグラニュー糖は使わなくなったので外す・ベース引き取りを追加 田川さん 2026-10-07）
  // 「／」の前は黒帯の見出し、後ろがその下の行（紙と同じ描き方）
  const KODAIRA_ROWS = [
    { label: '業務用・八ヶ岳高原牛乳10L', unit: 'ケース' },
    { label: '雪印乳業・全粉乳20kg', unit: '袋' },
    { label: 'SPクレート', unit: '個' },
    { label: '冷凍 甘み成分 配送委託／直販配送→小平工場', unit: '箱' },
    { label: 'ベース引き取り／小平工場→直販配送', unit: 'ケース' },
  ];
  const FAX_KINDS = {
    marche: { tabLabel: 'マルシェ店', title: '八ヶ岳乳業 発注書（マルシェ店納品）', leadDays: 1, minLead: 1, time: '' },
    kodaira: { tabLabel: '小平工場', title: '八ヶ岳乳業 発注書（小平工場納品）', leadDays: 3, minLead: 3, time: '22時頃' },
  };
  const faxUI = { open: false, tab: 'marche' };
  let faxSheets = {}; // kind → { kind, rows, orig, fromLast, id, orderDate, deliverDate, deliverTime, qty[], memo, faxNumber, note }
  let faxRenderTimer = null;

  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }
  function lsSet(key, v) {
    try { if (v == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch (_) {}
  }
  function ymdAdd(ymd, days) {
    const d = new Date(ymd + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function todayYmd() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  }
  // 紙の日付は和暦（令和）
  function fmtReiwa(ymd) {
    if (!ymd) return '';
    const d = new Date(ymd + 'T00:00:00');
    return `令和${String(d.getFullYear() - 2018).padStart(2, '0')}年${d.getMonth() + 1}月${d.getDate()}日`;
  }
  function fmtMdDow(ymd) {
    if (!ymd) return '';
    const d = new Date(ymd + 'T00:00:00');
    return `${d.getMonth() + 1}月${d.getDate()}日（${DOW_JA[d.getDay()]}）`;
  }

  function faxProfile() {
    const local = lsGet(FAX_PROFILE_KEY);
    const remote = (foodData && foodData.faxProfile) || {};
    const p = local || remote;
    const arr = v => (Array.isArray(v) ? v : []);
    return {
      to: arr(p.to), toTel: p.toTel || '',
      shipTo: arr(p.shipTo), shipToKodaira: arr(p.shipToKodaira),
      orderer: p.orderer || '', local: Boolean(local),
    };
  }
  function shipToOf(kind, prof) { return kind === 'kodaira' ? prof.shipToKodaira : prof.shipTo; }
  // 返信FAXの番号は納品場所の「TEL & FAX …」行から拾う（紙の「受注確認後、返信のFAXを…【FAX …】」）
  function replyFaxOf(lines) {
    const t = lines.join(' ').normalize('NFKC');
    const m = t.match(/FAX\s*[:：]?\s*([0-9][0-9\-ー－‐]{8,})/);
    return m ? m[1].replace(/[ー－‐]/g, '-') : '';
  }

  // マルシェ分の元データ: 今日の発注書（なければ前回の1枚を「全行手で記入」にして下敷きにする）
  function marcheBase() {
    const snap = foodData && foodData.snapshot;
    if (snap && snap.faxSheet) return { sheet: snap.faxSheet, fromLast: false };
    const last = foodData && foodData.faxLast;
    if (!last) return null;
    const orderDate = todayYmd();
    return {
      fromLast: true,
      sheet: { ...last, orderDate, deliverDate: ymdAdd(orderDate, 1), rows: last.rows.map(r => ({ ...r, qty: null, undetermined: true })) },
    };
  }

  // 下書き（編集内容）は発注書ごとに端末へ保存。アプリを閉じても消えない。日が変われば作り直す
  function buildSheet(kind) {
    const def = FAX_KINDS[kind];
    let rows, orig, fromLast = false, orderDate, deliverDate, faxNumber = '', note = '';
    if (kind === 'marche') {
      const base = marcheBase();
      if (!base) return null;
      rows = base.sheet.rows;
      fromLast = base.fromLast;
      orig = rows.map(r => (r.qty == null || fromLast ? '' : String(r.qty)));
      orderDate = base.sheet.orderDate;
      deliverDate = base.sheet.deliverDate || ymdAdd(orderDate, def.leadDays);
      faxNumber = base.sheet.faxNumber || '';
      note = base.sheet.note || '';
    } else {
      rows = KODAIRA_ROWS.map(r => ({ ...r, manual: true }));
      orig = rows.map(() => '');
      orderDate = todayYmd();
      deliverDate = ymdAdd(orderDate, def.leadDays);
      const m = foodData && (foodData.snapshot?.faxSheet || foodData.faxLast);
      faxNumber = m ? m.faxNumber || '' : '';
    }
    const id = `${kind}:${fromLast ? 'last' : 'today'}:${kind === 'marche' ? orderDate : todayYmd()}`;
    const sheet = { kind, rows, orig, fromLast, id, orderDate, deliverDate, deliverTime: def.time, qty: orig.slice(), memo: '', faxNumber, note };
    const saved = (lsGet(FAX_DRAFT_KEY) || {})[kind];
    if (saved && saved.id === id && Array.isArray(saved.qty) && saved.qty.length === rows.length) {
      Object.assign(sheet, { orderDate: saved.orderDate, deliverDate: saved.deliverDate, deliverTime: saved.deliverTime ?? def.time, qty: saved.qty, memo: saved.memo || '' });
    }
    return sheet;
  }
  function saveFaxDraft(kind) {
    const s = faxSheets[kind];
    if (!s) return;
    const all = lsGet(FAX_DRAFT_KEY) || {};
    all[kind] = { id: s.id, orderDate: s.orderDate, deliverDate: s.deliverDate, deliverTime: s.deliverTime, qty: s.qty, memo: s.memo };
    lsSet(FAX_DRAFT_KEY, all);
  }
  function clearFaxDraft(kind) {
    const all = lsGet(FAX_DRAFT_KEY) || {};
    delete all[kind];
    lsSet(FAX_DRAFT_KEY, all);
  }
  function curSheet() { return faxSheets[faxUI.tab]; }

  function renderFax() {
    const panel = document.getElementById('faxPanel');
    if (!panel) return;
    faxSheets = { marche: buildSheet('marche'), kodaira: buildSheet('kodaira') };
    if (!faxSheets.marche && faxUI.tab === 'marche' && faxUI.open) faxUI.tab = 'kodaira';
    panel.hidden = false;
    panel.innerHTML = `<div class="fax-head">${faxHeadHtml()}</div>
<button class="btn ${faxUI.open ? '' : 'primary'}" data-fax="toggle">${faxUI.open ? '閉じる' : '発注書を開く（編集・画像保存）'}</button>
<div class="fax-editor" ${faxUI.open ? '' : 'hidden'}>${faxUI.open ? faxEditorHtml() : ''}</div>`;
    if (faxUI.open) drawFaxPreview();
  }

  // 見出しとマルシェ分の数量一覧（入力のたびに更新する）
  function faxHeadHtml() {
    const m = faxSheets.marche;
    let badge = '', body;
    if (m && !m.fromLast) {
      const blanks = m.qty.filter(q => q === '').length;
      badge = blanks ? `<span class="food-status food-status-warn">空欄 ${blanks}</span>` : '<span class="food-status food-status-urgent">今夜FAX</span>';
      body = `<p class="fax-sum"><small>マルシェ店 ${escapeHtml(fmtDay(m.orderDate))}発注 → ${escapeHtml(fmtDay(m.deliverDate))}納品</small><br>${m.rows.map((r, i) => `${escapeHtml(r.label.split('／')[0])} <strong>${m.qty[i] === '' ? '<span class="fax-blank">手で記入</span>' : escapeHtml(m.qty[i]) + escapeHtml(r.unit)}</strong>`).join('<br>')}</p>`;
    } else {
      body = '<p class="note">今日はマルシェ店の発注日ではありません。急ぎのときや小平工場分は「発注書を開く」から作れます。</p>';
    }
    return `
<div class="card-header">
  <h3 class="item-title">📠 八ヶ岳乳業 FAX発注書</h3>
  ${badge}
</div>
${body}`;
  }

  function faxEditorHtml() {
    const tabs = Object.keys(FAX_KINDS).map(k =>
      `<button class="btn ${faxUI.tab === k ? 'primary' : ''}" data-fax-tab="${k}">${FAX_KINDS[k].tabLabel}</button>`).join('');
    const s = curSheet();
    if (!s) return `<div class="fax-tabs">${tabs}</div><p class="note">マルシェ店の発注書は、朝の計算から届いたら作れます。</p>`;
    const def = FAX_KINDS[s.kind];
    const prof = faxProfile();
    const rows = s.rows.map((r, i) => {
      const changed = !s.fromLast && s.orig[i] !== '' && s.qty[i] !== s.orig[i];
      const tag = r.manual ? '手入力の行'
        : r.undetermined ? '⚠ 自動で決められませんでした → 手で記入'
        : `朝の計算: ${escapeHtml(s.orig[i])}${escapeHtml(r.unit)}`;
      return `
<div class="fax-row ${s.qty[i] === '' ? 'fax-row-blank' : ''}">
  <div class="fax-row-label">${escapeHtml(r.label)}<small>${tag}${changed ? '（変更あり）' : ''}</small></div>
  <div class="fax-row-qty">
    <input type="number" inputmode="numeric" min="0" step="1" data-fax-qty="${i}" value="${escapeHtml(s.qty[i])}" placeholder="手で記入">
    <span>${escapeHtml(r.unit)}</span>
  </div>
</div>`;
    }).join('');
    const lead = daysBetween(s.orderDate, s.deliverDate);
    const leadWarn = s.kind === 'marche'
      ? (lead !== 1 ? '<p class="fax-warn">⚠ 納品指定日が発注日の翌日になっていません（マルシェ店納品は翌日）</p>' : '')
      : (lead < def.minLead ? `<p class="fax-warn">⚠ 小平工場分は最低${def.minLead}日前の発注です（今は${lead}日前）</p>` : '');
    const ship = shipToOf(s.kind, prof);
    const profMissing = !prof.to.length || !ship.length;
    return `
<div class="fax-tabs">${tabs}</div>
<div class="fax-dates">
  <label>発注日<input type="date" data-fax-field="orderDate" value="${escapeHtml(s.orderDate)}"></label>
  <label>納品指定日<input type="date" data-fax-field="deliverDate" value="${escapeHtml(s.deliverDate)}"></label>
  <label>時間（任意）<input type="text" data-fax-field="deliverTime" value="${escapeHtml(s.deliverTime)}" placeholder="例: 22時頃"></label>
</div>
${leadWarn}
${s.kind === 'marche' && s.fromLast ? `<p class="note">前回（${escapeHtml(fmtDay(foodData.faxLast.orderDate))}）の発注書を下敷きにしています。数量は全部手で入れてください。</p>` : ''}
${rows}
<p class="note">${escapeHtml(s.note || '0の行も「0」と書く（書き忘れと区別するため）')}</p>
<label class="fax-memo">通信欄（任意・発注書に印字）<textarea rows="2" data-fax-field="memo">${escapeHtml(s.memo)}</textarea></label>
<details class="fax-profile" ${profMissing ? 'open' : ''}>
  <summary>宛先・納品場所・担当名${profMissing ? ' <span class="fax-blank">未設定</span>' : ''}${prof.local ? '（この端末で変更済み）' : ''}</summary>
  <label>宛先（1行ずつ）<textarea rows="2" data-fax-prof="to">${escapeHtml(prof.to.join('\n'))}</textarea></label>
  <label>宛先のTEL（任意）<input type="text" data-fax-prof="toTel" value="${escapeHtml(prof.toTel)}"></label>
  <label>納品場所：マルシェ店（1行ずつ）<textarea rows="3" data-fax-prof="shipTo">${escapeHtml(prof.shipTo.join('\n'))}</textarea></label>
  <label>納品場所：小平工場（1行ずつ）<textarea rows="3" data-fax-prof="shipToKodaira">${escapeHtml(prof.shipToKodaira.join('\n'))}</textarea></label>
  <label>発注担当名<input type="text" data-fax-prof="orderer" value="${escapeHtml(prof.orderer)}"></label>
  <button class="btn" data-fax="profile-save">この端末に保存</button>
  ${prof.local ? '<button class="btn" data-fax="profile-reset">設定（スプレッドシート側）に戻す</button>' : ''}
</details>
<div class="fax-actions">
  <button class="btn primary" data-fax="save">画像を保存（写真へ）</button>
  <button class="btn" data-fax="reset">${s.kind === 'marche' && !s.fromLast ? '朝の計算に戻す' : '空欄に戻す'}</button>
</div>
<p class="note">下のプレビューを長押しして「写真に保存」でも保存できます。FAX-it! では「写真」からこの画像を選んで送ってください。</p>
<img class="fax-preview" alt="FAX発注書のプレビュー">`;
  }

  function onFaxInput(e) {
    const s = curSheet();
    if (!s) return;
    const t = e.target;
    if (t.dataset.faxQty != null) {
      s.qty[Number(t.dataset.faxQty)] = t.value.trim();
      t.closest('.fax-row')?.classList.toggle('fax-row-blank', t.value.trim() === '');
    } else if (t.dataset.faxField) {
      const f = t.dataset.faxField;
      s[f] = t.value;
      // 発注日を変えたら納品指定日もリードタイムに合わせて動かす（マルシェ=翌日・小平=3日後）
      if (f === 'orderDate' && t.value) {
        s.deliverDate = ymdAdd(t.value, FAX_KINDS[s.kind].leadDays);
        const d = document.querySelector('[data-fax-field="deliverDate"]');
        if (d) d.value = s.deliverDate;
      }
      if (e.type === 'change' && (f === 'orderDate' || f === 'deliverDate')) {
        saveFaxDraft(s.kind);
        rerenderFaxEditor();
        return;
      }
    } else {
      return;
    }
    saveFaxDraft(s.kind);
    const head = document.querySelector('#faxPanel .fax-head');
    if (head) head.innerHTML = faxHeadHtml();
    clearTimeout(faxRenderTimer);
    faxRenderTimer = setTimeout(drawFaxPreview, 250);
  }

  // 入力中のフォーカスを奪わないよう、日付・タブなど構造が変わるときだけ作り直す
  function rerenderFaxEditor() {
    const ed = document.querySelector('#faxPanel .fax-editor');
    if (ed) { ed.innerHTML = faxEditorHtml(); drawFaxPreview(); }
  }

  function readProfileForm() {
    const val = k => document.querySelector(`[data-fax-prof="${k}"]`)?.value || '';
    const lines = v => v.split('\n').map(x => x.trim()).filter(Boolean);
    return { to: lines(val('to')), toTel: val('toTel').trim(), shipTo: lines(val('shipTo')), shipToKodaira: lines(val('shipToKodaira')), orderer: val('orderer').trim() };
  }

  async function onFaxClick(e) {
    const tabBtn = e.target.closest('[data-fax-tab]');
    if (tabBtn) { faxUI.tab = tabBtn.dataset.faxTab; rerenderFaxEditor(); return; }
    const btn = e.target.closest('[data-fax]');
    if (!btn) return;
    const act = btn.dataset.fax;
    if (act === 'toggle') { faxUI.open = !faxUI.open; renderFax(); return; }
    const s = curSheet();
    if (act === 'reset') {
      if (!s || !confirm('入れた数量・通信欄を消して最初の状態に戻しますか？')) return;
      clearFaxDraft(s.kind);
      faxSheets[s.kind] = buildSheet(s.kind);
      rerenderFaxEditor();
      const head = document.querySelector('#faxPanel .fax-head');
      if (head) head.innerHTML = faxHeadHtml();
      return;
    }
    if (act === 'profile-save') { lsSet(FAX_PROFILE_KEY, readProfileForm()); rerenderFaxEditor(); return; }
    if (act === 'profile-reset') { lsSet(FAX_PROFILE_KEY, null); rerenderFaxEditor(); return; }
    if (act === 'save' && s) await saveFaxImage(btn, s);
  }

  // 保存前の確認。空欄（書き忘れと区別できない）と宛先未設定は止める
  function faxProblems(s) {
    const probs = [];
    s.rows.forEach((r, i) => {
      const q = s.qty[i];
      if (q === '') probs.push(`「${r.label}」が空欄です（0なら「0」と入れてください）`);
      else if (!/^\d+$/.test(q)) probs.push(`「${r.label}」の数量が整数ではありません: ${q}`);
    });
    const prof = faxProfile();
    if (!prof.to.length) probs.push('宛先が未設定です');
    if (!shipToOf(s.kind, prof).length) probs.push(`納品場所（${FAX_KINDS[s.kind].tabLabel}）が未設定です`);
    if (!s.faxNumber) probs.push('八ヶ岳乳業のFAX番号が届いていません（朝の計算が一度も届いていない可能性）');
    if (!s.orderDate || !s.deliverDate) probs.push('日付が空です');
    return probs;
  }

  async function saveFaxImage(btn, s) {
    const probs = faxProblems(s);
    if (probs.length) { alert(`まだ保存できません:\n\n${probs.join('\n')}`); return; }
    const lead = daysBetween(s.orderDate, s.deliverDate);
    if (s.kind === 'marche' && lead !== 1
      && !confirm('納品指定日が発注日の翌日ではありません。このまま保存しますか？')) return;
    if (s.kind === 'kodaira' && lead < FAX_KINDS.kodaira.minLead
      && !confirm(`小平工場分は最低${FAX_KINDS.kodaira.minLead}日前の発注です（今は${lead}日前）。このまま保存しますか？`)) return;
    btn.disabled = true;
    try {
      const canvas = drawFaxCanvas(s);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const name = `fax-order-${s.kind}-${s.orderDate}.png`;
      const file = new File([blob], name, { type: 'image/png' });
      // iPhone: 共有シート →「画像を保存」で写真に入る
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return; // 共有シートを閉じただけ
        }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      alert(`画像を作れませんでした: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  function drawFaxPreview() {
    const img = document.querySelector('#faxPanel .fax-preview');
    const s = curSheet();
    if (!img || !s) return;
    try { img.src = drawFaxCanvas(s).toDataURL('image/png'); } catch (_) {}
  }

  // A4縦（150dpi相当）。紙の原本と同じ並び: 宛先・日付 → FAX → 発注書 → 表（商品名/注文数量/納品指定日）
  // → 通信欄 → 納品場所 → 会社名・発注担当名。FAXは白黒なので色は使わない
  const FAX_FONT = '"Hiragino Mincho ProN", "Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif';
  function drawFaxCanvas(s) {
    const W = 1240, H = 1754, M = 100;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const prof = faxProfile();
    const ship = shipToOf(s.kind, prof);
    const font = (px, bold) => `${bold ? 'bold ' : ''}${px}px ${FAX_FONT}`;
    const text = (str, x, y, px, opt = {}) => {
      g.font = font(px, opt.bold);
      g.textAlign = opt.align || 'left';
      g.textBaseline = 'alphabetic';
      g.fillStyle = opt.color || '#000';
      g.fillText(str, x, y);
    };
    const line = (x1, y1, x2, y2, w = 2) => { g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
    // 枠に収まるよう1文字ずつ測って縮める（日本語は単語区切りがないため、折り返さず文字を小さくする）
    const fitPx = (str, maxW, px, bold) => {
      let p = px;
      g.font = font(p, bold);
      while (p > 16 && g.measureText(str).width > maxW) { p -= 1; g.font = font(p, bold); }
      return p;
    };

    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#000';

    // 宛先（左上）
    const to1 = prof.to[0] || '';
    const toParts = to1.match(/^(.*?)(\s*御中)$/);
    text(toParts ? toParts[1] : to1, M, 150, 50, { bold: true });
    g.font = font(50, true);
    const toW = g.measureText(toParts ? toParts[1] : to1).width;
    line(M, 162, M + toW + 10, 162, 2);
    if (toParts) text('御中', M + toW + 20, 150, 30, { bold: true });
    prof.to.slice(1).forEach((l, i) => text(`（${l.replace(/^[（(]|[）)]$/g, '')}）`, M, 200 + i * 36, 26));
    // 日付（右）
    text(fmtReiwa(s.orderDate), W - M, 250, 34, { bold: true, align: 'right' });
    g.font = font(34, true);
    line(W - M - g.measureText(fmtReiwa(s.orderDate)).width - 10, 262, W - M, 262, 2);
    // FAX（大きく）
    text(`FAX　${s.faxNumber}`, M, 320, 48, { bold: true });
    if (prof.toTel) text(`（TEL ${prof.toTel}）`, M, 362, 24);

    // タイトルと返信FAXのお願い
    text('発注書', W / 2, 455, 64, { bold: true, align: 'center' });
    const reply = replyFaxOf(ship);
    text(`受注確認後、返信のFAXをお願い致します。${reply ? `【FAX ${reply}】` : ''}`, W / 2, 508, 28, { align: 'center' });

    // 表
    const top = 532, colA = M, colB = 600, colU = 690, colC = 790, colR = W - M;
    const headH = 66, rowH = 74, bandH = 46;
    // 行の並び（「／」の前は黒帯の見出し）
    const layout = [];
    s.rows.forEach((r, i) => {
      const parts = r.label.split('／');
      if (parts.length > 1) layout.push({ band: parts[0] });
      layout.push({ i, label: parts.length > 1 ? parts.slice(1).join('／') : parts[0] });
    });
    const tableH = headH + layout.reduce((a, l) => a + (l.band ? bandH : rowH), 0);
    g.fillStyle = '#c8c8c8';
    g.fillRect(colA, top, colR - colA, headH);
    g.lineWidth = 3;
    g.strokeRect(colA, top, colR - colA, tableH);
    text('商品名', (colA + colB) / 2, top + 44, 30, { align: 'center' });
    text('注文数量', (colB + colC) / 2, top + 44, 30, { align: 'center' });
    text('納品指定日', (colC + colR) / 2, top + 44, 30, { align: 'center' });
    line(colA, top + headH, colR, top + headH, 2);
    let y = top + headH;
    let firstDate = true;
    const dateStr = `${fmtMdDow(s.deliverDate)}${s.deliverTime ? ' ' + s.deliverTime : ''}`;
    for (const l of layout) {
      if (l.band) {
        g.fillStyle = '#000';
        g.fillRect(colA, y, colR - colA, bandH);
        text(l.band, colA + 14, y + 34, fitPx(l.band, colR - colA - 28, 34, true), { bold: true, color: '#fff' });
        y += bandH;
        continue;
      }
      const r = s.rows[l.i];
      line(colB, y, colB, y + rowH, 2);
      line(colU, y + 10, colU, y + rowH, 1);
      line(colC, y, colC, y + rowH, 2);
      text(l.label, colA + 14, y + 50, fitPx(l.label, colB - colA - 28, 36, true), { bold: true });
      text(s.qty[l.i], (colB + colU) / 2, y + 60, 56, { bold: true, align: 'center' });
      text(r.unit, (colU + colC) / 2, y + 50, fitPx(r.unit, colC - colU - 10, 28), { align: 'center' });
      const ds = firstDate ? dateStr : '同上';
      text(ds, (colC + colR) / 2, y + 50, fitPx(ds, colR - colC - 20, 32, firstDate), { bold: firstDate, align: 'center' });
      firstDate = false;
      y += rowH;
      line(colA, y, colR, y, 2);
    }

    // 通信欄
    y += 20;
    const memoLines = s.memo.trim() ? s.memo.trim().split('\n').slice(0, 3) : [];
    const memoH = Math.max(96, 56 + memoLines.length * 40);
    g.lineWidth = 3;
    g.strokeRect(colA, y, colR - colA, memoH);
    text('通信欄　：', colA + 12, y + 36, 26, { bold: true });
    memoLines.forEach((l, i) => text(l, colA + 200, y + 72 + i * 40, fitPx(l, colR - colA - 220, 32)));
    y += memoH + 30;

    // 納品場所
    text('納品場所', M, y + 50, 40);
    text('：', 340, y + 50, 40);
    const boxX = 380, boxH = 40 + ship.length * 44;
    g.lineWidth = 2;
    g.strokeRect(boxX, y, colR - boxX, boxH);
    ship.forEach((l, i) => text(l, boxX + 12, y + 48 + i * 44, fitPx(l, colR - boxX - 24, i === 0 ? 40 : 28, true), { bold: true }));
    y += boxH + 62;

    // 会社名・発注担当名
    text('有限会社　ウッドベリーズ', colR, y, 48, { bold: true, align: 'right' });
    y += 30;
    const nameX = 700;
    text('発注担当名', nameX - 20, y + 48, 26, { bold: true, align: 'right' });
    g.lineWidth = 2;
    g.strokeRect(nameX, y, colR - nameX, 72);
    text(prof.orderer, (nameX + colR) / 2, y + 48, 30, { align: 'center' });
    return c;
  }

  // 初期化
  document.addEventListener('DOMContentLoaded', async () => {
    initUI();
    loadFood();
    try { await loadItems(); } catch (_) {}
  });
})();
