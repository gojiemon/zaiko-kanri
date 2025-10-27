// 在庫管理PWA フロントエンド実装（プレーンJS）
// - Service Worker登録
// - APIラッパ
// - 画面タブ切替
// - /items 取得、一覧と不足描画
// - 在庫更新（−/＋/直入力）→ /stock/update → 再読込
// - Badging APIで不足件数表示（対応環境のみ）
// - ネットエラーはalert

(() => {
  'use strict';

  // APIベースURL（env.jsで設定）
  const API_BASE = (typeof GAS_API_BASE === 'string') ? GAS_API_BASE : '';
  if (!API_BASE) {
    console.warn('GAS_API_BASE が未設定です。env.js を編集してください。');
  }

  // グローバル状態
  let allItems = []; // シート Items の全件
  let shortages = []; // 不足アイテム

  // PWA: Service Worker 登録
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('Service Worker 登録失敗:', err);
      });
    });
  }

  // APIラッパ
  async function api(path, { method = 'GET', body = undefined, query = undefined } = {}) {
    if (!API_BASE) throw new Error('GAS_API_BASE 未設定');
    const params = new URLSearchParams();
    params.set('path', path);
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) params.set(k, String(v));
    }
    const url = `${API_BASE}?${params.toString()}`;
    // 注意: GAS WebアプリへクロスオリジンPOST時、"application/json" を付けると
    // ブラウザが事前検査(Preflight)を行い失敗することがあるため付けません。
    // 代わりに素のテキストとしてJSON文字列を送ります（サーバ側はJSON.parseで対応）。
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
    } catch (e) {
      // iOS など非対応は無視
    }
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

    // ソロエルトップ
    document.getElementById('openSoloelTop')?.addEventListener('click', () => {
      window.open('https://solution.soloel.com/', '_blank');
    });

    // テスト減算ボタン
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

    // リロード
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
    document.getElementById('itemsContainer')?.addEventListener('click', onCardClick);
    document.getElementById('itemsContainer')?.addEventListener('change', onQtyChange);
  }

  function disableButtons(disabled) {
    document.querySelectorAll('button').forEach(b => b.disabled = !!disabled);
  }

  // 在庫更新（−/＋/直入力）
  async function updateStock(id, value) {
    const v = Math.max(0, Number(value) || 0);
    await api('/stock/update', { method: 'POST', body: { id: Number(id), value: v } });
    await loadItems();
  }

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
    } else if (action === 'inc') {
      const next = Math.round((current + 1) * 100) / 100;
      input.value = fmt2(next);
      await updateStock(id, next);
    }
  }

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
  }

  // アイテム読み込み
  async function loadItems() {
    try {
      const data = await api('/items');
      allItems = Array.isArray(data) ? data : [];
      // 不足抽出
      shortages = allItems.filter(it => Number(it['現在庫数']) < Number(it['最低在庫数']));
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
    wrap.innerHTML = shortages.map(renderItemCard).join('') || '<p>不足はありません。</p>';
  }

  function renderItems() {
    const wrap = document.getElementById('itemsContainer');
    if (!wrap) return;
    const q = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
    const cat = document.getElementById('categorySelect')?.value || '';
    const list = allItems.filter(it => {
      const okQ = !q || String(it['商品名']).toLowerCase().includes(q);
      const okC = !cat || String(it['カテゴリ'] || '') === cat;
      return okQ && okC;
    });
    wrap.innerHTML = list.map(renderItemCard).join('') || '<p>データがありません。</p>';
  }

  function renderItemCard(it) {
    const id = it['ID'];
    const name = it['商品名'];
    const unit = it['単位'] || '';
    const cur = Number(it['現在庫数']) || 0;
    const min = Number(it['最低在庫数']) || 0;
    const shortage = cur < min;
    const url = soloelLink(name, it['ソロエルURL（任意）']);
    return `
<article class="card ${shortage ? 'shortage' : ''}" aria-label="${name}">
  <div class="card-header">
    <h3 class="item-title">${escapeHtml(name)}</h3>
    <small class="item-meta">${escapeHtml(it['カテゴリ'] || '')}</small>
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
