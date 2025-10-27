// 在庫管理 PWA フロントエンド
// - Service Worker 登録
// - API ラッパー
// - 画面タブ切替
// - /items 取得、一覧と不足描画
// - 在庫更新（ボタン/直接入力）→ /stock/update（入力中は安全に再描画）
// - Badging API で不足件数表示
// - ネットエラーは alert

(() => {
  'use strict';

  // API ベース URL（env.js で設定）
  const API_BASE = (typeof GAS_API_BASE === 'string') ? GAS_API_BASE : '';
  if (!API_BASE) {
    console.warn('GAS_API_BASE が未設定です。env.js を編集してください。');
  }

  // グローバル状態
  let allItems = []; // Items の全件
  let shortages = []; // 不足アイテム

  // PWA: Service Worker 登録
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('Service Worker 登録失敗', err);
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
    // 注意: GAS Webアプリへのクロスオリジン POST で Content-Type: application/json を付けると
    // Preflight で失敗する場合があるため、素のテキストで JSON を送る
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

  // 文字化け対策: ヘッダー名の候補から拾う
  function firstField(obj, keys) {
    for (const k of keys) {
      if (obj != null && obj[k] != null && obj[k] !== '') return obj[k];
    }
    return undefined;
  }

  function readFields(it) {
    // 正常な日本語ヘッダー + 一部で見かけた化けヘッダー候補
    const id = Number(it['ID'] ?? it['Id'] ?? it['id']);
    const name = firstField(it, ['商品名', '啁E��吁E']) || '';
    const unit = firstField(it, ['単位', '単佁E']) || '';
    const cur = Number(firstField(it, ['現在庫数'])) || 0;
    const min = Number(firstField(it, ['最低在庫数'])) || 0;
    const category = firstField(it, ['カテゴリー', 'カテゴリ', 'カチE��リ']) || '';
    const soloel = firstField(it, ['ソロエルURL（任意）', 'ソロエルURL', 'ソロエルURL�E�任意！E']) || '';
    return { id, name, unit, cur, min, category, soloel };
  }

  // ソロエルリンク（URL未設定時は検索）
  function soloelLink(itemName, directUrl) {
    if (directUrl && String(directUrl).trim()) return String(directUrl).trim();
    const q = encodeURIComponent(String(itemName || ''));
    return `https://solution.soloel.com/s/?q=${q}`;
  }

  // バッジ更新（非対応は無視）
  function updateBadge(count) {
    try {
      if ('setAppBadge' in navigator) {
        navigator.setAppBadge(count);
      }
    } catch (_) {}
    const badge = document.getElementById('shortageBadge');
    if (badge) badge.textContent = `不足 ${count}`;
  }

  // 画面の初期化
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

    // ソロエルトップを開く
    document.getElementById('openSoloelTop')?.addEventListener('click', () => {
      window.open('https://solution.soloel.com/', '_blank');
    });

    // 自動減算（テスト）
    document.getElementById('runDecrement')?.addEventListener('click', async () => {
      try {
        disableButtons(true);
        await api('/decrement/run', { method: 'POST' });
        await loadItems();
        alert('自動減算を実行しました。メール通知設定があれば送信されます。');
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
    document.getElementById('shortagesContainer')?.addEventListener('input', onQtyInput);
    document.getElementById('shortagesContainer')?.addEventListener('change', onQtyChange);
    document.getElementById('itemsContainer')?.addEventListener('click', onCardClick);
    document.getElementById('itemsContainer')?.addEventListener('input', onQtyInput);
    document.getElementById('itemsContainer')?.addEventListener('change', onQtyChange);
  }

  function disableButtons(disabled) {
    document.querySelectorAll('button').forEach(b => b.disabled = !!disabled);
  }

  // 入力中のリロード衝突を避ける制御
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

  // 在庫更新（ボタン/直接入力）→ /stock/update
  // 直後に全体再描画はせず、ローカル更新 + 安全リロード
  async function updateStock(id, value) {
    const v = Math.max(0, Number(value) || 0);
    await api('/stock/update', { method: 'POST', body: { id: Number(id), value: v } });
    const idx = allItems.findIndex(it => Number(readFields(it).id) === Number(id));
    if (idx >= 0) allItems[idx]['現在庫数'] = v; // ローカル整合性用
  }

  // ±ボタンクリック
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
      await updateStock(id, next);
      safeReload();
    } else if (action === 'inc') {
      const next = Math.round((current + 1) * 100) / 100;
      input.value = fmt2(next);
      await updateStock(id, next);
      safeReload();
    }
  }

  // 入力デバウンス保存（停止後に自動保存）
  const saveTimers = new Map(); // id -> timer
  function onQtyInput(e) {
    const input = e.target.closest('input.qty-input');
    if (!input) return;
    const id = input.getAttribute('data-id');
    const v = Number(input.value);
    if (Number.isNaN(v)) return; // 入力途中（空/記号）は無視
    if (saveTimers.has(id)) clearTimeout(saveTimers.get(id));
    const t = setTimeout(async () => {
      try {
        await updateStock(id, v);
        input.value = fmt2(v);
        safeReload();
      } finally {
        saveTimers.delete(id);
      }
    }, 600);
    saveTimers.set(id, t);
  }

  // 変更確定（フォーカスアウトや Enter など）
  async function onQtyChange(e) {
    const input = e.target.closest('input.qty-input');
    if (!input) return;
    const id = input.getAttribute('data-id');
    const v = Number(input.value);
    if (Number.isNaN(v)) {
      alert('数値を入力してください');
      return;
    }
    await updateStock(id, v);
    input.value = fmt2(v);
    safeReload();
  }

  // アイテム読み込み
  async function loadItems() {
    try {
      const data = await api('/items');
      allItems = Array.isArray(data) ? data : [];
      // 不足抽出（読み取り正規化経由）
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
    wrap.innerHTML = shortages.map(renderItemCard).join('') || '<p>不足はありません</p>';
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
    wrap.innerHTML = list.map(renderItemCard).join('') || '<p>データがありません</p>';
  }

  function renderItemCard(it) {
    const f = readFields(it);
    const id = f.id;
    const name = f.name;
    const unit = f.unit || '';
    const cur = Number(f.cur) || 0;
    const min = Number(f.min) || 0;
    const shortage = cur < min;
    const url = soloelLink(name, f.soloel);
    return `
<article class="card ${shortage ? 'shortage' : ''}" aria-label="${name}">
  <div class="card-header">
    <h3 class="item-title">${escapeHtml(name)}</h3>
    <small class="item-meta">${escapeHtml(f.category)}</small>
  </div>
  <div class="item-meta">在庫 ${fmt2(cur)}${escapeHtml(unit)} / 下限 ${fmt2(min)}${escapeHtml(unit)}</div>
  <div class="controls">
    <div class="stepper">
      <button class="step" aria-label="1減らす" data-action="dec" data-id="${id}">−</button>
      <button class="step" aria-label="1増やす" data-action="inc" data-id="${id}">＋</button>
    </div>
    <input class="qty-input" type="number" step="0.01" inputmode="decimal" value="${fmt2(cur)}" data-id="${id}" aria-label="数量を直接入力" />
    <div class="links">
      <a class="link" href="${url}" target="_blank" rel="noopener noreferrer">ソロエルで検索</a>
    </div>
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

