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

// ---- Presets -----------------------------------------------------------
// 発注先・納品日・食材ジャンルの選択肢は、以前はコードに固定で書いていたが、
// 今は「食材マスタ」タブの管理パネルから自由に追加・削除できる
// （バックエンドの Presets シートに保存される）。
const TAG_PALETTE = ['#E7C6D9', '#C9E4DE', '#F6E4B6', '#C6DDF0', '#E3D5CA', '#D6E2E9', '#F1D1B5'];
const PRESET_LABELS = { supplier: '発注先', leadTime: '納品日', ingredientGenre: '食材ジャンル' };
const PRESET_TYPES_ORDER = ['supplier', 'leadTime', 'ingredientGenre'];
const INGREDIENT_CATEGORIES = ['食材', '資材'];

function presetList(type) {
  return (STATE.presets && STATE.presets[type]) || [];
}
function presetValues(type) {
  return presetList(type).map((p) => p.value);
}

function leadTimeRank(lt) {
  const idx = presetValues('leadTime').indexOf(String(lt || ''));
  return idx === -1 ? 999 : idx;
}

function tagColor(tag) {
  const s = String(tag || '');
  if (!s) return '#EDEDED';
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

function datalistHtml(id, options) {
  return '<datalist id="' + id + '">' + options.map((o) => '<option value="' + esc(o) + '">').join('') + '</datalist>';
}

// ---- App state --------------------------------------------------------
let STATE = { ingredients: [], products: [], presets: { supplier: [], leadTime: [], ingredientGenre: [] } };
let inFlight = false;
let composing = false;
let dragSource = null; // { kind: 'ingredient' | 'product', id }

const ui = {
  activeTab: 'order',
  servings: {},
  productFilter: 'active',
  productTagFilter: 'all',
  productSearch: '',
  ingredientFilter: 'active',
  ingredientSearch: '',
  ingredientSort: 'manual',
  ingredientTagFilter: 'all',
  editingProductId: null,
  editingIngredientId: null,
  editingRecipeItem: null, // { productId, ingredientId }
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

// 原価（全部） = 食材＋資材（カトラリー等）を含む、発注シミュレーションで使う原価。
function productCostPerServing(product) {
  return product.recipe.reduce((sum, item) => {
    const ing = STATE.ingredients.find((i) => i.id === item.ingredientId);
    if (!ing) return sum;
    return sum + unitCost(ing) * item.usage;
  }, 0);
}

// 原価（食材のみ） = category が「資材」のものを除いた原価。原価率①に使う。
function productFoodCostPerServing(product) {
  return product.recipe.reduce((sum, item) => {
    const ing = STATE.ingredients.find((i) => i.id === item.ingredientId);
    if (!ing || ing.category === '資材') return sum;
    return sum + unitCost(ing) * item.usage;
  }, 0);
}

function costRatioHtml(product) {
  if (!(product.sellingPrice > 0)) {
    return '<span class="helper-text">販売価格未設定（編集から設定すると原価率が出ます）</span>';
  }
  const foodCost = productFoodCostPerServing(product);
  const allCost = productCostPerServing(product);
  const ratio1 = (foodCost / product.sellingPrice) * 100;
  const ratio2 = (allCost / product.sellingPrice) * 100;
  return '<span class="product-cost-badge" title="食材のみの原価に対して">原価率① ' + fmtNum(ratio1, 1) + '%</span>' +
    '<span class="product-cost-badge" title="食材＋カトラリーの原価に対して">原価率② ' + fmtNum(ratio2, 1) + '%</span>' +
    '<span class="helper-text">販売価格 ' + yen(product.sellingPrice) + '</span>';
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
  const activeProducts = STATE.products.filter((p) => !p.archived).slice().sort((a, b) => a.sortOrder - b.sortOrder);
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
    html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>商品名</th><th class="num">原価/食</th><th style="width:150px">食数</th><th class="num">小計原価</th></tr></thead><tbody>';
    activeProducts.forEach((p) => {
      const cost = productCostPerServing(p);
      const servingsVal = ui.servings[p.id] || '';
      const subtotal = cost * (Number(servingsVal) || 0);
      html += '<tr>';
      html += '<td>' + esc(p.name) + (p.eventTag ? ' <span class="tag-pill" style="background:' + tagColor(p.eventTag) + '">' + esc(p.eventTag) + '</span>' : '') + '</td>';
      html += '<td class="num">' + yen(cost) + '</td>';
      html += '<td><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" id="servings-' + p.id + '" data-bind="servings" data-id="' + p.id + '" value="' + esc(servingsVal) + '" placeholder="0" class="num servings-input"></td>';
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
      html += '<div class="supplier-group"><div class="supplier-head"><span class="supplier-name">' + esc(supplier) + '</span><span class="supplier-meta">' + rows.length + '品目</span></div>';
      html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>食材名</th><th class="num">必要量</th><th class="num">仕入れ単位</th><th class="num">発注個数</th><th>納品まで</th></tr></thead><tbody>';
      rows.forEach((r) => {
        html += '<tr>';
        html += '<td>' + esc(r.ingredient.name) + '</td>';
        html += '<td class="num">' + fmtNum(r.usage) + esc(r.ingredient.unit) + '</td>';
        html += '<td class="num">' + fmtNum(r.ingredient.purchaseQty) + esc(r.ingredient.unit) + '</td>';
        html += '<td class="num">' + r.units + '</td>';
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
  return '<button class="chip" data-action="' + action + '" data-value="' + esc(value) + '" aria-pressed="' + (current === value) + '">' + esc(label) + '</button>';
}

function deleteButtonHtml(kind, id) {
  if (ui.confirmDelete && ui.confirmDelete.kind === kind && ui.confirmDelete.id === id) {
    return '<span class="confirm-inline"><span>本当に削除？</span><button class="btn sm danger-outline" data-action="confirm-delete" data-kind="' + kind + '" data-id="' + id + '">削除する</button><button class="btn sm ghost" data-action="cancel-delete">やめる</button></span>';
  }
  return '<button class="btn sm ghost" data-action="ask-delete" data-kind="' + kind + '" data-id="' + id + '">削除</button>';
}

function ingredientOptionHtml(ing) {
  const label = esc(ing.name) + (ing.category === '資材' ? '［資材］' : '') + (ing.archived ? '（アーカイブ）' : '');
  return '<option value="' + ing.id + '" data-unit="' + esc(ing.unit) + '" data-purchase-qty="' + ing.purchaseQty + '" data-price="' + ing.price + '">' + label + '</option>';
}

function ingredientSelectHtml() {
  if (STATE.ingredients.length === 0) {
    return '<select name="ingredientId" disabled><option>先に食材を登録してください</option></select>';
  }
  const byName = (a, b) => (a.archived === b.archived ? 0 : a.archived ? 1 : -1) || a.name.localeCompare(b.name, 'ja');
  // 食材マスタで付けたジャンルごとに <optgroup> で分けて見やすくする。
  // ジャンル未設定の食材は先頭に「未分類」としてまとめ、既存のジャンル設定順（プリセットの並び順）で続ける。
  const genreOrder = presetValues('ingredientGenre');
  const noGenre = STATE.ingredients.filter((i) => !i.genreTag).sort(byName);
  const usedGenres = Array.from(new Set(STATE.ingredients.map((i) => i.genreTag).filter(Boolean)));
  const orderedGenres = genreOrder.filter((g) => usedGenres.includes(g))
    .concat(usedGenres.filter((g) => !genreOrder.includes(g)).sort((a, b) => a.localeCompare(b, 'ja')));

  // change イベントの委譲だけに頼らず、選んだ瞬間に確実に単位や仕入れ情報を表示するため
  // インラインの onchange も併用する（単位ヒントが反映されない不具合の対策）。
  const onchange = "updateIngredientPickHint(this);";
  let html = '<select name="ingredientId" class="recipe-ingredient-select" required onchange="' + onchange + '"><option value="">選択してください</option>';
  noGenre.forEach((ing) => { html += ingredientOptionHtml(ing); });
  orderedGenres.forEach((genre) => {
    html += '<optgroup label="' + esc(genre) + '">';
    STATE.ingredients.filter((i) => i.genreTag === genre).sort(byName).forEach((ing) => { html += ingredientOptionHtml(ing); });
    html += '</optgroup>';
  });
  html += '</select>';
  return html;
}

// レシピ追加フォームで食材を選んだときに、単位・仕入れ量・値段・単価のヒントを更新する。
// インラインの onchange と change イベント委譲の両方から呼ばれる共通処理。
function updateIngredientPickHint(select) {
  const form = select.closest('form');
  if (!form) return;
  const unitHint = form.querySelector('[data-role="unit-hint"]');
  const infoHint = form.querySelector('[data-role="ingredient-info-hint"]');
  const opt = select.selectedOptions[0];
  const unit = opt ? opt.dataset.unit : '';
  if (unitHint) unitHint.textContent = unit ? '（単位：' + unit + '）' : '';
  if (infoHint) {
    if (opt && opt.value) {
      const purchaseQty = Number(opt.dataset.purchaseQty) || 0;
      const price = Number(opt.dataset.price) || 0;
      const perUnit = purchaseQty > 0 ? price / purchaseQty : 0;
      infoHint.textContent = '仕入れ量：' + fmtNum(purchaseQty) + unit + '　値段：' + yen(price) + '　単価：' + yenUnit(perUnit) + '/' + unit;
    } else {
      infoHint.textContent = '';
    }
  }
}

function recipeRowHtml(p, item) {
  const ing = STATE.ingredients.find((i) => i.id === item.ingredientId);
  const editing = ui.editingRecipeItem && ui.editingRecipeItem.productId === p.id && ui.editingRecipeItem.ingredientId === item.ingredientId;
  if (editing) {
    return '<tr>' +
      '<td>' + (ing ? esc(ing.name) : '<span class="badge-required">削除済みの食材</span>') + '</td>' +
      '<td class="num"><input type="number" id="ri-usage-' + p.id + '-' + item.ingredientId + '" value="' + item.usage + '" min="0" step="any" style="width:80px" class="num"> ' + (ing ? esc(ing.unit) : '') + '</td>' +
      '<td class="num">—</td>' +
      '<td style="white-space:nowrap"><button class="btn sm primary" data-action="save-recipe-item" data-product-id="' + p.id + '" data-ingredient-id="' + item.ingredientId + '">保存</button> <button class="btn sm ghost" data-action="cancel-edit-recipe-item">戻す</button></td>' +
      '</tr>';
  }
  const lineCost = ing ? unitCost(ing) * item.usage : 0;
  const materialBadge = (ing && ing.category === '資材') ? ' <span class="pill" style="background:#eee;font-size:10px">資材</span>' : '';
  return '<tr>' +
    '<td>' + (ing ? esc(ing.name) : '<span class="badge-required">削除済みの食材</span>') + materialBadge + '</td>' +
    '<td class="num">' + fmtNum(item.usage) + (ing ? esc(ing.unit) : '') + '</td>' +
    '<td class="num">' + yen(lineCost) + '</td>' +
    '<td style="white-space:nowrap">' +
    '<button class="icon-btn" data-action="edit-recipe-item" data-product-id="' + p.id + '" data-ingredient-id="' + item.ingredientId + '" title="使用量を編集" aria-label="使用量を編集">✎</button>' +
    '<button class="icon-btn" data-action="remove-recipe-item" data-product-id="' + p.id + '" data-ingredient-id="' + item.ingredientId + '" title="削除" aria-label="削除">✕</button>' +
    '</td></tr>';
}

function productCardHtml(p, draggable) {
  const cost = productCostPerServing(p);
  const editing = ui.editingProductId === p.id;
  let html = '<div class="product-card" data-drag-id="' + p.id + '" data-drag-kind="product"' + (draggable ? ' draggable="true"' : '') + '>';
  html += '<div class="product-card-top">';
  html += '<div class="product-name-row">';
  if (draggable) html += '<span class="drag-handle" title="ドラッグで並び替え">⠿</span>';
  if (editing) {
    html += '<input type="text" id="edit-product-name-' + p.id + '" value="' + esc(p.name) + '" style="font-family:var(--font-display);font-size:16px;padding:4px 8px;border:1px solid var(--line-strong);border-radius:6px;">';
    html += '<input type="text" id="edit-product-tag-' + p.id + '" value="' + esc(p.eventTag || '') + '" list="tag-presets" placeholder="コラボ回タグ（例：まほやくvol1）" style="font-size:13px;padding:4px 8px;border:1px solid var(--line-strong);border-radius:6px;">';
    html += '<input type="number" id="edit-product-price-' + p.id + '" value="' + (p.sellingPrice || '') + '" min="0" step="1" placeholder="販売価格" class="num" style="width:100px;font-size:13px;padding:4px 8px;border:1px solid var(--line-strong);border-radius:6px;">';
    html += '<button class="btn sm primary" data-action="save-product-meta" data-id="' + p.id + '">保存</button>';
    html += '<button class="btn sm ghost" data-action="cancel-edit-product-meta">キャンセル</button>';
  } else {
    html += '<span class="product-name">' + esc(p.name) + '</span>';
    if (p.eventTag) html += '<span class="tag-pill" style="background:' + tagColor(p.eventTag) + '">' + esc(p.eventTag) + '</span>';
    html += '<button class="icon-btn" data-action="edit-product-meta" data-id="' + p.id + '" title="商品名・タグを編集" aria-label="商品名・タグを編集">✎</button>';
    html += '<span class="pill ' + (p.archived ? 'archived' : 'active') + '">' + (p.archived ? 'アーカイブ' : '提供中') + '</span>';
  }
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">';
  html += '<span class="product-cost-badge">原価 ' + yen(cost) + ' / 食</span>';
  html += costRatioHtml(p);
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
    html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>食材</th><th class="num">使用量/食</th><th class="num">原価</th><th style="width:64px"></th></tr></thead><tbody>';
    p.recipe.forEach((item) => { html += recipeRowHtml(p, item); });
    html += '</tbody></table></div>';
  }
  html += '<form class="add-ingredient-row" data-form="add-recipe-item" data-product-id="' + p.id + '">';
  html += '<div class="field"><label>食材を追加</label>' + ingredientSelectHtml() + '<div class="helper-text" data-role="ingredient-info-hint"></div></div>';
  html += '<div class="field qty"><label>使用量/食 <span class="unit-hint" data-role="unit-hint"></span></label><input type="number" name="usage" min="0" step="any" placeholder="例）5" required></div>';
  html += '<button class="btn sm" type="submit">＋ 追加</button>';
  html += '</form>';
  html += '</div>';
  html += '</div>';
  return html;
}

function renderProductsTab() {
  const filter = ui.productFilter || 'active';
  const tagFilter = ui.productTagFilter || 'all';
  const search = (ui.productSearch || '').trim().toLowerCase();
  let list = STATE.products;
  if (filter === 'active') list = list.filter((p) => !p.archived);
  if (filter === 'archived') list = list.filter((p) => p.archived);
  if (tagFilter !== 'all') list = list.filter((p) => (p.eventTag || '') === tagFilter);
  if (search) list = list.filter((p) => p.name.toLowerCase().indexOf(search) !== -1 || (p.eventTag || '').toLowerCase().indexOf(search) !== -1);
  // 並べ替え(ドラッグ)は、全体の並び順(sortOrder)を直接動かす仕組みなので、
  // 絞り込み・検索をしていても常に有効。
  const draggable = true;
  list = list.slice().sort((a, b) => a.sortOrder - b.sortOrder);

  const activeCount = STATE.products.filter((p) => !p.archived).length;
  const archivedCount = STATE.products.filter((p) => p.archived).length;
  const allTags = Array.from(new Set(STATE.products.map((p) => p.eventTag).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ja'));

  let html = '<section class="panel">';
  html += datalistHtml('tag-presets', allTags);
  html += '<div class="card"><div class="card-header"><h2>新しい商品を追加</h2><span class="hint">コラボの新メニューをここから登録</span></div>';
  html += '<div class="card-body"><form data-form="add-product" class="form-grid" style="grid-template-columns: 1fr 1fr 1fr auto;">';
  html += '<div class="field"><label for="new-product-name">商品名</label><input id="new-product-name" name="name" type="text" placeholder="例）ミントゼリーソーダ" required></div>';
  html += '<div class="field"><label for="new-product-tag">コラボ回タグ（任意）</label><input id="new-product-tag" name="eventTag" type="text" list="tag-presets" placeholder="例）まほやくvol1"></div>';
  html += '<div class="field"><label for="new-product-price">販売価格（任意）</label><input id="new-product-price" name="sellingPrice" type="number" min="0" step="1" placeholder="例）600"></div>';
  html += '<div class="form-actions"><button class="btn primary" type="submit">追加</button></div>';
  html += '</form></div></div>';

  html += '<div class="section-title"><h2>ラインナップ</h2><span class="count">' + activeCount + ' 提供中 ・ ' + archivedCount + ' アーカイブ</span></div>';
  html += '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:8px">';
  html += '<div class="chip-row">' + chipHtml('提供中', 'active', filter, 'filter-products') + chipHtml('すべて', 'all', filter, 'filter-products') + chipHtml('アーカイブ', 'archived', filter, 'filter-products') + '</div>';
  html += '<input type="search" id="product-search" class="field search-input" data-bind="product-search" placeholder="商品名・タグで検索" value="' + esc(ui.productSearch || '') + '">';
  html += '</div>';
  if (allTags.length > 0) {
    html += '<div class="chip-row" style="margin-bottom:16px">' + chipHtml('全コラボ', 'all', tagFilter, 'filter-product-tag');
    allTags.forEach((t) => { html += chipHtml(t, t, tagFilter, 'filter-product-tag'); });
    html += '</div>';
  }

  if (list.length === 0) {
    html += '<div class="card"><div class="card-body">' + emptyStateHtml('🧋', filter === 'archived' ? 'アーカイブされた商品はありません' : '一致する商品が見つかりません', filter === 'archived' ? '商品をアーカイブすると、ここに保存されて後から呼び戻せます。' : '上のフォームから商品を追加するか、検索条件を変えてください。') + '</div></div>';
  } else {
    html += '<div class="product-list" data-drag-list="product">';
    list.forEach((p) => { html += productCardHtml(p, draggable); });
    html += '</div>';
  }
  html += '</section>';
  return html;
}

function fieldHtml(type, name, label, placeholder, required, extraAttrs) {
  return '<div class="field"><label for="new-' + name + '">' + esc(label) + '</label><input id="new-' + name + '" name="' + name + '" type="' + type + '" placeholder="' + esc(placeholder) + '"' + (required ? ' required' : '') + (type === 'number' ? ' step="any" min="0"' : '') + (extraAttrs || '') + '></div>';
}

function categorySelectHtml(id, current) {
  let html = '<select id="' + id + '" style="font-size:12px">';
  INGREDIENT_CATEGORIES.forEach((c) => {
    html += '<option value="' + c + '"' + (current === c ? ' selected' : '') + '>' + c + '</option>';
  });
  html += '</select>';
  return html;
}

function addIngredientFormHtml() {
  return '<div class="card"><div class="card-header"><h2>新しい食材を追加</h2><span class="hint">仕入れ情報は一度登録すれば全商品で共有されます</span></div>' +
    '<div class="card-body"><form data-form="add-ingredient" class="form-grid">' +
    fieldHtml('text', 'name', '食材名', '例）ミント（生葉）', true) +
    fieldHtml('text', 'unit', '単位', 'g / ml / 個', true) +
    fieldHtml('number', 'purchaseQty', '仕入れ量', '例）50', true) +
    fieldHtml('number', 'price', '値段（仕入れ量あたり）', '例）300', true) +
    fieldHtml('text', 'supplier', '発注先', '例）〇〇青果', false, ' list="supplier-presets"') +
    fieldHtml('text', 'leadTime', '納品までの時間', '例）翌日', false, ' list="leadtime-presets"') +
    '<div class="field"><label for="new-category">分類</label><select id="new-category" name="category"><option value="食材">食材</option><option value="資材">資材（カトラリー・備品など）</option></select></div>' +
    fieldHtml('text', 'genreTag', 'ジャンル（任意）', '例）乳製品', false, ' list="genre-presets"') +
    '<div class="form-actions"><button class="btn primary" type="submit">追加</button></div>' +
    '</form></div></div>';
}

function ingredientRowHtml(ing, draggable) {
  const editing = ui.editingIngredientId === ing.id;
  const usedIn = STATE.products.filter((p) => p.recipe.some((r) => r.ingredientId === ing.id));
  if (editing) {
    return '<tr class="editing" data-ingredient-id="' + ing.id + '">' +
      '<td><input type="text" id="ei-name-' + ing.id + '" value="' + esc(ing.name) + '" style="width:140px"><br>' +
      categorySelectHtml('ei-category-' + ing.id, ing.category) +
      ' <input type="text" id="ei-genreTag-' + ing.id + '" value="' + esc(ing.genreTag || '') + '" list="genre-presets" placeholder="ジャンル" style="width:80px;font-size:12px;margin-top:4px"></td>' +
      '<td><input type="number" id="ei-purchaseQty-' + ing.id + '" value="' + ing.purchaseQty + '" step="any" min="0" style="width:70px" class="num"> <input type="text" id="ei-unit-' + ing.id + '" value="' + esc(ing.unit) + '" style="width:44px"></td>' +
      '<td><input type="number" id="ei-price-' + ing.id + '" value="' + ing.price + '" step="any" min="0" style="width:90px" class="num"></td>' +
      '<td class="num">' + yenUnit(unitCost(ing)) + '/' + esc(ing.unit) + '</td>' +
      '<td><input type="text" id="ei-supplier-' + ing.id + '" value="' + esc(ing.supplier || '') + '" list="supplier-presets" style="width:110px"></td>' +
      '<td><input type="text" id="ei-leadTime-' + ing.id + '" value="' + esc(ing.leadTime || '') + '" list="leadtime-presets" style="width:90px"></td>' +
      '<td><span class="pill ' + (ing.archived ? 'archived' : 'active') + '">' + (ing.archived ? 'アーカイブ' : '使用中') + '</span></td>' +
      '<td style="white-space:nowrap"><button class="btn sm primary" data-action="save-ingredient" data-id="' + ing.id + '">保存</button> <button class="btn sm ghost" data-action="cancel-edit-ingredient">戻す</button></td>' +
      '</tr>';
  }
  const materialBadge = ing.category === '資材' ? ' <span class="pill" style="background:#eee">資材</span>' : '';
  const genreBadge = ing.genreTag ? ' <span class="tag-pill" style="background:' + tagColor(ing.genreTag) + '">' + esc(ing.genreTag) + '</span>' : '';
  return '<tr class="' + (ing.archived ? 'is-archived' : '') + '" data-drag-id="' + ing.id + '" data-drag-kind="ingredient"' + (draggable ? ' draggable="true"' : '') + '>' +
    '<td>' + (draggable ? '<span class="drag-handle" title="ドラッグで並び替え">⠿</span> ' : '') + esc(ing.name) + materialBadge + genreBadge + (usedIn.length ? '<div class="helper-text">' + usedIn.length + '商品で使用中</div>' : '') + '</td>' +
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

const INGREDIENT_SORTERS = {
  manual: (a, b) => a.sortOrder - b.sortOrder,
  priceDesc: (a, b) => b.price - a.price,
  priceAsc: (a, b) => a.price - b.price,
  leadTimeAsc: (a, b) => leadTimeRank(a.leadTime) - leadTimeRank(b.leadTime) || a.name.localeCompare(b.name, 'ja'),
  leadTimeDesc: (a, b) => leadTimeRank(b.leadTime) - leadTimeRank(a.leadTime) || a.name.localeCompare(b.name, 'ja'),
  status: (a, b) => (a.archived === b.archived ? 0 : a.archived ? 1 : -1) || a.name.localeCompare(b.name, 'ja'),
};

function ingredientSortSelectHtml() {
  const options = [
    ['manual', '手動（並び順）'],
    ['priceDesc', '値段が高い順'],
    ['priceAsc', '値段が低い順'],
    ['leadTimeAsc', '納品が早い順'],
    ['leadTimeDesc', '納品が遅い順'],
    ['status', '使用中を上に'],
  ];
  let html = '<select id="ingredient-sort" data-bind="ingredient-sort" class="field sort-select">';
  options.forEach((o) => {
    html += '<option value="' + o[0] + '"' + (ui.ingredientSort === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
  });
  html += '</select>';
  return html;
}

function presetChipsHtml(type) {
  const items = presetList(type);
  if (items.length === 0) return '<span class="helper-text">まだ登録されていません</span>';
  return items.map((it) => '<span class="chip" style="display:inline-flex;align-items:center;gap:4px;cursor:default">' + esc(it.value) +
    '<button class="icon-btn" data-action="delete-preset" data-id="' + it.id + '" title="削除" aria-label="' + esc(it.value) + 'を削除" style="font-size:11px;padding:0 2px;line-height:1">✕</button></span>').join(' ');
}

function presetsManagerHtml() {
  let html = '<div class="card"><div class="card-header"><h2>選択肢の管理（発注先・納品日・食材ジャンル）</h2><span class="hint">ここで追加・削除した内容が、入力時の候補になります</span></div>';
  html += '<div class="card-body" style="display:flex;flex-direction:column;gap:16px">';
  PRESET_TYPES_ORDER.forEach((type) => {
    const label = PRESET_LABELS[type];
    html += '<div><div style="font-weight:600;margin-bottom:6px">' + esc(label) + '</div>';
    html += '<div class="chip-row" style="margin-bottom:8px">' + presetChipsHtml(type) + '</div>';
    html += '<form data-form="add-preset" data-preset-type="' + type + '" style="display:flex;gap:8px;max-width:320px">';
    html += '<input type="text" name="value" placeholder="新しい' + esc(label) + 'を追加" style="flex:1">';
    html += '<button class="btn sm" type="submit">追加</button>';
    html += '</form></div>';
  });
  html += '</div></div>';
  return html;
}

function renderIngredientsTab() {
  const filter = ui.ingredientFilter || 'active';
  const search = (ui.ingredientSearch || '').trim().toLowerCase();
  const sortKey = ui.ingredientSort || 'manual';
  const tagFilter = ui.ingredientTagFilter || 'all';
  let list = STATE.ingredients;
  if (filter === 'active') list = list.filter((i) => !i.archived);
  if (filter === 'archived') list = list.filter((i) => i.archived);
  if (tagFilter !== 'all') list = list.filter((i) => (i.genreTag || '') === tagFilter);
  if (search) list = list.filter((i) => i.name.toLowerCase().indexOf(search) !== -1 || (i.supplier || '').toLowerCase().indexOf(search) !== -1);
  // 並べ替え(ドラッグ)は全体の並び順(sortOrder)を直接動かす仕組みなので、
  // 絞り込み・検索をしていても常に有効。ただし「手動」以外のソートを
  // 選んでいるときは、見た目の並びがそのソート基準で決まるため無効にする。
  const draggable = sortKey === 'manual';
  list = list.slice().sort(INGREDIENT_SORTERS[sortKey] || INGREDIENT_SORTERS.manual);

  const activeCount = STATE.ingredients.filter((i) => !i.archived).length;
  const archivedCount = STATE.ingredients.filter((i) => i.archived).length;
  const allGenres = Array.from(new Set(STATE.ingredients.map((i) => i.genreTag).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ja'));

  let html = '<section class="panel">';
  html += datalistHtml('supplier-presets', presetValues('supplier'));
  html += datalistHtml('leadtime-presets', presetValues('leadTime'));
  html += datalistHtml('genre-presets', presetValues('ingredientGenre'));
  html += presetsManagerHtml();
  html += addIngredientFormHtml();

  html += '<div class="section-title"><h2>食材マスタ</h2><span class="count">' + activeCount + ' 使用中 ・ ' + archivedCount + ' アーカイブ</span></div>';
  html += '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between">';
  html += '<div class="chip-row">' + chipHtml('使用中', 'active', filter, 'filter-ingredients') + chipHtml('すべて', 'all', filter, 'filter-ingredients') + chipHtml('アーカイブ', 'archived', filter, 'filter-ingredients') + '</div>';
  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">';
  html += ingredientSortSelectHtml();
  html += '<input type="search" id="ingredient-search" class="field search-input" data-bind="ingredient-search" placeholder="食材名・発注先で検索" value="' + esc(ui.ingredientSearch || '') + '">';
  html += '</div></div>';
  if (allGenres.length > 0) {
    html += '<div class="chip-row" style="margin:8px 0 16px">' + chipHtml('全ジャンル', 'all', tagFilter, 'filter-ingredient-tag');
    allGenres.forEach((t) => { html += chipHtml(t, t, tagFilter, 'filter-ingredient-tag'); });
    html += '</div>';
  }

  if (list.length === 0) {
    html += '<div class="card"><div class="card-body">' + emptyStateHtml('🌿', search ? '一致する食材が見つかりません' : '食材がまだ登録されていません', search ? '検索語を変えてお試しください。' : '上のフォームから、ミントやゼリーなどの食材を登録しましょう。一度登録すれば、次のコラボでも使い回せます。') + '</div></div>';
  } else {
    html += '<div class="table-wrap"><table class="data-table"><thead><tr>';
    html += '<th>食材名</th><th class="num">仕入れ量</th><th class="num">値段</th><th class="num">単価</th><th>発注先</th><th>納品まで</th><th>状態</th><th></th>';
    html += '</tr></thead><tbody data-drag-list="ingredient">';
    list.forEach((ing) => { html += ingredientRowHtml(ing, draggable); });
    html += '</tbody></table></div>';
    if (!draggable) html += '<p class="helper-text" style="margin-top:8px">「手動」の並び替えを選んでいるときだけ、ドラッグで並び替えできます。</p>';
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

// ---- Drag & drop reordering -------------------------------------------
function currentFullIds(kind) {
  if (kind === 'ingredient') return STATE.ingredients.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((i) => i.id);
  return STATE.products.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.id);
}

function commitReorder(kind, orderedIds) {
  mutate(kind === 'ingredient' ? 'reorderIngredients' : 'reorderProducts', { orderedIds });
}

document.addEventListener('dragstart', (e) => {
  const el = e.target.closest('[data-drag-id]');
  if (!el || el.getAttribute('draggable') !== 'true') return;
  dragSource = { kind: el.dataset.dragKind, id: el.dataset.dragId };
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', el.dataset.dragId); } catch (err) { /* ignore */ }
  el.classList.add('dragging');
});

document.addEventListener('dragend', (e) => {
  const el = e.target.closest('[data-drag-id]');
  if (el) el.classList.remove('dragging');
  document.querySelectorAll('.drag-over-before, .drag-over-after').forEach((n) => n.classList.remove('drag-over-before', 'drag-over-after'));
});

document.addEventListener('dragenter', (e) => {
  if (!dragSource) return;
  const el = e.target.closest('[data-drag-id]');
  if (!el || el.dataset.dragKind !== dragSource.kind) return;
  e.preventDefault();
});

document.addEventListener('dragover', (e) => {
  if (!dragSource) return;
  const el = e.target.closest('[data-drag-id]');
  if (!el || el.dataset.dragKind !== dragSource.kind) return;
  e.preventDefault();
  document.querySelectorAll('.drag-over-before, .drag-over-after').forEach((n) => {
    if (n !== el) n.classList.remove('drag-over-before', 'drag-over-after');
  });
  const rect = el.getBoundingClientRect();
  const before = (e.clientY - rect.top) < rect.height / 2;
  el.classList.toggle('drag-over-before', before);
  el.classList.toggle('drag-over-after', !before);
});

document.addEventListener('drop', (e) => {
  if (!dragSource) return;
  const el = e.target.closest('[data-drag-id]');
  document.querySelectorAll('.drag-over-before, .drag-over-after').forEach((n) => n.classList.remove('drag-over-before', 'drag-over-after'));
  if (!el || el.dataset.dragKind !== dragSource.kind) { dragSource = null; return; }
  e.preventDefault();
  const targetId = el.dataset.dragId;
  const draggedId = dragSource.id;
  dragSource = null;
  if (targetId === draggedId) return;
  const rect = el.getBoundingClientRect();
  const before = (e.clientY - rect.top) < rect.height / 2;
  const kind = el.dataset.dragKind;
  const ids = currentFullIds(kind).filter((id) => id !== draggedId);
  const idx = ids.indexOf(targetId);
  const insertAt = before ? idx : idx + 1;
  ids.splice(insertAt, 0, draggedId);
  commitReorder(kind, ids);
});

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
  } else if (action === 'filter-product-tag') {
    ui.productTagFilter = actionEl.dataset.value;
    render();
  } else if (action === 'filter-ingredients') {
    ui.ingredientFilter = actionEl.dataset.value;
    render();
  } else if (action === 'edit-product-meta') {
    ui.editingProductId = actionEl.dataset.id;
    render();
    focusSoon('edit-product-name-' + actionEl.dataset.id);
  } else if (action === 'cancel-edit-product-meta') {
    ui.editingProductId = null;
    render();
  } else if (action === 'save-product-meta') {
    const id = actionEl.dataset.id;
    const nameInput = document.getElementById('edit-product-name-' + id);
    const tagInput = document.getElementById('edit-product-tag-' + id);
    const priceInput = document.getElementById('edit-product-price-' + id);
    const name = nameInput ? nameInput.value.trim() : '';
    const eventTag = tagInput ? tagInput.value.trim() : '';
    const sellingPrice = priceInput ? Number(priceInput.value) || 0 : 0;
    if (name) {
      ui.editingProductId = null;
      mutate('updateProduct', { id, name, eventTag, sellingPrice });
    }
  } else if (action === 'archive-product') {
    toggleProductArchived(actionEl.dataset.id);
  } else if (action === 'unarchive-product') {
    toggleProductArchived(actionEl.dataset.id);
  } else if (action === 'edit-recipe-item') {
    ui.editingRecipeItem = { productId: actionEl.dataset.productId, ingredientId: actionEl.dataset.ingredientId };
    render();
    focusSoon('ri-usage-' + actionEl.dataset.productId + '-' + actionEl.dataset.ingredientId);
  } else if (action === 'cancel-edit-recipe-item') {
    ui.editingRecipeItem = null;
    render();
  } else if (action === 'save-recipe-item') {
    const productId = actionEl.dataset.productId;
    const ingredientId = actionEl.dataset.ingredientId;
    const input = document.getElementById('ri-usage-' + productId + '-' + ingredientId);
    const usage = Number(input ? input.value : NaN);
    if (!(usage > 0)) {
      showToast('使用量を正しく入力してください', true);
      return;
    }
    ui.editingRecipeItem = null;
    mutate('upsertRecipeItem', { productId, ingredientId, usage });
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
    const categoryEl = document.getElementById('ei-category-' + id);
    const genreTagEl = document.getElementById('ei-genreTag-' + id);
    const category = categoryEl ? categoryEl.value : '食材';
    const genreTag = genreTagEl ? genreTagEl.value.trim() : '';
    if (!name || !unit || !(purchaseQty > 0) || !(price >= 0)) {
      showToast('食材名・単位・仕入れ量・値段を正しく入力してください', true);
      return;
    }
    ui.editingIngredientId = null;
    mutate('updateIngredient', { id, name, unit, purchaseQty, price, supplier, leadTime, category, genreTag });
  } else if (action === 'toggle-archive-ingredient') {
    mutate('toggleArchiveIngredient', { id: actionEl.dataset.id });
  } else if (action === 'filter-ingredient-tag') {
    ui.ingredientTagFilter = actionEl.dataset.value;
    render();
  } else if (action === 'delete-preset') {
    mutate('deletePreset', { id: actionEl.dataset.id });
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
    const category = (fd.get('category') || '').trim() || '食材';
    const genreTag = (fd.get('genreTag') || '').trim();
    if (!name || !unit || !(purchaseQty > 0) || !(price >= 0)) {
      showToast('食材名・単位・仕入れ量・値段を正しく入力してください', true);
      return;
    }
    mutate('addIngredient', { name, unit, purchaseQty, price, supplier, leadTime, category, genreTag }).then((ok) => {
      if (ok) form.reset();
    });
  } else if (kind === 'add-product') {
    const fd = new FormData(form);
    const name = (fd.get('name') || '').trim();
    const eventTag = (fd.get('eventTag') || '').trim();
    const sellingPrice = Number(fd.get('sellingPrice')) || 0;
    if (!name) return;
    mutate('addProduct', { name, eventTag, sellingPrice }).then((ok) => {
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
  } else if (kind === 'add-preset') {
    const fd = new FormData(form);
    const value = (fd.get('value') || '').trim();
    const type = form.dataset.presetType;
    if (!value) return;
    mutate('addPreset', { type, value }).then((ok) => {
      if (ok) form.reset();
    });
  }
});

// Enter キーでフォーム送信（select や複数入力欄でも確実に動くように統一）。
// IME変換の確定エンター（e.isComposing）は送信しない。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  if (e.target.tagName === 'TEXTAREA') return;
  e.preventDefault();
  if (form.requestSubmit) form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
});

// 数字の入力欄はフォーカス時に全選択して、すぐ上書きできるようにする。
// type="number" は iOS Safari など一部ブラウザで .select() が使えず
// （エラーになって握りつぶされ、見た目には何も選択されない）、それが原因で
// 「食数が入力しにくい」状態になっていたため、食数欄は type="text" +
// inputmode="numeric" にして確実に全選択できるようにしている。
document.addEventListener('focus', (e) => {
  const el = e.target;
  if (el && el.tagName === 'INPUT' && el.select && (el.type === 'number' || el.classList.contains('servings-input'))) {
    try { el.select(); } catch (err) { /* 一部ブラウザでは選択できないことがある */ }
  }
}, true);

// レシピ追加フォームで食材を選ぶと、その単位・仕入れ情報をヒント表示する。
document.addEventListener('change', (e) => {
  const select = e.target.closest('select.recipe-ingredient-select');
  if (!select) return;
  const form = select.closest('form[data-form="add-recipe-item"]');
  if (!form) return;
  updateIngredientPickHint(select);
});

// IME変換中は再描画しない（変換候補がおかしくなるのを防ぐ）。
// compositionend で最終的な値を反映して1回だけ再描画する。
document.addEventListener('compositionstart', () => { composing = true; });
document.addEventListener('compositionend', (e) => {
  composing = false;
  applyLiveInput(e.target);
});

function applyLiveInput(el) {
  if (!el || !el.dataset) return;
  if (el.dataset.bind === 'servings') {
    // 数字以外が混ざらないようにする（type="text"化に伴う簡易バリデーション）。
    const cleaned = el.value.replace(/[^0-9]/g, '');
    if (cleaned !== el.value) el.value = cleaned;
    ui.servings[el.dataset.id] = cleaned;
    render();
  } else if (el.id === 'ingredient-search') {
    ui.ingredientSearch = el.value;
    render();
  } else if (el.id === 'product-search') {
    ui.productSearch = el.value;
    render();
  } else if (el.id === 'ingredient-sort') {
    ui.ingredientSort = el.value;
    render();
  }
}

// アプリ起動。
init().catch((err) => {
  console.error(err);
});

document.addEventListener('input', (e) => {
  if (e.isComposing || composing) return;
  applyLiveInput(e.target);
});

// <select> の value 変更は環境によって input が発火しないことがあるため、
// change でも同じ処理を通す（並び替えセレクトなど）。
document.addEventListener('change', (e) => {
  if (e.target && e.target.tagName === 'SELECT') applyLiveInput(e.target);
});
