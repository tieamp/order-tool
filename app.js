// ---- Backend configuration ----------------------------------------------
// After you deploy the Apps Script Web App (see README.md), paste its URL
// here. It looks like: https://script.google.com/macros/s/AKfycb.../exec
const API_URL = 'https://script.google.com/macros/s/AKfycbwzMyPZikKZ-uwPgk0RnBr495-o_iH0W0r7byDFyozt5cI9qJR9i3o2_TmG1lqGflaa/exec';

function isConfigured() {
  return typeof API_URL === 'string' && API_URL.indexOf('http') === 0;
}

// ---- Passcode storage (per-browser convenience only; the server enforces it)
const PASSCODE_KEY = 'orderLedgerPasscode';
function getPasscode() {
  try { return localStorage.getItem(PASSCODE_KEY) || ''; } catch (err) { return ''; }
}
function setStoredPasscode(pc) {
  try { localStorage.setItem(PASSCODE_KEY, pc); } catch (err) { /* ignore */ }
}
function clearStoredPasscode() {
  try { localStorage.removeItem(PASSCODE_KEY); } catch (err) { /* ignore */ }
}

// ---- API helpers ----------------------------------------------------------
async function apiList(passcode) {
  const url = API_URL + '?action=list&passcode=' + encodeURIComponent(passcode);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('http_' + res.status);
  return res.json();
}

async function apiWrite(action, payload) {
  const body = JSON.stringify({ action, passcode: getPasscode(), payload: payload || {} });
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
  });
  if (!res.ok) throw new Error('http_' + res.status);
  return res.json();
}

// ---- App state --------------------------------------------------------
let STATE = { ingredients: [], products: [] };
let inFlight = false;

const ui = {
  activeTab: 'order',
  servings: {},
  productFilter: 'active',
  ingredientFilter: 'active',
  ingredientSearch: '',
  editingProductName: null,
  editingIngredientId: null,
  confirmDelete: null,
};

function uid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 9); }

function yen(n) {
  const v = Math.round(Number(n) || 0);
  return '¥' + v.toLocaleString('ja-JP');
}

function yenUnit(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1 || v === 0) return '¥' + Math.round(v).toLocaleString('ja-JP');
  return '¥' + v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function fmtNum(n, digits) {
  const d = digits === undefined ? 2 : digits;
  const factor = Math.pow(10, d);
  const r = Math.round((Number(n) || 0) * factor) / factor;
  return r.toLocaleString('ja-JP', { maximumFractionDigits: d });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function unitCost(ing) {
  if (!ing || !ing.purchaseQty) return 0;
  return ing.price / ing.purchaseQty;
}

function productCostPerServing(product) {
  return product.recipe.reduce((sum, item) => {
    const ing = STATE.ingredients.find((i) => i.id === item.ingredientId);
    if (!ing) return sum;
    return sum + unitCost(ing) * item.usage;
  }, 0);
}

function computeOrderPlan() {
  const perIngredient = {};
  let totalCostRaw = 0;
  let totalServings = 0;
  STATE.products.filter((p) => !p.archived).forEach((p) => {
    const servings = Number(ui.servings[p.id]) || 0;
    if (servings <= 0) return;
    totalServings += servings;
    p.recipe.forEach((item) => {
      const ing = STATE.ingredients.find((i) => i.id === item.ingredientId);
      if (!ing) return;
      const usage = item.usage * servings;
      if (!perIngredient[ing.id]) perIngredient[ing.id] = { ingredient: ing, usage: 0 };
      perIngredient[ing.id].usage += usage;
      totalCostRaw += unitCost(ing) * usage;
    });
  });
  const rows = Object.values(perIngredient).map((r) => {
    const units = r.ingredient.purchaseQty > 0 ? Math.ceil(r.usage / r.ingredient.purchaseQty) : 0;
    const orderCost = units * r.ingredient.price;
    return Object.assign({}, r, { units, orderCost });
  }).sort((a, b) => a.ingredient.name.localeCompare(b.ingredient.name, 'ja'));
  const totalOrderCost = rows.reduce((s, r) => s + r.orderCost, 0);
  return { rows, totalCostRaw, totalOrderCost, totalServings };
}

function groupBySupplier(rows) {
  const groups = {};
  rows.forEach((r) => {
    const key = r.ingredient.supplier || '発注先未設定';
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  return Object.keys(groups).sort((a, b) => a.localeCompare(b, 'ja')).map((k) => [k, groups[k]]);
}

function emptyStateHtml(glyph, title, sub) {
  return '<div class="empty-state"><span class="glyph">' + glyph + '</span><strong>' + esc(title) + '</strong><span>' + esc(sub) + '</span></div>';
}

function summaryStripHtml(plan) {
  return '<div class="summary-strip">' +
    '<div class="summary-cell"><span class="label">対象食数</span><span class="value num">' + plan.totalServings + '<span style="font-size:13px;font-weight:400"> 食</span></span></div>' +
    '<div class="summary-cell"><span class="label">原価合計</span><span class="value num accent-mint">' + yen(plan.totalCostRaw) + '</span></div>' +
    '<div class="summary-cell"><span class="label">発注コスト合計</span><span class="value num accent-berry">' + yen(plan.totalOrderCost) + '</span></div>' +
    '<div class="summary-cell"><span class="label">発注する食材</span><span class="value num">' + plan.rows.length + '<span style="font-size:13px;font-weight:400"> 品目</span></span></div>' +
    '</div>';
}

function renderOrderTab() {
  const activeProducts = STATE.products.filter((p) => !p.archived).slice().sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const plan = computeOrderPlan();
  const supplierGroups = groupBySupplier(plan.rows);

  let html = '<section class="panel">';
  html += summaryStripHtml(plan);

  html += '<div class="card"><div class="card-header"><h2>提供する商品と食数</h2>';
  html += '<button class="btn ghost sm" data-action="reset-servings">入力をリセット</button></div>';
  html += '<div class="card-body tight">';
  if (activeProducts.length === 0) {
    html += emptyStateHtml('🍹', '提供中の商品がまだありません', '「商品ラインナップ」タブから商品を追加してください。');
  } else {
    html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>商品名</th><th class="num">原価/食</th><th style="width:140px">食数</th><th class="num">小計原価</th></tr></thead><tbody>';
    activeProducts.forEach((p) => {
      const cost = productCostPerServing(p);
      const servingsVal = ui.servings[p.id] || '';
      const subtotal = cost * (Number(servingsVal) || 0);
      html += '<tr>';
      html += '<td>' + esc(p.name) + '</td>';
      html += '<td class="num">' + yen(cost) + '</td>';
      html += '<td><input type="number" min="0" step="1" inputmode="numeric" id="servings-' + p.id + '" data-bind="servings" data-id="' + p.id + '" value="' + esc(servingsVal) + '" placeholder="0" style="width:88px" class="num"></td>';
      html += '<td class="num">' + (subtotal > 0 ? yen(subtotal) : '—') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div></div>';

  html += '<div>';
  html += '<div class="section-title"><h2>発注リスト（発注先ごと）</h2><span class="count">' + plan.rows.length + ' 品目</span></div>';
  if (plan.rows.length === 0) {
    html += '<div class="card"><div class="card-body">' + emptyStateHtml('📋', 'まだ発注が必要な食材はありません', '上の表で商品ごとの食数を入力すると、重複する食材が自動でまとめられてここに表示されます。') + '</div></div>';
  } else {
    supplierGroups.forEach((entry) => {
      const supplier = entry[0];
      const rows = entry[1];
      const groupCost = rows.reduce((s, r) => s + r.orderCost, 0);
      html += '<div class="supplier-group"><div class="supplier-head"><span class="supplier-name">' + esc(supplier) + '</span><span class="supplier-meta">' + rows.length + '品目 ・ ' + yen(groupCost) + '</span></div>';
      html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>食材名</th><th class="num">必要量</th><th class="num">仕入れ単位</th><th class="num">発注個数</th><th class="num">発注コスト</th><th>納品まで</th></tr></thead><tbody>';
      rows.forEach((r) => {
        html += '<tr>';
        html += '<td>' + esc(r.ingredient.name) + '</td>';
        html += '<td class="num">' + fmtNum(r.usage) + esc(r.ingredient.unit) + '</td>';
        html += '<td class="num">' + fmtNum(r.ingredient.purchaseQty) + esc(r.ingredient.unit) + ' / ' + yen(r.ingredient.price) + '</td>';
        html += '<td class="num">' + r.units + '</td>';
        html += '<td class="num">' + yen(r.orderCost) + '</td>';
        html += '<td>' + esc(r.ingredient.leadTime || '—') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';
    });
  }
  html += '</div>';
  html += '</section>';
  return html;
}

function chipHtml(label, value, current, action) {
  return '<button class="chip" data-action="' + action + '" data-value="' + value + '" aria-pressed="' + (current === value) + '">' + esc(label) + '</button>';
}

function deleteButtonHtml(kind, id) {
  if (ui.confirmDelete && ui.confirmDelete.kind === kind && ui.confirmDelete.id === id) {
    return '<span class="confirm-inline"><span>本当に削除？</span><button class="btn sm danger-outline" data-action="confirm-delete" data-kind="' + kind + '" data-id="' + id + '">削除する</button><button class="btn sm ghost" data-action="cancel-delete">やめる</button></span>';
  }
  return '<button class="btn sm ghost" data-action="ask-delete" data-kind="' + kind + '" data-id="' + id + '">削除</button>';
}

function ingredientSelectHtml() {
  const sorted = STATE.ingredients.slice().sort((a, b) => (a.archived === b.archived ? 0 : a.archived ? 1 : -1) || a.name.localeCompare(b.name, 'ja'));
  if (sorted.length === 0) {
    return '<select name="ingredientId" disabled><option>先に食材を登録してください</option></select>';
  }
  let html = '<select name="ingredientId" required><option value="">選択してください</option>';
  sorted.forEach((ing) => {
    html += '<option value="' + ing.id + '">' + esc(ing.name) + (ing.archived ? '（アーカイブ）' : '') + '</option>';
  });
  html += '</select>';
  return html;
}

function productCardHtml(p) {
  const cost = productCostPerServing(p);
  const editing = ui.editingProductName === p.id;
  let html = '<div class="product-card" data-product-id="' + p.id + '">';
  html += '<div class="product-card-top">';
  html += '<div class="product-name-row">';
  if (editing) {
    html += '<input type="text" id="edit-product-name-' + p.id + '" value="' + esc(p.name) + '" style="font-family:var(--font-display);font-size:16px;padding:4px 8px;border:1px solid var(--line-strong);border-radius:6px;">';
    html += '<button class="btn sm primary" data-action="save-product-name" data-id="' + p.id + '">保存</button>';
    html += '<button class="btn sm ghost" data-action="cancel-edit-product-name">キャンセル</button>';
  } else {
    html += '<span class="product-name">' + esc(p.name) + '</span>';
    html += '<button class="icon-btn" data-action="edit-product-name" data-id="' + p.id + '" title="商品名を編集" aria-label="商品名を編集">✎</button>';
    html += '<span class="pill ' + (p.archived ? 'archived' : 'active') + '">' + (p.archived ? 'アーカイブ' : '提供中') + '</span>';
  }
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:10px">';
  html += '<span class="product-cost-badge">原価 ' + yen(cost) + ' / 食</span>';
  html += '<div class="product-actions">';
  if (p.archived) {
    html += '<button class="btn sm mint" data-action="unarchive-product" data-id="' + p.id + '">ラインナップに戻す</button>';
  } else {
    html += '<button class="btn sm ghost" data-action="archive-product" data-id="' + p.id + '">アーカイブ</button>';
  }
  html += deleteButtonHtml('product', p.id);
  html += '</div></div>';
  html += '</div>';

  html += '<div class="recipe-table">';
  if (p.recipe.length === 0) {
    html += '<div class="recipe-empty">使用する食材がまだ登録されていません。下から追加してください。</div>';
  } else {
    html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>食材</th><th class="num">使用量/食</th><th class="num">原価</th><th style="width:40px"></th></tr></thead><tbody>';
    p.recipe.forEach((item) => {
      const ing = STATE.ingredients.find((i) => i.id === item.ingredientId);
      const lineCost = ing ? unitCost(ing) * item.usage : 0;
      html += '<tr>';
      html += '<td>' + (ing ? esc(ing.name) : '<span class="badge-required">削除済みの食材</span>') + '</td>';
      html += '<td class="num">' + fmtNum(item.usage) + (ing ? esc(ing.unit) : '') + '</td>';
      html += '<td class="num">' + yen(lineCost) + '</td>';
      html += '<td><button class="icon-btn" data-action="remove-recipe-item" data-product-id="' + p.id + '" data-ingredient-id="' + item.ingredientId + '" title="削除" aria-label="削除">✕</button></td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '<form class="add-ingredient-row" data-form="add-recipe-item" data-product-id="' + p.id + '">';
  html += '<div class="field"><label>食材を追加</label>' + ingredientSelectHtml() + '</div>';
  html += '<div class="field qty"><label>使用量/食</label><input type="number" name="usage" min="0" step="any" placeholder="例）5" required></div>';
  html += '<button class="btn sm" type="submit">＋ 追加</button>';
  html += '</form>';
  html += '</div>';
  html += '</div>';
  return html;
}

function renderProductsTab() {
  const filter = ui.productFilter || 'active';
  let list = STATE.products;
  if (filter === 'active') list = list.filter((p) => !p.archived);
  if (filter === 'archived') list = list.filter((p) => p.archived);
  list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  const activeCount = STATE.products.filter((p) => !p.archived).length;
  const archivedCount = STATE.products.filter((p) => p.archived).length;

  let html = '<section class="panel">';
  html += '<div class="card"><div class="card-header"><h2>新しい商品を追加</h2><span class="hint">コラボの新メニューをここから登録</span></div>';
  html += '<div class="card-body"><form data-form="add-product" class="form-grid" style="grid-template-columns: 1fr auto;">';
  html += '<div class="field"><label for="new-product-name">商品名</label><input id="new-product-name" name="name" type="text" placeholder="例）ミントゼリーソーダ" required></div>';
  html += '<div class="form-actions"><button class="btn primary" type="submit">追加</button></div>';
  html += '</form></div></div>';

  html += '<div class="section-title"><h2>ラインナップ</h2><span class="count">' + activeCount + ' 提供中 ・ ' + archivedCount + ' アーカイブ</span></div>';
  html += '<div class="chip-row">';
  html += chipHtml('提供中', 'active', filter, 'filter-products');
  html += chipHtml('すべて', 'all', filter, 'filter-products');
  html += chipHtml('アーカイブ', 'archived', filter, 'filter-products');
  html += '</div>';

  if (list.length === 0) {
    html += '<div class="card"><div class="card-body">' + emptyStateHtml('🧋', filter === 'archived' ? 'アーカイブされた商品はありません' : '商品がまだ登録されていません', filter === 'archived' ? '商品をアーカイブすると、ここに保存されて後から呼び戻せます。' : '上のフォームから商品を追加してください。') + '</div></div>';
  } else {
    html += '<div class="product-list">';
    list.forEach((p) => { html += productCardHtml(p); });
    html += '</div>';
  }
  html += '</section>';
  return html;
}

function fieldHtml(type, name, label, placeholder, required) {
  return '<div class="field"><label for="new-' + name + '">' + esc(label) + '</label><input id="new-' + name + '" name="' + name + '" type="' + type + '" placeholder="' + esc(placeholder) + '"' + (required ? ' required' : '') + (type === 'number' ? ' step="any" min="0"' : '') + '></div>';
}

function addIngredientFormHtml() {
  return '<div class="card"><div class="card-header"><h2>新しい食材を追加</h2><span class="hint">仕入れ情報は一度登録すれば全商品で共有されます</span></div>' +
    '<div class="card-body"><form data-form="add-ingredient" class="form-grid">' +
    fieldHtml('text', 'name', '食材名', '例）ミント（生葉）', true) +
    fieldHtml('text', 'unit', '単位', 'g / ml / 個', true) +
    fieldHtml('number', 'purchaseQty', '仕入れ量', '例）50', true) +
    fieldHtml('number', 'price', '値段（仕入れ量あたり）', '例）300', true) +
    fieldHtml('text', 'supplier', '発注先', '例）〇〇青果', false) +
    fieldHtml('text', 'leadTime', '納品までの時間', '例）翌日', false) +
    '<div class="form-actions"><button class="btn primary" type="submit">追加</button></div>' +
    '</form></div></div>';
}

function ingredientRowHtml(ing) {
  const editing = ui.editingIngredientId === ing.id;
  const usedIn = STATE.products.filter((p) => p.recipe.some((r) => r.ingredientId === ing.id));
  if (editing) {
    return '<tr class="editing" data-ingredient-id="' + ing.id + '">' +
      '<td><input type="text" id="ei-name-' + ing.id + '" value="' + esc(ing.name) + '" style="width:140px"></td>' +
      '<td><input type="number" id="ei-purchaseQty-' + ing.id + '" value="' + ing.purchaseQty + '" step="any" min="0" style="width:70px" class="num"> <input type="text" id="ei-unit-' + ing.id + '" value="' + esc(ing.unit) + '" style="width:44px"></td>' +
      '<td><input type="number" id="ei-price-' + ing.id + '" value="' + ing.price + '" step="any" min="0" style="width:90px" class="num"></td>' +
      '<td class="num">' + yenUnit(unitCost(ing)) + '/' + esc(ing.unit) + '</td>' +
      '<td><input type="text" id="ei-supplier-' + ing.id + '" value="' + esc(ing.supplier || '') + '" style="width:110px"></td>' +
      '<td><input type="text" id="ei-leadTime-' + ing.id + '" value="' + esc(ing.leadTime || '') + '" style="width:90px"></td>' +
      '<td><span class="pill ' + (ing.archived ? 'archived' : 'active') + '">' + (ing.archived ? 'アーカイブ' : '使用中') + '</span></td>' +
      '<td style="white-space:nowrap"><button class="btn sm primary" data-action="save-ingredient" data-id="' + ing.id + '">保存</button> <button class="btn sm ghost" data-action="cancel-edit-ingredient">戻す</button></td>' +
      '</tr>';
  }
  return '<tr class="' + (ing.archived ? 'is-archived' : '') + '" data-ingredient-id="' + ing.id + '">' +
    '<td>' + esc(ing.name) + (usedIn.length ? '<div class="helper-text">' + usedIn.length + '商品で使用中</div>' : '') + '</td>' +
    '<td class="num">' + fmtNum(ing.purchaseQty) + esc(ing.unit) + '</td>' +
    '<td class="num">' + yen(ing.price) + '</td>' +
    '<td class="num">' + yenUnit(unitCost(ing)) + '/' + esc(ing.unit) + '</td>' +
    '<td>' + esc(ing.supplier || '—') + '</td>' +
    '<td>' + esc(ing.leadTime || '—') + '</td>' +
    '<td><span class="pill ' + (ing.archived ? 'archived' : 'active') + '">' + (ing.archived ? 'アーカイブ' : '使用中') + '</span></td>' +
    '<td style="white-space:nowrap">' +
    '<button class="icon-btn" data-action="edit-ingredient" data-id="' + ing.id + '" title="編集" aria-label="編集">✎</button> ' +
    '<button class="btn sm ghost" data-action="toggle-archive-ingredient" data-id="' + ing.id + '">' + (ing.archived ? '復活' : 'アーカイブ') + '</button> ' +
    (usedIn.length === 0 ? deleteButtonHtml('ingredient', ing.id) : '<span class="helper-text" style="white-space:nowrap">使用中のため削除不可</span>') +
    '</td></tr>';
}

function renderIngredientsTab() {
  const filter = ui.ingredientFilter || 'active';
  const search = (ui.ingredientSearch || '').trim().toLowerCase();
  let list = STATE.ingredients;
  if (filter === 'active') list = list.filter((i) => !i.archived);
  if (filter === 'archived') list = list.filter((i) => i.archived);
  if (search) list = list.filter((i) => i.name.toLowerCase().indexOf(search) !== -1 || (i.supplier || '').toLowerCase().indexOf(search) !== -1);
  list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  const activeCount = STATE.ingredients.filter((i) => !i.archived).length;
  const archivedCount = STATE.ingredients.filter((i) => i.archived).length;

  let html = '<section class="panel">';
  html += addIngredientFormHtml();

  html += '<div class="section-title"><h2>食材マスタ</h2><span class="count">' + activeCount + ' 使用中 ・ ' + archivedCount + ' アーカイブ</span></div>';
  html += '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between">';
  html += '<div class="chip-row">' + chipHtml('使用中', 'active', filter, 'filter-ingredients') + chipHtml('すべて', 'all', filter, 'filter-ingredients') + chipHtml('アーカイブ', 'archived', filter, 'filter-ingredients') + '</div>';
  html += '<input type="search" id="ingredient-search" class="field search-input" data-bind="ingredient-search" placeholder="食材名・発注先で検索" value="' + esc(ui.ingredientSearch || '') + '">';
  html += '</div>';

  if (list.length === 0) {
    html += '<div class="card"><div class="card-body">' + emptyStateHtml('🌿', search ? '一致する食材が見つかりません' : '食材がまだ登録されていません', search ? '検索語を変えてお試しください。' : '上のフォームから、ミントやゼリーなどの食材を登録しましょう。一度登録すれば、次のコラボでも使い回せます。') + '</div></div>';
  } else {
    html += '<div class="table-wrap"><table class="data-table"><thead><tr>';
    html += '<th>食材名</th><th class="num">仕入れ量</th><th class="num">値段</th><th class="num">単価</th><th>発注先</th><th>納品まで</th><th>状態</th><th></th>';
    html += '</tr></thead><tbody>';
    list.forEach((ing) => { html += ingredientRowHtml(ing); });
    html += '</tbody></table></div>';
  }
  html += '</section>';
  return html;
}

function updateCounts() {
  const pc = STATE.products.filter((p) => !p.archived).length;
  const ic = STATE.ingredients.length;
  const pEl = document.getElementById('count-products');
  const iEl = document.getElementById('count-ingredients');
  if (pEl) pEl.textContent = pc ? ' (' + pc + ')' : '';
  if (iEl) iEl.textContent = ic ? ' (' + ic + ')' : '';
}

function updateTabSelection() {
  ['order', 'products', 'ingredients'].forEach((t) => {
    const btn = document.getElementById('tab-btn-' + t);
    if (btn) btn.setAttribute('aria-selected', String(t === ui.activeTab));
  });
}

function render() {
  const active = document.activeElement;
  const main = document.getElementById('main-content');
  let focusInfo = null;
  if (active && active.id && main && main.contains(active)) {
    focusInfo = { id: active.id, start: active.selectionStart, end: active.selectionEnd };
  }
  updateCounts();
  updateTabSelection();
  if (ui.activeTab === 'order') main.innerHTML = renderOrderTab();
  else if (ui.activeTab === 'products') main.innerHTML = renderProductsTab();
  else main.innerHTML = renderIngredientsTab();
  if (focusInfo) {
    const el = document.getElementById(focusInfo.id);
    if (el) {
      el.focus();
      if (typeof focusInfo.start === 'number' && el.setSelectionRange) {
        try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch (err) { /* ignore */ }
      }
    }
  }
}

function focusSoon(id) {
  setTimeout(() => {
    const el = document.getElementById(id);
    if (el) { el.focus(); if (el.select) el.select(); }
  }, 0);
}

let toastTimer = null;
function showToast(msg, isError) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'toast' + (isError ? ' error' : '');
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function setSyncStatus(state, message) {
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  if (!dot || !label) return;
  dot.className = 'sync-dot' + (state === 'saving' ? ' saving' : state === 'error' ? ' error' : '');
  label.textContent = message || (state === 'saving' ? '保存中…' : '同期ずみ');
}

// ---- Mutations: every write is a round trip to the Apps Script backend ----
// The server is the source of truth (important with several staff editing at
// once), so we replace STATE with whatever it sends back rather than
// applying changes locally.
async function mutate(action, payload) {
  if (inFlight) return false;
  inFlight = true;
  setSyncStatus('saving');
  try {
    const result = await apiWrite(action, payload);
    if (!result.ok) {
      handleApiError(result.error);
      return false;
    }
    STATE = result.data;
    setSyncStatus('idle');
    render();
    return true;
  } catch (err) {
    console.error('mutate failed', err);
    setSyncStatus('error', '通信に失敗しました');
    showToast('保存できませんでした。通信環境を確認してもう一度お試しください', true);
    return false;
  } finally {
    inFlight = false;
  }
}

function handleApiError(code) {
  if (code === 'bad_passcode' || code === 'passcode_not_set') {
    clearStoredPasscode();
    setSyncStatus('error', '合言葉を確認してください');
    showGate(code === 'passcode_not_set'
      ? 'このシートにはまだ合言葉が設定されていません。README を確認してください。'
      : '合言葉が正しくありません。管理者に確認してください。');
  } else if (code === 'ingredient_in_use') {
    showToast('使用中の食材は削除できません', true);
    setSyncStatus('idle');
  } else if (code === 'not_found') {
    showToast('データが見つかりませんでした。画面を更新してください', true);
    setSyncStatus('idle');
  } else {
    showToast('保存できませんでした（' + code + '）', true);
    setSyncStatus('error', '保存に失敗しました');
  }
}

// ---- Passcode gate ----------------------------------------------------
function showGate(errorMessage) {
  const gate = document.getElementById('gate');
  const app = document.getElementById('app');
  const notice = document.getElementById('gate-setup-notice');
  gate.hidden = false;
  app.hidden = true;
  if (!isConfigured()) {
    notice.hidden = false;
    notice.innerHTML = 'APIのURLがまだ設定されていません。<code>app.js</code> の先頭にある <code>API_URL</code> に、Apps Script をデプロイして得られたURLを貼り付けてください（README参照）。';
  } else {
    notice.hidden = true;
  }
  const errEl = document.getElementById('gate-error');
  errEl.textContent = errorMessage || '';
  focusSoon('gate-passcode');
}

function hideGate() {
  document.getElementById('gate').hidden = true;
  document.getElementById('app').hidden = false;
}

async function tryEnter(passcode) {
  const errEl = document.getElementById('gate-error');
  errEl.textContent = '';
  if (!isConfigured()) {
    showGate();
    return;
  }
  try {
    const result = await apiList(passcode);
    if (!result.ok) {
      if (result.error === 'passcode_not_set') {
        showGate('このシートにはまだ合言葉が設定されていません。README を確認してください。');
      } else {
        errEl.textContent = '合言葉が正しくありません。';
      }
      return;
    }
    STATE = result.data;
    setStoredPasscode(passcode);
    hideGate();
    setSyncStatus('idle');
    render();
  } catch (err) {
    console.error(err);
    errEl.textContent = '通信に失敗しました。ネットワークやAPIのURLを確認してください。';
  }
}

async function init() {
  document.getElementById('gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('gate-passcode').value.trim();
    if (val) tryEnter(val);
  });

  if (!isConfigured()) {
    showGate();
    return;
  }
  const stored = getPasscode();
  if (stored) {
    try {
      const result = await apiList(stored);
      if (result.ok) {
        STATE = result.data;
        hideGate();
        setSyncStatus('idle');
        render();
        return;
      }
      if (result.error !== 'bad_passcode' && result.error !== 'passcode_not_set') {
        // transient/network-ish issue: keep the stored passcode and let the
        // user retry via the gate rather than forcing re-entry.
      }
      clearStoredPasscode();
    } catch (err) {
      console.error(err);
      // Could be offline; fall through to the gate so the user can retry.
    }
  }
  showGate();
}

function toggleProductArchived(id) {
  mutate('toggleArchiveProduct', { id });
}

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('.tab-btn');
  if (tabBtn) {
    ui.activeTab = tabBtn.dataset.tab;
    render();
    return;
  }

  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  if (action === 'reset-servings') {
    ui.servings = {};
    render();
  } else if (action === 'filter-products') {
    ui.productFilter = actionEl.dataset.value;
    render();
  } else if (action === 'filter-ingredients') {
    ui.ingredientFilter = actionEl.dataset.value;
    render();
  } else if (action === 'edit-product-name') {
    ui.editingProductName = actionEl.dataset.id;
    render();
    focusSoon('edit-product-name-' + actionEl.dataset.id);
  } else if (action === 'cancel-edit-product-name') {
    ui.editingProductName = null;
    render();
  } else if (action === 'save-product-name') {
    const id = actionEl.dataset.id;
    const input = document.getElementById('edit-product-name-' + id);
    const val = input ? input.value.trim() : '';
    if (val) {
      ui.editingProductName = null;
      mutate('updateProductName', { id, name: val });
    }
  } else if (action === 'archive-product') {
    toggleProductArchived(actionEl.dataset.id);
  } else if (action === 'unarchive-product') {
    toggleProductArchived(actionEl.dataset.id);
  } else if (action === 'remove-recipe-item') {
    mutate('removeRecipeItem', { productId: actionEl.dataset.productId, ingredientId: actionEl.dataset.ingredientId });
  } else if (action === 'edit-ingredient') {
    ui.editingIngredientId = actionEl.dataset.id;
    render();
    focusSoon('ei-name-' + actionEl.dataset.id);
  } else if (action === 'cancel-edit-ingredient') {
    ui.editingIngredientId = null;
    render();
  } else if (action === 'save-ingredient') {
    const id = actionEl.dataset.id;
    const name = document.getElementById('ei-name-' + id).value.trim();
    const unit = document.getElementById('ei-unit-' + id).value.trim();
    const purchaseQty = Number(document.getElementById('ei-purchaseQty-' + id).value);
    const price = Number(document.getElementById('ei-price-' + id).value);
    const supplier = document.getElementById('ei-supplier-' + id).value.trim();
    const leadTime = document.getElementById('ei-leadTime-' + id).value.trim();
    if (!name || !unit || !(purchaseQty > 0) || !(price >= 0)) {
      showToast('食材名・単位・仕入れ量・値段を正しく入力してください', true);
      return;
    }
    ui.editingIngredientId = null;
    mutate('updateIngredient', { id, name, unit, purchaseQty, price, supplier, leadTime });
  } else if (action === 'toggle-archive-ingredient') {
    mutate('toggleArchiveIngredient', { id: actionEl.dataset.id });
  } else if (action === 'ask-delete') {
    ui.confirmDelete = { kind: actionEl.dataset.kind, id: actionEl.dataset.id };
    render();
  } else if (action === 'cancel-delete') {
    ui.confirmDelete = null;
    render();
  } else if (action === 'confirm-delete') {
    const kind = actionEl.dataset.kind;
    const id = actionEl.dataset.id;
    ui.confirmDelete = null;
    mutate(kind === 'product' ? 'deleteProduct' : 'deleteIngredient', { id });
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;

  if (kind === 'add-ingredient') {
    const fd = new FormData(form);
    const name = (fd.get('name') || '').trim();
    const unit = (fd.get('unit') || '').trim();
    const purchaseQty = Number(fd.get('purchaseQty'));
    const price = Number(fd.get('price'));
    const supplier = (fd.get('supplier') || '').trim();
    const leadTime = (fd.get('leadTime') || '').trim();
    if (!name || !unit || !(purchaseQty > 0) || !(price >= 0)) {
      showToast('食材名・単位・仕入れ量・値段を正しく入力してください', true);
      return;
    }
    mutate('addIngredient', { name, unit, purchaseQty, price, supplier, leadTime }).then((ok) => {
      if (ok) form.reset();
    });
  } else if (kind === 'add-product') {
    const fd = new FormData(form);
    const name = (fd.get('name') || '').trim();
    if (!name) return;
    mutate('addProduct', { name }).then((ok) => {
      if (ok) form.reset();
    });
  } else if (kind === 'add-recipe-item') {
    const fd = new FormData(form);
    const ingredientId = fd.get('ingredientId');
    const usage = Number(fd.get('usage'));
    if (!ingredientId || !(usage > 0)) {
      showToast('食材と使用量を入力してください', true);
      return;
    }
    mutate('upsertRecipeItem', { productId: form.dataset.productId, ingredientId, usage });
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el || !el.dataset) return;
  if (el.dataset.bind === 'servings') {
    ui.servings[el.dataset.id] = el.value;
    render();
  } else if (el.id === 'ingredient-search') {
    ui.ingredientSearch = el.value;
    render();
  }
});

init();
