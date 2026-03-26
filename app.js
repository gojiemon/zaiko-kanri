// 在庫管理 PWA フロントエンド
// - Service Worker 登録
// - GAS API ラッパー
// - タブ切替とイベント初期化
// - /items 取得、一覧と不足描画
// - 在庫更新（±ボタン/直接入力）: /stock/update
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
    'グラノーラ': 3,
    'ミント': 1,
    '牛乳': 1,
    'エンボス手袋S': 100,
    'エンボス手袋M': 100,
    'エンボス手袋L': 100,
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
    'トイレットペーパー': 6,
    'トイレの掃除シート': 1,
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
    'ダブルカップ': 1000,
    'エスフタ': 1500,
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
    'フォーム袋大': 50,
    'フォーム袋小': 30,
    'レジ袋': 100,
    'ケーキ袋大': 20,
    'ケーキ袋小': 20,
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
    '和伝票': 50,
    '保冷剤': 20,
    '保冷バッグ': 10,
    '水飲みカップ': 200,
    'ポイントカード': 100,
    '青パンフ': 100,
    'トイレマジックリン': 1,
    'ロゴシール': 1,
  };

  // 商品名から発注数量を検索（部分一致）
  function getRestockQty(itemName) {
    const name = String(itemName || '').trim();
    if (!name) return null;
    // 完全一致を優先
    if (RESTOCK_QTY[name] != null) return RESTOCK_QTY[name];
    // 部分一致（長いキーから試して最も具体的にマッチ）
    const keys = Object.keys(RESTOCK_QTY).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (name.includes(key)) return RESTOCK_QTY[key];
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
    return { id, name, unit, cur, min, category, soloel };
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

  // 画面初期化
  function initUI() {
    // タブ切替
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        tab.classList.add('active');
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

    // フィルタ
    document.getElementById('searchInput')?.addEventListener('input', () => renderItems());
    document.getElementById('categorySelect')?.addEventListener('change', () => renderItems());

    // イベント委譲（不足・一覧）
    document.getElementById('shortagesContainer')?.addEventListener('click', onCardClick);
    document.getElementById('shortagesContainer')?.addEventListener('change', onQtyChange);
    document.getElementById('shortagesContainer')?.addEventListener('keydown', onQtyKeydown);
    document.getElementById('itemsContainer')?.addEventListener('click', onCardClick);
    document.getElementById('itemsContainer')?.addEventListener('change', onQtyChange);
    document.getElementById('itemsContainer')?.addEventListener('keydown', onQtyKeydown);
  }

  function disableButtons(disabled) {
    document.querySelectorAll('button').forEach(b => b.disabled = !!disabled);
  }

  // 入力中のリロード衝突を避ける
  let pendingReload = false;
  function safeReload() {
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('qty-input')) {
      pendingReload = true;
      return;
    }
    loadItems().catch(() => {});
  }

  // フォーカスが入力から外れたら保留中のリロードを実行
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const ae = document.activeElement;
      const typing = ae && ae.classList && ae.classList.contains('qty-input');
      if (!typing && pendingReload) {
        pendingReload = false;
        loadItems().catch(() => {});
      }
    }, 0);
  });

  // 在庫更新
  async function updateStock(id, value) {
    const v = Math.max(0, Number(value) || 0);
    await api('/stock/update', { method: 'POST', body: { id: Number(id), value: v } });
    const idx = allItems.findIndex(it => Number(readFields(it).id) === Number(id));
    if (idx >= 0) {
      const stockKey = ['現在庫数', '現在在庫'].find(k => allItems[idx][k] != null) || '現在庫数';
      allItems[idx][stockKey] = v;
    }
  }

  // ボタンクリック（±、補充）
  async function onCardClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    const input = document.querySelector(`input[data-id="${id}"]`);
    if (!id || !input) return;
    const current = Number(input.value) || 0;
    if (action === 'dec') {
      const next = Math.max(0, Math.round((current - 1) * 100) / 100);
      input.value = fmt2(next);
      btn.disabled = true;
      try { await updateStock(id, next); safeReload(); } finally { btn.disabled = false; }
    } else if (action === 'inc') {
      const next = Math.round((current + 1) * 100) / 100;
      input.value = fmt2(next);
      btn.disabled = true;
      try { await updateStock(id, next); safeReload(); } finally { btn.disabled = false; }
    } else if (action === 'restock') {
      const qty = Number(btn.getAttribute('data-qty')) || 0;
      if (qty <= 0) return;
      input.value = fmt2(qty);
      btn.disabled = true;
      try { await updateStock(id, qty); safeReload(); } finally { btn.disabled = false; }
    }
  }

  // 数値入力 — Enter または blur 時のみ保存（入力中は何もしない）
  async function onQtyChange(e) {
    const input = e.target.closest('input.qty-input');
    if (!input) return;
    const id = input.getAttribute('data-id');
    const raw = input.value.trim();
    const v = Number(raw);
    if (raw === '' || Number.isNaN(v)) {
      alert('数値を入力してください');
      return;
    }
    input.disabled = true;
    try {
      await updateStock(id, v);
      input.value = fmt2(v);
      safeReload();
    } finally {
      input.disabled = false;
    }
  }

  // Enter キーで確定（blur を発火させる）
  function onQtyKeydown(e) {
    if (e.key === 'Enter') {
      e.target.blur();
    }
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
      ? `<button class="btn restock" data-action="restock" data-id="${id}" data-qty="${restockQty}" aria-label="${restockQty}に補充">補充 → ${restockQty}${escapeHtml(unit)}</button>`
      : '';
    return `
<article class="card ${shortage ? 'shortage' : ''}" aria-label="${escapeHtml(name)}">
  <div class="card-header">
    <h3 class="item-title">${escapeHtml(name)}</h3>
    <small class="item-meta">${escapeHtml(f.category)}</small>
  </div>
  <div class="item-stock">在庫 <strong>${fmt2(cur)}</strong>${escapeHtml(unit)} / 下限 ${fmt2(min)}${escapeHtml(unit)}</div>
  ${restockBtn}
  <div class="controls">
    <div class="stepper">
      <button class="step" aria-label="1減らす" data-action="dec" data-id="${id}">−</button>
      <button class="step" aria-label="1増やす" data-action="inc" data-id="${id}">＋</button>
    </div>
    <input class="qty-input" type="number" step="0.01" inputmode="decimal" value="${fmt2(cur)}" data-id="${id}" aria-label="数量を直接入力" />
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

  // 初期化
  document.addEventListener('DOMContentLoaded', async () => {
    initUI();
    try { await loadItems(); } catch (_) {}
  });
})();
