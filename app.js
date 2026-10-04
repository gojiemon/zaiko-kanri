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
    const baseDaily = Number(firstField(it, ['基本日次量'])) || 0;
    // GASの posLinkOf と同じ判定（POS連動列 → 無ければ商品名）
    const posCell = String(firstField(it, ['POS連動']) || '').normalize('NFKC').toUpperCase().replace(/\s/g, '');
    const nm = String(name).normalize('NFKC').replace(/\s/g, '');
    const posLink = posCell
      ? (posCell.includes('フタ') || posCell.includes('蓋') ? 'LID'
        : posCell === 'W' || posCell.includes('ダブル') ? 'W' : (/[SM]/.test(posCell) ? 'S・M' : ''))
      : (nm === 'Sカップ' || nm === 'ロゴカップ' ? 'S・M' : (nm === 'Wカップ' || nm === 'ダブルカップ') ? 'W'
        : (nm === 'Sフタ' || nm === 'S蓋') ? 'LID' : '');
    return { id, name, unit, cur, min, category, soloel, askulDaily, baseDaily, posLink };
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
        return Number(f.cur) < Number(f.min);
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
    const shortage = cur < min;
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
    const restockQty = getRestockQty(name);
    const restockBtn = restockQty != null
      ? `<button class="btn restock" data-action="restock" data-id="${id}" data-qty="${restockQty}" aria-label="${restockQty}追加">＋${restockQty}${escapeHtml(unit)} 補充</button>`
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
  <div class="item-stock">在庫 <strong>${fmt2(cur)}</strong>${escapeHtml(unit)} / 下限 ${fmt2(min)}${escapeHtml(unit)}${isChanged ? ` <span class="pending-value">→ ${fmt2(displayValue)}</span>` : ''}</div>
  <small class="item-meta">${f.posLink
    ? (f.posLink === 'LID' ? '減り方: POS実売（マルシェの持ち帰りS・M＋発送セットの数）' : (f.posLink === 'S・M' ? '減り方: POS実売（マルシェのS・M＋発送セットの数）' : `減り方: POS実売（マルシェの${f.posLink}の数）`))
    : f.askulDaily > 0
    ? `減り方: アスクル実績 1日${f.askulDaily}${escapeHtml(unit)}`
    : (f.baseDaily > 0 ? `減り方: 基本量 1日${f.baseDaily}${escapeHtml(unit)}×季節・土日` : '')}</small>
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
  }

  function renderFoodCard(it, snap) {
    const st = FOOD_STATUS[it.status] || { label: it.status, cls: 'muted' };
    const since = recordsSince(it, snap.generatedAt);
    const lines = [];

    if (it.stock != null) {
      const days = it.daysLeft != null ? ` ≒ <strong>${it.daysLeft.toFixed(1)}日分</strong>` : '';
      lines.push(`残り 約${fmtAmount(it, it.stock)}${days}`);
    }
    if (it.status === 'tonight' || it.status === 'ordernow') {
      const arrive = it.arriveDow != null ? `→ ${DOW_JA[it.arriveDow]}着` : '';
      lines.push(`<span class="food-reco">推奨 ${it.lots}${escapeHtml(it.lotLabel || lotWord(it))} ${arrive}</span>`);
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
      recNotes.push(`棚卸し ${fmtRec(it, since.count)}（${fmtWhen(since.count.at)}）→ 概算 ${fmtAmount(it, est)}${d}`);
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
          <option value="">${escapeHtml(baseLabel)}</option>
          <option value="${escapeHtml(lw)}" ${defUnit === lw ? 'selected' : ''}>${escapeHtml(it.lotLabel || lw)}</option>
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
    const qty = Number(raw);
    const unit = card.querySelector('.food-unit').value || null;
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

  // 初期化
  document.addEventListener('DOMContentLoaded', async () => {
    initUI();
    loadFood();
    try { await loadItems(); } catch (_) {}
  });
})();
