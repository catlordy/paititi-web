const elements = {
  compatibility: document.querySelector("#compatibility"),
  connectionState: document.querySelector("#connectionState"),
  connectButton: document.querySelector("#connectButton"),
  newSlotButton: document.querySelector("#newSlotButton"),
  saveButton: document.querySelector("#saveButton"),
  requiredCount: document.querySelector("#requiredCount"),
  readyCount: document.querySelector("#readyCount"),
  missingCount: document.querySelector("#missingCount"),
  queuedCount: document.querySelector("#queuedCount"),
  emptyState: document.querySelector("#emptyState"),
  assetGrid: document.querySelector("#assetGrid"),
  gitPanel: document.querySelector("#gitPanel"),
  gitCommands: document.querySelector("#gitCommands"),
  copyGitButton: document.querySelector("#copyGitButton"),
  pngPicker: document.querySelector("#pngPicker"),
  slotDialog: document.querySelector("#slotDialog"),
  slotForm: document.querySelector("#slotForm"),
  formError: document.querySelector("#formError"),
  cancelSlotButton: document.querySelector("#cancelSlotButton"),
  closeSlotButton: document.querySelector("#closeSlotButton"),
  toast: document.querySelector("#toast")
};

const state = {
  root: null,
  manifest: null,
  slotDocument: null,
  items: [],
  queued: new Map(),
  previewUrls: new Map(),
  activeVisualId: null,
  filter: "all",
  slotsDirty: false,
  toastTimer: null
};

const supportsFileSystemAccess = "showDirectoryPicker" in window;
elements.compatibility.hidden = supportsFileSystemAccess;
elements.connectButton.disabled = !supportsFileSystemAccess;

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("show");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function normalizePath(path) {
  return String(path).replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function validateRuntimePath(path) {
  const normalized = normalizePath(path);
  if (!/^runtime\/[a-z0-9_./-]+\.png$/i.test(normalized)) {
    throw new Error("运行时路径必须位于 runtime/ 下并以 .png 结尾。");
  }
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("运行时路径包含不安全的目录片段。");
  }
  return normalized;
}

async function ensureWritePermission(handle) {
  const options = { mode: "readwrite" };
  if (await handle.queryPermission(options) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function getFileHandleAtPath(root, path, create = false) {
  const parts = normalizePath(path).split("/");
  const fileName = parts.pop();
  let directory = root;
  for (const part of parts) {
    if (!part || part === "." || part === "..") throw new Error("文件路径不安全。");
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return directory.getFileHandle(fileName, { create });
}

async function readJson(root, path) {
  const handle = await getFileHandleAtPath(root, path);
  const file = await handle.getFile();
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Error(path + " 不是有效的 JSON。");
  }
}

async function writeJson(root, path, value) {
  const handle = await getFileHandleAtPath(root, path, true);
  const writer = await handle.createWritable();
  await writer.write(JSON.stringify(value, null, 2) + "\n");
  await writer.close();
}

async function writeFile(root, path, file) {
  const handle = await getFileHandleAtPath(root, validateRuntimePath(path), true);
  const writer = await handle.createWritable();
  await writer.write(file);
  await writer.close();
}

async function tryReadFile(root, path) {
  try {
    return await (await getFileHandleAtPath(root, path)).getFile();
  } catch (error) {
    if (error.name === "NotFoundError") return null;
    throw error;
  }
}

function validateRepository(manifest, slotDocument) {
  if (!manifest || !Array.isArray(manifest.assets) || !manifest.manifest_version) {
    throw new Error("asset-manifest.json 结构不正确。请选择 paititi-art 仓库根目录。");
  }
  if (!slotDocument || !Array.isArray(slotDocument.slots) || !slotDocument.slot_version) {
    throw new Error("asset-slots.json 结构不正确。请先同步最新版 paititi-art 仓库。");
  }

  const ids = new Set();
  const paths = new Set();
  for (const slot of slotDocument.slots) {
    if (!/^[a-z0-9_]+$/.test(slot.visual_id)) throw new Error("槽位 visual_id 不合法：" + slot.visual_id);
    const path = validateRuntimePath(slot.runtime_path);
    if (ids.has(slot.visual_id)) throw new Error("槽位 visual_id 重复：" + slot.visual_id);
    if (paths.has(path)) throw new Error("槽位路径重复：" + path);
    ids.add(slot.visual_id);
    paths.add(path);
  }
}

function clearPreviewUrls() {
  for (const url of state.previewUrls.values()) URL.revokeObjectURL(url);
  state.previewUrls.clear();
}

async function imageDimensions(file) {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function sha256(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validatePng(file) {
  if (!file.name.toLowerCase().endsWith(".png")) throw new Error("只接受 .png 文件。");
  const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const expected = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.length !== 8 || expected.some((byte, index) => signature[index] !== byte)) {
    throw new Error("文件内容不是有效的 PNG。");
  }
  const dimensions = await imageDimensions(file);
  if (!dimensions.width || !dimensions.height) throw new Error("无法读取 PNG 尺寸。");
  return dimensions;
}

async function buildItems() {
  clearPreviewUrls();
  const assets = new Map(state.manifest.assets.map((asset) => [asset.visual_id, asset]));
  const slotIds = new Set(state.slotDocument.slots.map((slot) => slot.visual_id));
  const items = state.slotDocument.slots.map((slot) => ({
    ...slot,
    runtime_path: normalizePath(slot.runtime_path),
    asset: assets.get(slot.visual_id) || null,
    exists: false,
    dimensions: null
  }));

  for (const asset of state.manifest.assets) {
    if (slotIds.has(asset.visual_id)) continue;
    items.push({
      visual_id: asset.visual_id,
      label: asset.visual_id,
      category: "清单外",
      runtime_path: normalizePath(asset.path),
      required: false,
      notes: "该资源已登记，但尚未加入资源槽位清单。",
      asset,
      exists: false,
      dimensions: null
    });
  }

  await Promise.all(items.map(async (item) => {
    if (!item.asset || !item.asset.path.toLowerCase().endsWith(".png")) return;
    const file = await tryReadFile(state.root, item.asset.path);
    if (!file) return;
    item.exists = true;
    try {
      item.dimensions = await imageDimensions(file);
      state.previewUrls.set(item.visual_id, URL.createObjectURL(file));
    } catch {
      item.dimensions = null;
    }
  }));

  state.items = items;
}

function itemStatus(item) {
  if (state.queued.has(item.visual_id)) return "queued";
  return item.exists ? "ready" : "missing";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderCard(item) {
  const status = itemStatus(item);
  const statusLabel = status === "queued" ? "待保存" : status === "ready" ? "已有" : "缺位";
  const url = state.previewUrls.get(item.visual_id);
  const queued = state.queued.get(item.visual_id);
  const dimensions = queued?.dimensions || item.dimensions;
  const preview = url
    ? '<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(item.label) + '">'
    : '<div class="missing-mark"><span>＋</span>选择 PNG</div>';

  const card = document.createElement("article");
  card.className = "asset-card";
  card.dataset.status = status;
  card.innerHTML =
    '<button class="preview" type="button" aria-label="提交或更换 ' + escapeHtml(item.label) + '">' +
      preview +
      '<span class="badge ' + status + '">' + statusLabel + '</span>' +
    '</button>' +
    '<div class="card-body">' +
      '<div class="card-topline"><span class="category">' + escapeHtml(item.category) + '</span>' +
        (item.required ? '<span class="required">DEMO 必需</span>' : '<span></span>') +
      '</div>' +
      '<h3>' + escapeHtml(item.label) + '</h3>' +
      '<div class="visual-id">' + escapeHtml(item.visual_id) + '</div>' +
      '<div class="path">' + escapeHtml(item.runtime_path) + '</div>' +
      (dimensions ? '<div class="dimensions">' + dimensions.width + ' × ' + dimensions.height + ' px</div>' : '') +
      '<p class="notes">' + escapeHtml(item.notes || "暂无说明。") + '</p>' +
      '<div class="replace-hint">点击预览区或将 PNG 拖到这里</div>' +
    '</div>';

  card.querySelector(".preview").addEventListener("click", () => choosePng(item.visual_id));
  card.addEventListener("dragover", (event) => {
    event.preventDefault();
    card.classList.add("dragging");
  });
  card.addEventListener("dragleave", () => card.classList.remove("dragging"));
  card.addEventListener("drop", async (event) => {
    event.preventDefault();
    card.classList.remove("dragging");
    const file = event.dataTransfer.files[0];
    if (file) await queuePng(item.visual_id, file);
  });
  return card;
}

function updateSummary() {
  const required = state.items.filter((item) => item.required);
  const ready = state.items.filter((item) => item.exists || state.queued.has(item.visual_id));
  const missing = required.filter((item) => !item.exists && !state.queued.has(item.visual_id));
  const pendingChanges = state.queued.size + (state.slotsDirty ? 1 : 0);

  elements.requiredCount.textContent = String(required.length);
  elements.readyCount.textContent = String(ready.length);
  elements.missingCount.textContent = String(missing.length);
  elements.queuedCount.textContent = String(state.queued.size);
  elements.saveButton.disabled = pendingChanges === 0;
  elements.saveButton.textContent = pendingChanges ? "保存更改 · " + pendingChanges : "保存更改";
}

function render() {
  if (!state.root) return;
  elements.assetGrid.replaceChildren();
  const visibleItems = state.items.filter((item) => state.filter === "all" || itemStatus(item) === state.filter);
  for (const item of visibleItems) elements.assetGrid.append(renderCard(item));

  if (!visibleItems.length) {
    const message = document.createElement("div");
    message.className = "empty-state";
    message.innerHTML = "<h2>当前筛选下没有资源</h2><p>切换筛选条件继续查看。</p>";
    elements.assetGrid.append(message);
  }
  updateSummary();
}

async function reloadRepositoryData() {
  state.manifest = await readJson(state.root, "asset-manifest.json");
  state.slotDocument = await readJson(state.root, "asset-slots.json");
  validateRepository(state.manifest, state.slotDocument);
  await buildItems();
  render();
}

async function connectRepository() {
  try {
    const root = await window.showDirectoryPicker({ mode: "readwrite", id: "paititi-art" });
    if (!(await ensureWritePermission(root))) throw new Error("没有获得仓库写入权限。");
    state.root = root;
    state.queued.clear();
    state.slotsDirty = false;
    await reloadRepositoryData();

    elements.connectionState.textContent = "已连接 · " + root.name;
    elements.connectionState.classList.add("connected");
    elements.connectButton.textContent = "切换仓库";
    elements.newSlotButton.disabled = false;
    elements.emptyState.hidden = true;
    elements.assetGrid.hidden = false;
    elements.gitPanel.hidden = true;
    showToast("已读取美术资源清单。");
  } catch (error) {
    if (error.name === "AbortError") return;
    state.root = null;
    showToast(error.message || "无法读取所选仓库。", true);
  }
}

function choosePng(visualId) {
  state.activeVisualId = visualId;
  elements.pngPicker.value = "";
  elements.pngPicker.click();
}

async function queuePng(visualId, file) {
  try {
    const item = state.items.find((candidate) => candidate.visual_id === visualId);
    if (!item) throw new Error("找不到目标资源槽位。");
    validateRuntimePath(item.runtime_path);
    const dimensions = await validatePng(file);
    const hash = await sha256(file);

    const oldUrl = state.previewUrls.get(visualId);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    const url = URL.createObjectURL(file);
    state.previewUrls.set(visualId, url);
    state.queued.set(visualId, { file, dimensions, sha256: hash });
    elements.gitPanel.hidden = true;
    render();
    showToast(item.label + " 已加入待保存队列。");
  } catch (error) {
    showToast(error.message || "PNG 无法读取。", true);
  }
}

async function saveChanges() {
  if (!state.root) return;
  const pending = Array.from(state.queued.entries());
  if (!pending.length && !state.slotsDirty) return;
  elements.saveButton.disabled = true;
  elements.saveButton.textContent = "正在保存…";

  try {
    if (!(await ensureWritePermission(state.root))) throw new Error("本地仓库写入权限已被撤销。");
    const assetMap = new Map(state.manifest.assets.map((asset) => [asset.visual_id, { ...asset }]));

    for (const [visualId, queued] of pending) {
      const item = state.items.find((candidate) => candidate.visual_id === visualId);
      if (!item) throw new Error("保存时找不到槽位：" + visualId);
      await writeFile(state.root, item.runtime_path, queued.file);
      assetMap.set(visualId, {
        visual_id: visualId,
        path: item.runtime_path,
        sha256: queued.sha256
      });
    }

    state.manifest.assets = Array.from(assetMap.values()).sort((a, b) => a.visual_id.localeCompare(b.visual_id));
    if (state.slotsDirty) await writeJson(state.root, "asset-slots.json", state.slotDocument);
    await writeJson(state.root, "asset-manifest.json", state.manifest);

    const savedCount = pending.length;
    state.queued.clear();
    state.slotsDirty = false;
    await reloadRepositoryData();
    elements.gitPanel.hidden = false;
    showToast("已保存 " + savedCount + " 个 PNG，并更新资源清单。");
  } catch (error) {
    showToast(error.message || "保存失败。", true);
    updateSummary();
  }
}

function openSlotDialog() {
  elements.slotForm.reset();
  elements.formError.textContent = "";
  elements.slotDialog.showModal();
  elements.slotForm.elements.visual_id.focus();
}

function closeSlotDialog() {
  elements.slotDialog.close();
}

function addSlot(event) {
  event.preventDefault();
  elements.formError.textContent = "";
  const data = new FormData(elements.slotForm);
  try {
    const visualId = String(data.get("visual_id") || "").trim();
    const label = String(data.get("label") || "").trim();
    const category = String(data.get("category") || "").trim();
    const runtimePath = validateRuntimePath(String(data.get("runtime_path") || "").trim());
    const notes = String(data.get("notes") || "").trim();
    if (!/^[a-z0-9_]+$/.test(visualId)) throw new Error("视觉 ID 只能使用小写字母、数字和下划线。");
    if (!label || !category) throw new Error("名称和分类不能为空。");
    if (state.items.some((item) => item.visual_id === visualId)) throw new Error("该视觉 ID 已存在。");
    if (state.items.some((item) => normalizePath(item.runtime_path) === runtimePath)) throw new Error("该运行时路径已被使用。");

    const slot = {
      visual_id: visualId,
      label,
      category,
      runtime_path: runtimePath,
      required: data.get("required") === "on"
    };
    if (notes) slot.notes = notes;
    state.slotDocument.slots.push(slot);
    state.items.push({ ...slot, asset: null, exists: false, dimensions: null });
    state.slotsDirty = true;
    elements.gitPanel.hidden = true;
    closeSlotDialog();
    render();
    showToast(label + " 已加入槽位清单，保存后写入仓库。");
  } catch (error) {
    elements.formError.textContent = error.message;
  }
}

async function copyGitCommands() {
  try {
    await navigator.clipboard.writeText(elements.gitCommands.textContent);
    showToast("Git 命令已复制。");
  } catch {
    showToast("无法访问剪贴板，请手动复制命令。", true);
  }
}

elements.connectButton.addEventListener("click", connectRepository);
elements.newSlotButton.addEventListener("click", openSlotDialog);
elements.saveButton.addEventListener("click", saveChanges);
elements.copyGitButton.addEventListener("click", copyGitCommands);
elements.cancelSlotButton.addEventListener("click", closeSlotDialog);
elements.closeSlotButton.addEventListener("click", closeSlotDialog);
elements.slotForm.addEventListener("submit", addSlot);
elements.pngPicker.addEventListener("change", async () => {
  const file = elements.pngPicker.files[0];
  if (file && state.activeVisualId) await queuePng(state.activeVisualId, file);
});

for (const filter of document.querySelectorAll(".filter")) {
  filter.addEventListener("click", () => {
    state.filter = filter.dataset.filter;
    document.querySelectorAll(".filter").forEach((button) => button.classList.toggle("active", button === filter));
    render();
  });
}

window.addEventListener("beforeunload", (event) => {
  if (!state.queued.size && !state.slotsDirty) return;
  event.preventDefault();
  event.returnValue = "";
});
