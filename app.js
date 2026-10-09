const $ = id => document.getElementById(id);

// 診断モードを不要になったら false にするだけで非表示にできます。
const ENABLE_DIAGNOSTIC = true;

const fileInput = $("fileInput");
const targetText = $("targetText");
const targetHistory = $("targetHistory");
const redactionMode = $("redactionMode");
const redactionColor = $("redactionColor");
const stampMode = $("stampMode");
const stampModeWrap = $("stampModeWrap");
const manualDrawMode = $("manualDrawMode");
const redactBtn = $("redactBtn");
const diagnoseBtn = $("diagnoseBtn");
const manualBtn = $("manualBtn");
const undoBtn = $("undoBtn");
const resetBtn = $("resetBtn");
const manualDoneBtn = $("manualDoneBtn");
const saveBtn = $("saveBtn");
const manualHelpBtn = $("manualHelpBtn");
const manualHelpDialog = $("manualHelpDialog");
const manualHelpCloseBtn = $("manualHelpCloseBtn");
const statusEl = $("status");
const errorEl = $("errorDetails");
const canvasWrap = $("canvasWrap");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const selection = $("selection");
const manualDeleteBtn = $("manualDeleteBtn");
const ocrDebugLayer = $("ocrDebugLayer");
const ocrDiagnostics = $("ocrDiagnostics");
const zoomOutBtn = $("zoomOutBtn");
const zoomInBtn = $("zoomInBtn");
const zoomLabel = $("zoomLabel");

// 手動描画の初期モードは「なぞり式」。
if (manualDrawMode) manualDrawMode.value = "trace";

if (!ENABLE_DIAGNOSTIC) {
    diagnoseBtn.hidden = true;
    ocrDiagnostics.hidden = true;
    ocrDebugLayer.hidden = true;
}

let sourceImage = null;
let worker = null;
let workerLang = null;
let fileName = "redacted.png";
let manualMode = false;
let stampTapStart = null;
let isDragging = false;
let dragStart = null;
let ocrBaseCanvas = null;
const manualStamps = [];
const manualHistory = [];
let selectedManualIndex = -1;
let editMode = null; // { type: "move" | "resize", handle: string|null, startPoint, original }
const MIN_MANUAL_SIZE = 4;

let zoom = 1;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const pointers = new Map();
let pinchStartDistance = 0;
let pinchStartZoom = 1;
let panLastCenter = null;
// 新規手動描画の指オフセットは「画面上のCSS px」で管理する。
 // ズーム倍率が変わっても、指から見た描画位置の距離を一定にする。
const TOUCH_Y_OFFSET_SCREEN_PX = -40;
const MANUAL_HIT_RADIUS_PX = 30; // 画面表示上の当たり判定。新規描画より既存編集を優先。
const TRACE_DISPLAY_HEIGHT_PX = 32; // なぞり式の基準高さ（100%表示時のCSS px）
const SETTINGS_STORAGE_KEY = "zetaSS.settings.v87";
const TARGET_HISTORY_STORAGE_KEY = "zetaSS.targetHistory.v87";
const MAX_TARGET_HISTORY = 5;

let sourceCanvasRef = null;
let sourceCtxRef = null;

function status(message, error = null) {
    statusEl.textContent = message;
    errorEl.hidden = !error;
    errorEl.textContent = error ? [
        `message: ${error.message || error}`,
        `name: ${error.name || ""}`,
        "",
        error.stack || error
    ].join("\n") : "";
}

function safeLoadJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function safeSaveJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // private mode等では保存できないことがあるが、アプリ動作は継続する。
    }
}

function cloneRedactionStyle(style = null) {
    return {
        mode: style?.mode || "black",
        color: style?.color || (redactionColor?.value || "#1a1a1a")
    };
}

function getCurrentRedactionStyle() {
    return cloneRedactionStyle({
        mode: redactionMode?.value || "black",
        color: redactionColor?.value || "#1a1a1a"
    });
}

function getStampRedactionStyle(stamp) {
    return cloneRedactionStyle(stamp?.style);
}

function updateRedactionStyleUI() {
    if (!redactionColor || !redactionMode) return;
    const showColor = redactionMode.value === "color";
    // カラーピッカーの場所は常に確保して、表示/非表示でUIが動かないようにする。
    redactionColor.classList.toggle("is-placeholder", !showColor);
    redactionColor.disabled = !showColor;
}

function savePreferences() {
    safeSaveJson(SETTINGS_STORAGE_KEY, {
        manualDrawMode: manualDrawMode?.value || "trace",
        redactionMode: redactionMode?.value || "black",
        redactionColor: redactionColor?.value || "#1a1a1a"
    });
}

function loadPreferences() {
    const saved = safeLoadJson(SETTINGS_STORAGE_KEY, {});
    if (typeof saved.manualDrawMode === "string" && manualDrawMode) manualDrawMode.value = saved.manualDrawMode;
    if (typeof saved.redactionMode === "string" && redactionMode) redactionMode.value = saved.redactionMode;
    if (typeof saved.redactionColor === "string" && redactionColor) redactionColor.value = saved.redactionColor;
    updateRedactionStyleUI();
}

function getTargetHistoryList() {
    const list = safeLoadJson(TARGET_HISTORY_STORAGE_KEY, []);
    return Array.isArray(list) ? list.filter(v => typeof v === "string" && v.trim()) : [];
}

function saveTargetHistoryEntry(text) {
    const value = (text || "").trim();
    if (!value) return;
    const list = getTargetHistoryList().filter(v => v !== value);
    list.unshift(value);
    safeSaveJson(TARGET_HISTORY_STORAGE_KEY, list.slice(0, MAX_TARGET_HISTORY));
    renderTargetHistory();
}

function renderTargetHistory() {
    if (!targetHistory) return;
    const list = getTargetHistoryList();
    targetHistory.innerHTML = "";
    targetHistory.hidden = !list.length;
    if (!list.length) return;

    const label = document.createElement("span");
    label.className = "target-history-label";
    label.textContent = "履歴";
    targetHistory.appendChild(label);

    for (const item of list) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "target-history-chip";
        btn.textContent = item;
        btn.addEventListener("click", () => {
            targetText.value = item;
            targetText.focus();
        });
        targetHistory.appendChild(btn);
    }
}

function buildSourceCanvas() {
    if (!sourceImage) {
        sourceCanvasRef = null;
        sourceCtxRef = null;
        return;
    }
    sourceCanvasRef = document.createElement("canvas");
    sourceCanvasRef.width = sourceImage.naturalWidth;
    sourceCanvasRef.height = sourceImage.naturalHeight;
    sourceCtxRef = sourceCanvasRef.getContext("2d", { willReadFrequently: true });
    sourceCtxRef.drawImage(sourceImage, 0, 0);
}

function sampleBackgroundColor(rect) {
    if (!sourceCtxRef || !sourceCanvasRef) return "#ffffff";
    const ring = 6;
    const x0 = Math.max(0, Math.floor(rect.x - ring));
    const y0 = Math.max(0, Math.floor(rect.y - ring));
    const x1 = Math.min(sourceCanvasRef.width, Math.ceil(rect.x + rect.w + ring));
    const y1 = Math.min(sourceCanvasRef.height, Math.ceil(rect.y + rect.h + ring));
    const sw = Math.max(1, x1 - x0);
    const sh = Math.max(1, y1 - y0);
    const data = sourceCtxRef.getImageData(x0, y0, sw, sh).data;
    const innerX0 = rect.x - x0;
    const innerY0 = rect.y - y0;
    const innerX1 = innerX0 + rect.w;
    const innerY1 = innerY0 + rect.h;
    let r = 0, g = 0, b = 0, count = 0;
    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            const inside = x >= innerX0 && x < innerX1 && y >= innerY0 && y < innerY1;
            if (inside) continue;
            const i = (y * sw + x) * 4;
            const a = data[i + 3];
            if (a < 8) continue;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
        }
    }
    if (!count) return "#ffffff";
    return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
}

function renderRedactionRect(rect, style = null) {
    const applied = cloneRedactionStyle(style);
    if (applied.mode === "blur") {
        // SafariではCanvasRenderingContext2D.filterのblurが効かない/弱いことがあるため、
        // 対象範囲を一度縮小してから滑らかに拡大する方式で確実にぼかす。
        const blurMargin = 8;
        const sx = Math.max(0, Math.floor(rect.x - blurMargin));
        const sy = Math.max(0, Math.floor(rect.y - blurMargin));
        const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil(rect.w + blurMargin * 2)));
        const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil(rect.h + blurMargin * 2)));

        const source = document.createElement("canvas");
        source.width = sw;
        source.height = sh;
        const sctx = source.getContext("2d");
        sctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

        // およそ1/6まで縮小。文字が読めない程度にしつつ、モザイクより柔らかい見た目にする。
        const small = document.createElement("canvas");
        small.width = Math.max(1, Math.round(sw / 6));
        small.height = Math.max(1, Math.round(sh / 6));
        const smctx = small.getContext("2d");
        smctx.imageSmoothingEnabled = true;
        smctx.imageSmoothingQuality = "high";
        smctx.drawImage(source, 0, 0, sw, sh, 0, 0, small.width, small.height);

        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(small, 0, 0, small.width, small.height, sx, sy, sw, sh);
        ctx.restore();
    } else {
        ctx.save();
        if (applied.mode === "bg") ctx.fillStyle = sampleBackgroundColor(rect);
        else if (applied.mode === "color") ctx.fillStyle = applied.color || "#1a1a1a";
        else ctx.fillStyle = "#000";
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
    }
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした。")); };
        image.src = url;
    });
}

function normalize(text) {
    return String(text || "")
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu, "")
        .toLowerCase();
}

// OCRの最終矩形は、対象文字のsymbol bboxをまとめて一度だけ作る。
// 位置の推定や多段補正はここでは行わず、怪しいsymbol列はextractLineUnits側で
// word bboxの均等分割へフォールバックしてから渡す。
function getOcrPaintBox(box, symbols = []) {
    const entries = (symbols || [])
        .map(s => ({ symbol:s, bbox:s?.bbox }))
        .filter(e =>
            e.bbox &&
            Number.isFinite(e.bbox.x0) && Number.isFinite(e.bbox.x1) &&
            Number.isFinite(e.bbox.y0) && Number.isFinite(e.bbox.y1) &&
            e.bbox.x1 > e.bbox.x0 && e.bbox.y1 > e.bbox.y0
        );

    if (!entries.length) return { ...box };

    const valid = entries.map(e => e.bbox);
    const x0 = Math.min(...valid.map(b => b.x0));
    const y0 = Math.min(...valid.map(b => b.y0));
    const x1 = Math.max(...valid.map(b => b.x1));
    const y1 = Math.max(...valid.map(b => b.y1));
    let out = {
        ...box,
        x: x0,
        y: y0,
        w: Math.max(1, x1 - x0),
        h: Math.max(1, y1 - y0)
    };

    // 1〜3文字の日本語名で、symbol異常によりword均等分割へ落ちた場合だけ、
    // word bbox自体が後続文字まで巻き込んでいないかを文字高さ×文字数で軽く確認する。
    // 左端は絶対に削らず、過大な場合は右端だけ縮める。追加OCRは行わない。
    const chars = entries.map(e => e.symbol?.ch).filter(Boolean);
    const isShortJapaneseName = chars.length >= 1 && chars.length <= 3 &&
        chars.every(ch => /[ぁ-ゖァ-ヺ一-龯々〆ヵヶ]/u.test(ch));
    const usedWordSplit = entries.some(e => e.symbol?.bboxSource === 'word-split');
    if (isShortJapaneseName && usedWordSplit) {
        const maxWidth = out.h * chars.length * 1.18;
        if (out.w > maxWidth) {
            out = {
                ...out,
                w: Math.max(1, maxWidth),
                shortNameWidthGuard: true,
                originalWidth: x1 - x0
            };
        }
    }

    return out;
}

function getMedian(values) {
    const a = (values || []).filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function getOcrVisualRect(box, symbols = [], meta = {}) {
    let paintBox = getOcrPaintBox(box, symbols);
    const chars = (symbols || []).map(s => s?.ch).filter(Boolean);
    const isShortJapaneseName = chars.length >= 1 && chars.length <= 3 &&
        chars.every(ch => /[ぁ-ゖァ-ヺ一-龯々〆ヵヶ]/u.test(ch));
    const source = String(meta?.source || '');

    // V91: 局所OCRの短名は、まれにsymbol bboxが行高いっぱいまで伸びて
    // 縦長の黒い塊になることがある。文字幅を「1文字サイズ」の基準にして、
    // 高さだけが異常に大きい時は中心を維持したまま整形する。
    if (isShortJapaneseName && source === '局所OCR') {
        const validSymbols = (symbols || []).filter(s =>
            s?.bbox && Number.isFinite(s.bbox.x0) && Number.isFinite(s.bbox.x1) &&
            Number.isFinite(s.bbox.y0) && Number.isFinite(s.bbox.y1) &&
            s.bbox.x1 > s.bbox.x0 && s.bbox.y1 > s.bbox.y0
        );
        if (validSymbols.length) {
            const medianW = getMedian(validSymbols.map(s => s.bbox.x1 - s.bbox.x0));
            if (medianW > 0) {
                const maxH = medianW * 1.20;
                if (paintBox.h > maxH) {
                    const cy = paintBox.y + paintBox.h / 2;
                    paintBox = {
                        ...paintBox,
                        y: cy - maxH / 2,
                        h: maxH,
                        localShapeGuard: true
                    };
                }

                // 右側の「ちゃん / さん / くん」等を巻き込みすぎないよう、
                // 1〜3文字名の横幅にも軽い上限を設ける。左端は動かさない。
                const maxW = medianW * chars.length * 1.22;
                if (paintBox.w > maxW) {
                    paintBox = {
                        ...paintBox,
                        w: Math.max(1, maxW),
                        localWidthGuard: true
                    };
                }
            }
        }
    }

    // V91.1: 1〜3文字の日本語名は、OCR bboxが1文字分だけになったり、
    // 逆に後続文字まで巻き込んだりすることがある。文字高さ×文字数を基準に、
    // 明らかに細すぎる/広すぎる横幅だけを正常化する。
    // 細すぎる場合は不足分を左70%・右30%へ配分して、先頭文字の露出を優先して防ぐ。
    // 広すぎる場合は左端を維持したまま右端だけ縮める。
    if (isShortJapaneseName && paintBox.h > 0) {
        const expectedW = paintBox.h * chars.length * 1.02;
        const minReasonableW = expectedW * 0.78;
        const maxReasonableW = expectedW * 1.30;
        if (paintBox.w < minReasonableW) {
            const extra = Math.max(0, expectedW - paintBox.w);
            paintBox = {
                ...paintBox,
                x: Math.max(0, paintBox.x - extra * 0.70),
                w: expectedW,
                shortNameWidthNormalized: 'expand-left'
            };
        } else if (paintBox.w > maxReasonableW) {
            paintBox = {
                ...paintBox,
                w: expectedW,
                shortNameWidthNormalized: 'shrink-right'
            };
        }
    }

    const verticalPadding = Math.max(2, Math.round(paintBox.h * 0.08));
    const leftPadding = isShortJapaneseName
        ? Math.max(4, Math.round(paintBox.h * 0.16))
        : Math.max(2, Math.round(paintBox.h * 0.08));

    // 短名は右側に敬称・「ちゃん」等が続くことが多いので、
    // 正常symbolでは右余白を足さない。word分割だけ1px残して安全側にする。
    const usedWordSplit = (symbols || []).some(s => s?.bboxSource === 'word-split');
    const rightPadding = isShortJapaneseName
        ? (usedWordSplit ? 1 : 0)
        : Math.max(2, Math.round(paintBox.h * 0.08));

    const left = Math.max(0, Math.round(paintBox.x - leftPadding));
    const top = Math.max(0, Math.round(paintBox.y - verticalPadding));
    const right = Math.min(canvas.width, Math.round(paintBox.x + paintBox.w + rightPadding));
    const bottom = Math.min(canvas.height, Math.round(paintBox.y + paintBox.h + verticalPadding));

    return {
        x: left,
        y: top,
        w: Math.max(1, right - left),
        h: Math.max(1, bottom - top),
        localShapeGuard: !!paintBox.localShapeGuard,
        localWidthGuard: !!paintBox.localWidthGuard,
        shortNameWidthNormalized: paintBox.shortNameWidthNormalized || ""
    };
}

function paintManual(box, style = null) {
    const padding = Math.max(4, Math.round(Math.min(box.w, box.h) * 0.12));
    const verticalPadding = padding + 2;
    const left = Math.max(0, box.x - padding - 6);
    const top = Math.max(0, box.y - verticalPadding);
    const width = box.w + padding;
    const height = box.h + verticalPadding * 2;
    renderRedactionRect({ x: left, y: top, w: width, h: height }, style);
}

function paintStamp(stamp) {
    const style = getStampRedactionStyle(stamp);
    if (stamp.kind === "ocr") {
        renderRedactionRect({ x: stamp.x, y: stamp.y, w: stamp.w, h: stamp.h }, style);
        return;
    }
    paintManual(stamp, style);
}

function getBaseDisplaySize() {
    if (!sourceImage) return { width: canvas.width, height: canvas.height };
    const availableWidth = Math.max(1, canvasWrap.clientWidth);
    const scale = Math.min(1, availableWidth / canvas.width);
    return { width: canvas.width * scale, height: canvas.height * scale };
}

function updateZoomUI() {
    if (!sourceImage) return;
    const oldRect = canvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const centerX = (oldRect.left + oldRect.right) / 2 - wrapRect.left;
    const centerY = (oldRect.top + oldRect.bottom) / 2 - wrapRect.top;
    const base = getBaseDisplaySize();

    canvasWrap.classList.toggle("zoomed", zoom > 1.001);
    canvas.style.width = `${base.width * zoom}px`;
    canvas.style.height = `${base.height * zoom}px`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

    if (zoom > 1.001) {
        const newRect = canvas.getBoundingClientRect();
        const newWrapRect = canvasWrap.getBoundingClientRect();
        const newCenterX = (newRect.left + newRect.right) / 2 - newWrapRect.left;
        const newCenterY = (newRect.top + newRect.bottom) / 2 - newWrapRect.top;
        canvasWrap.scrollLeft += newCenterX - centerX;
        canvasWrap.scrollTop += newCenterY - centerY;
    } else {
        canvasWrap.scrollLeft = 0;
        canvasWrap.scrollTop = 0;
    }
}

function setZoom(nextZoom) {
    if (!sourceImage) return;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    updateZoomUI();
}

function getPointerDistance() {
    const values = [...pointers.values()];
    if (values.length < 2) return 0;
    return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
}

function getLastManualStamp() {
    for (let i = manualStamps.length - 1; i >= 0; i--) {
        if (manualStamps[i].kind !== "ocr") return manualStamps[i];
    }
    return null;
}

function updateStampModeUI() {
    const lastManual = getLastManualStamp();
    if (stampModeWrap) stampModeWrap.hidden = !manualMode;
    if (stampMode) stampMode.disabled = !manualMode || !lastManual;
    if ((!manualMode || !lastManual) && stampMode) stampMode.checked = false;
}

function updateUndoButton() {
    undoBtn.disabled = manualHistory.length === 0;
    updateStampModeUI();
}

function snapshotManualStamps() {
    return manualStamps.map(stamp => ({ ...stamp }));
}

function pushManualHistory() {
    manualHistory.push(snapshotManualStamps());
    if (manualHistory.length > 50) manualHistory.shift();
}

function restoreManualSnapshot(snapshot) {
    manualStamps.length = 0;
    for (const stamp of snapshot) manualStamps.push({ ...stamp });
    selectedManualIndex = -1;
    editMode = null;
    selection.hidden = true;
    redrawFromBase();
}

function hideManualDeleteButton() {
    if (!manualDeleteBtn) return;
    manualDeleteBtn.hidden = true;
    manualDeleteBtn.style.left = "";
    manualDeleteBtn.style.top = "";
}

function renderManualSelection() {
    if (selectedManualIndex < 0 || !manualStamps[selectedManualIndex]) {
        selection.hidden = true;
        selection.innerHTML = "";
        hideManualDeleteButton();
        return;
    }
    const stamp = manualStamps[selectedManualIndex];
    const transform = getCanvasDisplayTransform();
    selection.hidden = false;
    selection.style.left = `${transform.left + stamp.x * transform.scaleX}px`;
    selection.style.top = `${transform.top + stamp.y * transform.scaleY}px`;
    selection.style.width = `${stamp.w * transform.scaleX}px`;
    selection.style.height = `${stamp.h * transform.scaleY}px`;
    selection.innerHTML = "";

    // 削除ボタンはselectionの子にせず、canvasWrap直下の独立要素として表示する。
    if (manualDeleteBtn && manualMode) {
        manualDeleteBtn.style.left = `${transform.left + stamp.x * transform.scaleX - 18}px`;
        manualDeleteBtn.style.top = `${transform.top + stamp.y * transform.scaleY - 18}px`;
        manualDeleteBtn.hidden = false;
    } else {
        hideManualDeleteButton();
    }
    for (const handle of ["nw", "ne", "sw", "se"]) {
        const el = document.createElement("span");
        el.className = `edit-handle handle-${handle}`;
        el.dataset.handle = handle;
        selection.appendChild(el);
    }

}

function getManualHitRadiusCanvas() {
    const transform = getCanvasDisplayTransform();
    const scale = Math.max(0.0001, Math.min(transform.scaleX, transform.scaleY));
    return MANUAL_HIT_RADIUS_PX / scale;
}

function getResizeHandle(point, stamp, radius = null) {
    const size = radius ?? getManualHitRadiusCanvas();
    const handles = {
        nw: [stamp.x, stamp.y],
        ne: [stamp.x + stamp.w, stamp.y],
        sw: [stamp.x, stamp.y + stamp.h],
        se: [stamp.x + stamp.w, stamp.y + stamp.h]
    };
    let best = null;
    let bestDistance = Infinity;
    for (const [name, [x, y]] of Object.entries(handles)) {
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance <= size && distance < bestDistance) {
            best = name;
            bestDistance = distance;
        }
    }
    return best;
}

// 編集対象は「四隅ハンドル → 矩形本体 → 新規描画」の順に判定する。
// 画面上およそ30pxまで当たり判定を広げ、指のオフセットとは切り離して生タッチ座標で判定する。
function findManualEditTarget(point) {
    const radius = getManualHitRadiusCanvas();

    // まず全矩形のハンドルを優先。近いハンドルがあれば必ずリサイズ扱い。
    let bestHandle = null;
    for (let i = manualStamps.length - 1; i >= 0; i--) {
        const stamp = manualStamps[i];
        const handle = getResizeHandle(point, stamp, radius);
        if (!handle) continue;
        const hx = handle.includes("e") ? stamp.x + stamp.w : stamp.x;
        const hy = handle.includes("s") ? stamp.y + stamp.h : stamp.y;
        const distance = Math.hypot(point.x - hx, point.y - hy);
        if (!bestHandle || distance < bestHandle.distance) {
            bestHandle = { index: i, handle, distance };
        }
    }
    if (bestHandle) return { index: bestHandle.index, type: "resize", handle: bestHandle.handle };

    // 次に矩形本体。実矩形の外側にもradiusぶん余裕を持たせる。
    for (let i = manualStamps.length - 1; i >= 0; i--) {
        const b = manualStamps[i];
        if (point.x >= b.x - radius && point.x <= b.x + b.w + radius &&
            point.y >= b.y - radius && point.y <= b.y + b.h + radius) {
            return { index: i, type: "move", handle: null };
        }
    }
    return null;
}

function hitTestManual(point) {
    return findManualEditTarget(point)?.index ?? -1;
}

function applyMoveEdit(current) {
    const b = manualStamps[selectedManualIndex];
    const dx = current.x - editMode.startPoint.x;
    const dy = current.y - editMode.startPoint.y;
    b.x = Math.max(0, Math.min(canvas.width - b.w, editMode.original.x + dx));
    b.y = Math.max(0, Math.min(canvas.height - b.h, editMode.original.y + dy));
}

function applyResizeEdit(current) {
    const b = manualStamps[selectedManualIndex];
    const o = editMode.original;
    let x = o.x, y = o.y, w = o.w, h = o.h;
    const dx = current.x - editMode.startPoint.x;
    const dy = current.y - editMode.startPoint.y;
    const handle = editMode.handle;
    if (handle.includes("e")) w = o.w + dx;
    if (handle.includes("s")) h = o.h + dy;
    if (handle.includes("w")) { x = o.x + dx; w = o.w - dx; }
    if (handle.includes("n")) { y = o.y + dy; h = o.h - dy; }
    if (w < MIN_MANUAL_SIZE) { if (handle.includes("w")) x = o.x + o.w - MIN_MANUAL_SIZE; w = MIN_MANUAL_SIZE; }
    if (h < MIN_MANUAL_SIZE) { if (handle.includes("n")) y = o.y + o.h - MIN_MANUAL_SIZE; h = MIN_MANUAL_SIZE; }
    x = Math.max(0, Math.min(canvas.width - w, x));
    y = Math.max(0, Math.min(canvas.height - h, y));
    b.x = x; b.y = y; b.w = w; b.h = h;
}

function redrawFromBase() {
    if (!sourceImage) return;

    // 編集中は OCR 済み/未実行に関係なく、現在のズーム率とスクロール位置を維持する。
    const keepZoom = zoom;
    const keepScrollLeft = canvasWrap.scrollLeft;
    const keepScrollTop = canvasWrap.scrollTop;

    if (ocrBaseCanvas) {
        canvas.width = ocrBaseCanvas.width;
        canvas.height = ocrBaseCanvas.height;
        ctx.drawImage(ocrBaseCanvas, 0, 0);
    } else {
        canvas.width = sourceImage.naturalWidth;
        canvas.height = sourceImage.naturalHeight;
        ctx.drawImage(sourceImage, 0, 0);
    }

    for (const stamp of manualStamps) {
        paintStamp(stamp);
    }
    updateUndoButton();

    // canvas.width/height の書き換えで CSS サイズやスクロール位置がリセットされるため、
    // 毎回 keepZoom を戻し、次フレームでスクロールも復元する。
    zoom = keepZoom;
    const base = getBaseDisplaySize();
    if (keepZoom > 1.001) {
        canvasWrap.classList.add("zoomed");
        canvas.style.width = `${base.width * keepZoom}px`;
        canvas.style.height = `${base.height * keepZoom}px`;
    } else {
        canvasWrap.classList.remove("zoomed");
        canvas.style.width = `${base.width}px`;
        canvas.style.height = `${base.height}px`;
    }
    zoomLabel.textContent = `${Math.round(keepZoom * 100)}%`;

    requestAnimationFrame(() => {
        canvasWrap.scrollLeft = keepScrollLeft;
        canvasWrap.scrollTop = keepScrollTop;
        renderManualSelection();
    });
}

async function getWorker(preferredLang = "jpn") {
    if (!window.Tesseract) {
        throw new Error("Tesseract.jsを読み込めませんでした。インターネット接続や外部スクリプト制限を確認してください。");
    }

    if (worker && workerLang === preferredLang) return worker;

    if (worker) {
        await worker.terminate();
        worker = null;
        workerLang = null;
    }

    status(`${preferredLang === "jpn" ? "日本語" : "英語"}OCRエンジンを準備中…\n初回は少し時間がかかります。`);
    worker = await Tesseract.createWorker(preferredLang, 1, {
        logger: message => {
            if (message?.progress != null) {
                status("実行中…");
            }
        }
    });
    workerLang = preferredLang;
    return worker;
}

function getOcrLanguage(target) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(target) ? "jpn" : "eng";
}

function makeOcrVariant(baseCanvas, name) {
    if (name === "通常") return baseCanvas;

    const c = document.createElement("canvas");
    c.width = baseCanvas.width;
    c.height = baseCanvas.height;
    const g = c.getContext("2d");
    g.drawImage(baseCanvas, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    const d = img.data;

    if (name === "グレースケール") {
        for (let i = 0; i < d.length; i += 4) {
            const y = Math.round(d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114);
            d[i] = d[i + 1] = d[i + 2] = y;
        }
    } else if (name === "グレー＋コントラスト") {
        for (let i = 0; i < d.length; i += 4) {
            const y = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
            const v = Math.max(0, Math.min(255, Math.round((y - 128) * 1.65 + 128)));
            d[i] = d[i + 1] = d[i + 2] = v;
        }
    } else if (name === "二値化180" || name === "二値化220") {
        const threshold = name === "二値化180" ? 180 : 220;
        for (let i = 0; i < d.length; i += 4) {
            const y = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
            const v = y >= threshold ? 255 : 0;
            d[i] = d[i + 1] = d[i + 2] = v;
        }
    } else if (name === "色抽出") {
        for (let i = 0; i < d.length; i += 4) {
            const r=d[i],g=d[i+1],b=d[i+2];
            const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
            const sat=mx-mn;
            if(sat < 32){ d[i]=d[i+1]=d[i+2]=255; }
            else {
                const y=Math.round(r*.299+g*.587+b*.114);
                d[i]=d[i+1]=d[i+2]=y;
            }
        }
    } else if (name === "反転") {
        for (let i = 0; i < d.length; i += 4) {
            d[i] = 255 - d[i];
            d[i + 1] = 255 - d[i + 1];
            d[i + 2] = 255 - d[i + 2];
        }
    }

    g.putImageData(img, 0, 0);
    return c;
}

// Tesseractは稀に、単語内の1文字だけbboxの位置を誤検出することがある
// （例：「ネ」の実際の描画位置より1文字分右にずれた座標を報告する等）。
// そのまま使うと黒塗り位置そのものがズレてしまい、paddingを足しても直せない。
// なので「単語内のsymbolが順番通りに並び、単語全体のbboxの端まできちんと
// 埋まっているか」を確認し、怪しい場合だけ単語bboxの均等分割にフォールバックする。
function symbolsLookValid(word, syms) {
    const wb = word?.bbox;
    if (!wb || !syms.length) return false;

    let prevX1 = wb.x0 - 1;
    for (const s of syms) {
        const b=s?.bbox;
        if (!b || b.x1<=b.x0 || b.y1<=b.y0) return false;
        if (b.x0 < prevX1 - 2) return false;
        prevX1 = b.x1;
    }

    const first = syms[0].bbox, last = syms[syms.length - 1].bbox;
    const wordWidth = Math.max(1, wb.x1 - wb.x0);
    const leftGap = first.x0 - wb.x0;
    const rightGap = wb.x1 - last.x1;
    if (leftGap > wordWidth * 0.25 || rightGap > wordWidth * 0.25) return false;

    // 名前用途で特に重要な1〜3文字の日本語を安定させるため、
    // 日本語symbolだけ「1文字なのに異常に横長」「文字幅が1つだけ極端」を軽く検査する。
    // 異常ならここで座標を直接いじらず、呼び出し側のword bbox均等分割に任せる。
    const japanese = syms
        .map(s => ({ s, chars:[...normalize(s.text)] }))
        .filter(e => e.chars.length===1 && /[ぁ-ゖァ-ヺ一-龯々〆ヵヶ]/u.test(e.chars[0]))
        .map(e => {
            const b=e.s.bbox;
            return { w:b.x1-b.x0, h:b.y1-b.y0 };
        });

    if (japanese.length >= 2) {
        if (japanese.some(e => e.w / Math.max(1,e.h) > 1.80)) return false;

        const widths=japanese.map(e=>e.w).sort((a,b)=>a-b);
        const minW=Math.max(1,widths[0]);
        const maxW=widths[widths.length-1];
        if (japanese.length <= 3) {
            if (maxW / minW > 2.20) return false;
        } else {
            const mid=Math.floor(widths.length/2);
            const median=widths.length%2 ? widths[mid] : (widths[mid-1]+widths[mid])/2;
            if (median>0 && maxW > median*2.20) return false;
        }
    }

    return true;
}

function extractLineUnits(line){
  const units=[];
  for(const word of (line?.words||[])){
    const rawSyms=(word?.symbols||[]).filter(s=>s?.bbox);
    const kept=rawSyms.filter(s=>normalize(s.text));
    if(kept.length&&symbolsLookValid(word,kept)){
      for(let idx=0;idx<rawSyms.length;idx++){
        const s=rawSyms[idx];
        const chNorm=normalize(s.text);
        if(!chNorm) continue;
        const chars=[...chNorm];
        let ch;
        if(chars.length>1){
          // 同じ複数文字ラベルが連続symbolへ重複して付くケースでは、
          // bboxは維持したまま連続順に1文字ずつ割り当てる。
          let runStart=idx;
          while(runStart>0&&normalize(rawSyms[runStart-1].text)===chNorm)runStart--;
          const posInRun=idx-runStart;
          ch=chars[Math.min(posInRun,chars.length-1)];
        }else{
          ch=chars[0];
        }
        units.push({ch,bbox:s.bbox,raw:s.text,bboxSource:'symbol'});
      }
    }else if(word?.bbox&&normalize(word.text)){
      // symbolの順序・幅が怪しい時は、word全体を正規化後の文字数で均等分割する。
      // 追加OCRは使わないため速度への影響はほぼない。
      const chars=[...normalize(word.text)],b=word.bbox;
      chars.forEach((ch,i)=>{
        const bbox={x0:b.x0+(b.x1-b.x0)*i/chars.length,y0:b.y0,x1:b.x0+(b.x1-b.x0)*(i+1)/chars.length,y1:b.y1};
        units.push({ch,raw:word.text,bbox,bboxSource:'word-split'});
      });
    }
  }
  return units;
}

function makeTargetHit(selected, kind="exact", skipped=[]) {
  return {
    targetBox:{
      x0:Math.min(...selected.map(u=>u.bbox.x0)),
      y0:Math.min(...selected.map(u=>u.bbox.y0)),
      x1:Math.max(...selected.map(u=>u.bbox.x1)),
      y1:Math.max(...selected.map(u=>u.bbox.y1))
    },
    symbols:selected,
    kind,
    skipped
  };
}

function findTargetInUnits(units,target){
  const chars=[...target], hits=[];
  if(!chars.length) return hits;
  const text=units.map(u=>u.ch).join('');
  let from=0;
  while(from<=text.length-chars.length){
    const i=text.indexOf(target,from);
    if(i<0) break;
    const selected=units.slice(i,i+chars.length);
    if(selected.length===chars.length) hits.push(makeTargetHit(selected,'exact'));
    from=i+Math.max(1,chars.length);
  }
  return hits;
}

// 文字密度から横長のテキスト候補領域を推定する。
// OCR本体の追加局所走査と診断の両方で使用する。
function detectTextLikeRegions(sourceCanvas) {
  const ctx=sourceCanvas.getContext('2d',{willReadFrequently:true});
  const img=ctx.getImageData(0,0,sourceCanvas.width,sourceCanvas.height);
  const d=img.data, w=img.width, h=img.height;
  const sample=2;
  const sw=Math.ceil(w/sample), sh=Math.ceil(h/sample);
  const regions=[];

  // 黒文字・白文字の両方を軽く見る。スクショの吹き出しや背景を
  // 完全には判別せず、「文字候補を拾う」ことを目的にする。
  for(const mode of ['dark','light']){
    const rows=new Uint16Array(sh);
    const rowXs=Array.from({length:sh},()=>[w,h,0,0]);
    for(let sy=0;sy<sh;sy++){
      const y=Math.min(h-1,sy*sample);
      for(let sx=0;sx<sw;sx++){
        const x=Math.min(w-1,sx*sample);
        const i=(y*w+x)*4;
        const g=d[i]*.299+d[i+1]*.587+d[i+2]*.114;
        const hit=mode==='dark'?g<185:g>225;
        if(!hit) continue;
        rows[sy]++;
        const r=rowXs[sy];
        if(x<r[0])r[0]=x; if(y<r[1])r[1]=y;
        if(x>r[2])r[2]=x; if(y>r[3])r[3]=y;
      }
    }
    const minHits=Math.max(3,Math.round(sw*.0015));
    let start=-1,last=-1;
    for(let sy=0;sy<sh;sy++){
      if(rows[sy]>=minHits){
        if(start<0)start=sy;
        last=sy;
      }else if(start>=0 && sy-last>3){
        const y0=Math.max(0,start*sample-10), y1=Math.min(h,(last+1)*sample+10);
        let x0=w,x1=0,total=0;
        for(let q=start;q<=last;q++){
          if(rows[q]){
            x0=Math.min(x0,rowXs[q][0]);
            x1=Math.max(x1,rowXs[q][2]);
            total+=rows[q];
          }
        }
        if(x1>x0){
          x0=Math.max(0,x0-14); x1=Math.min(w,x1+14);
          const rw=x1-x0,rh=y1-y0;
          if(rh>=14&&rh<=110&&rw>=35&&rw<=Math.min(w,1400)){
            regions.push({x:x0,y:y0,w:rw,h:rh,mode,density:total/Math.max(1,rw*rh/(sample*sample))});
          }
        }
        start=-1; last=-1;
      }
    }
    if(start>=0){
      const y0=Math.max(0,start*sample-10), y1=Math.min(h,(last+1)*sample+10);
      let x0=w,x1=0,total=0;
      for(let q=start;q<=last;q++) if(rows[q]){x0=Math.min(x0,rowXs[q][0]);x1=Math.max(x1,rowXs[q][2]);total+=rows[q];}
      if(x1>x0){
        x0=Math.max(0,x0-14);x1=Math.min(w,x1+14);
        const rw=x1-x0,rh=y1-y0;
        if(rh>=14&&rh<=110&&rw>=35&&rw<=Math.min(w,1400)) regions.push({x:x0,y:y0,w:rw,h:rh,mode,density:total/Math.max(1,rw*rh/(sample*sample))});
      }
    }
  }

  // 重なったdark/light候補や同じ行の候補をまとめる。
  regions.sort((a,b)=>b.density-a.density);
  const dedup=[];
  for(const r of regions){
    const overlap=dedup.some(q=>{
      const ix=Math.max(0,Math.min(r.x+r.w,q.x+q.w)-Math.max(r.x,q.x));
      const iy=Math.max(0,Math.min(r.y+r.h,q.y+q.h)-Math.max(r.y,q.y));
      return ix*iy>Math.min(r.w*r.h,q.w*q.h)*.45;
    });
    if(!overlap) dedup.push(r);
    if(dedup.length>=24) break;
  }
  return {sample,regions:dedup};
}

async function recognizeLocalRegionVariant(worker, crop, target, mode) {
  const input = mode === '通常' ? crop : makeOcrVariant(crop, mode);
  let raw = '';
  let hit = false;
  const matches = [];
  const lineData = [];
  try {
    const result = await worker.recognize(input, {tessedit_pageseg_mode:'7'});
    raw = String(result?.data?.text || '').replace(/\s+/g,' ').trim();
    for (const line of (result?.data?.lines || [])) {
      const units = extractLineUnits(line);
      const found = findTargetInUnits(units, target);
      lineData.push({units, text: units.map(u => u.ch).join('')});
      if (found.length) {
        hit = true;
        matches.push(...found);
      }
    }
  } catch (e) {
    raw = `ERROR: ${e?.message || e}`;
  } finally {
    if (input !== crop) { input.width = 1; input.height = 1; }
  }
  return {mode, raw, hit, matches, lineData};
}

// V68実験：V64の「文字っぽい横長領域」の検出を維持し、
// 上位16領域だけでなく検出された全領域を通常OCRする。
// まず「未走査領域に3個目が存在するか」を確認するためのカバレッジ実験。
// 前処理追加はこの版では行わず、OCR回数を必要最小限にする。診断専用。
async function runTextRegionExperiment(worker,sourceCanvas,target,coordScale=1) {
  const detected=detectTextLikeRegions(sourceCanvas);
  const tested=[];
  const started=performance.now();
  const SCALE=2;

  // V64では上位16領域だけをOCRしていたため、検出された残りの領域に
  // 目的の文字が存在していても拾えない可能性があった。V68では全領域を
  // 通常OCRして、まず「走査範囲不足」なのかどうかを切り分ける。
  for(const r of detected.regions) {
    const crop=document.createElement('canvas');
    crop.width=Math.max(1,Math.round(r.w*SCALE));
    crop.height=Math.max(1,Math.round(r.h*SCALE));
    const cctx=crop.getContext('2d');
    cctx.imageSmoothingEnabled=true;
    cctx.imageSmoothingQuality='high';
    cctx.drawImage(sourceCanvas,r.x,r.y,r.w,r.h,0,0,crop.width,crop.height);

    const normal=await recognizeLocalRegionVariant(worker,crop,target,'通常');
    tested.push({
      ...r,
      x:r.x/coordScale,
      y:r.y/coordScale,
      w:r.w/coordScale,
      h:r.h/coordScale,
      hit:normal.hit,
      baseHit:normal.hit,
      extraHit:false,
      variants:[normal],
      raw:normal.raw
    });
    crop.width=1; crop.height=1;
  }
  return {
    detected:{sample:detected.sample,regions:detected.regions.map(r=>({...r,x:r.x/coordScale,y:r.y/coordScale,w:r.w/coordScale,h:r.h/coordScale}))},
    tested,
    elapsed:performance.now()-started,
    extraRuns:0,
    extraModes:[]
  };
}

// V70本採用用：V68と同じ文字領域検出＋全領域局所OCRを、
// 実際の自動黒塗り候補として返す。OCRのbboxは2倍拡大した局所画像上の
// 座標なので、元画像の領域座標へ戻してから既存のmergeMatchesへ渡す。
async function collectTextRegionMatches(worker, sourceCanvas, target, coordScale=1) {
  const detected = detectTextLikeRegions(sourceCanvas);
  const SCALE = 2;
  const matches = [];
  const tested = [];
  const started = performance.now();

  for (const r of detected.regions) {
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(r.w * SCALE));
    crop.height = Math.max(1, Math.round(r.h * SCALE));
    const cctx = crop.getContext('2d');
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(sourceCanvas, r.x, r.y, r.w, r.h, 0, 0, crop.width, crop.height);

    const normal = await recognizeLocalRegionVariant(worker, crop, target, '通常');
    const regionMatches = [];
    for (const hit of normal.matches || []) {
      const b = hit.targetBox;
      regionMatches.push({
        x0: (r.x + b.x0 / SCALE) / coordScale,
        y0: (r.y + b.y0 / SCALE) / coordScale,
        x1: (r.x + b.x1 / SCALE) / coordScale,
        y1: (r.y + b.y1 / SCALE) / coordScale,
        symbols: (hit.symbols || []).map(u => ({
          ...u,
          bbox: {
            x0: (r.x + u.bbox.x0 / SCALE) / coordScale,
            y0: (r.y + u.bbox.y0 / SCALE) / coordScale,
            x1: (r.x + u.bbox.x1 / SCALE) / coordScale,
            y1: (r.y + u.bbox.y1 / SCALE) / coordScale
          }
        })),
        lineText: normal.raw,
        source: '局所OCR'
      });
    }
    matches.push(...regionMatches);
    tested.push({...r, hit:normal.hit, raw:normal.raw, matches:regionMatches, lineData:normal.lineData || []});
    crop.width = 1;
    crop.height = 1;
  }

  return {detected, tested, matches, elapsed: performance.now() - started};
}

function editDistance(a,b){const A=[...a],B=[...b],d=Array.from({length:A.length+1},()=>Array(B.length+1).fill(0));for(let i=0;i<=A.length;i++)d[i][0]=i;for(let j=0;j<=B.length;j++)d[0][j]=j;for(let i=1;i<=A.length;i++)for(let j=1;j<=B.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(A[i-1]===B[j-1]?0:1));return d[A.length][B.length];}
function sequenceSimilarity(a, b) {
  const A = [...a], B = [...b];
  if (!A.length || !B.length) return 0;
  const dp = Array.from({ length: A.length + 1 }, () => Array(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      dp[i][j] = A[i - 1] === B[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[A.length][B.length] / Math.max(A.length, B.length);
}

function findNearCandidates(lines, target, limit = 60) {
  const out = [];
  const tlen = [...target].length;
  if (!tlen) return out;

  for (const line of lines) {
    const u = extractLineUnits(line);
    const t = u.map(x => x.ch).join("");
    if (!t) continue;

    // 完全一致だけでなく「一部の文字だけ別の字として読まれた」ケースも候補にする。
    // 例：ゆーざー → ポーざー / めーざー / ゆーゴー。
    const minLen = Math.max(1, tlen - 2);
    const maxLen = Math.min(t.length, tlen + 2);

    for (let i = 0; i < t.length; i++) {
      for (let len = minLen; len <= maxLen && i + len <= t.length; len++) {
        const c = t.slice(i, i + len);
        const editSim = 1 - editDistance(target, c) / Math.max(tlen, [...c].length);
        const seqSim = sequenceSimilarity(target, c);
        const exactChars = [...target].filter(ch => [...c].includes(ch)).length;

        // まず「並びが近い」ことを重視。4文字の対象なら2文字一致でも救出候補にする。
        // 本当に対象かどうかは、この後の局所再OCRで確認する。
        const score = Math.max(editSim, seqSim);
        const minShared = tlen <= 2 ? tlen : Math.max(2, Math.ceil(tlen * 0.5));
        if (score >= 0.50 && exactChars >= minShared) {
          const selected = u.slice(i, i + len);
          if (selected.length) {
            out.push({
              candidate: c,
              similarity: score,
              editSimilarity: editSim,
              sequenceSimilarity: seqSim,
              exactChars,
              lineText: t,
              units: selected,
              allUnits: u,
              startIndex: i
            });
          }
        }
      }
    }
  }

  out.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    if ((b.exactChars || 0) !== (a.exactChars || 0)) return (b.exactChars || 0) - (a.exactChars || 0);
    return Math.abs([...a.candidate].length - tlen) - Math.abs([...b.candidate].length - tlen);
  });

  const seen = new Set();
  const result = [];
  for (const x of out) {
    const b = x.units[0].bbox;
    const e = x.units[x.units.length - 1].bbox;
    const key = `${x.lineText}\t${Math.round(b.x0)}\t${Math.round(e.x1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(x);
    if (result.length >= limit) break;
  }
  return result;
}

function makeCandidateCrop(ocrCanvas, candidate) {
  const all = candidate.allUnits || candidate.units || [];
  const selected = candidate.units || [];
  if (!selected.length) return null;

  // 候補の前後も少し含める。最初の1文字が「ーざー」のように欠落した場合でも、
  // 再OCR側で本来の「ゆ」を拾えるようにするため。
  const first = Math.max(0, candidate.startIndex - 2);
  const last = Math.min(all.length, candidate.startIndex + selected.length + 2);
  const contextUnits = all.length ? all.slice(first, last) : selected;

  const xs = contextUnits.flatMap(u => [u.bbox.x0, u.bbox.x1]);
  const ys = contextUnits.flatMap(u => [u.bbox.y0, u.bbox.y1]);
  if (!xs.length || !ys.length) return null;

  const candidateXs = selected.flatMap(u => [u.bbox.x0, u.bbox.x1]);
  const candidateYs = selected.flatMap(u => [u.bbox.y0, u.bbox.y1]);
  const rawW = Math.max(...candidateXs) - Math.min(...candidateXs);
  const rawH = Math.max(...candidateYs) - Math.min(...candidateYs);
  const padX = Math.max(30, Math.round(rawW * 0.65));
  const padY = Math.max(30, Math.round(rawH * 0.55));

  const x0 = Math.max(0, Math.floor(Math.min(...xs) - padX));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - padY));
  const x1 = Math.min(ocrCanvas.width, Math.ceil(Math.max(...xs) + padX));
  const y1 = Math.min(ocrCanvas.height, Math.ceil(Math.max(...ys) + padY));
  if (x1 <= x0 || y1 <= y0) return null;

  const c = document.createElement('canvas');
  c.width = Math.max(1, x1 - x0);
  c.height = Math.max(1, y1 - y0);
  const cc = c.getContext('2d');
  cc.imageSmoothingEnabled = true;
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(ocrCanvas, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  return { canvas: c, x0, y0 };
}

function makeSourceCandidateCrop(candidate, scale) {
  const all = candidate.allUnits || candidate.units || [];
  const selected = candidate.units || [];
  if (!selected.length) return null;

  const first = Math.max(0, candidate.startIndex - 2);
  const last = Math.min(all.length, candidate.startIndex + selected.length + 2);
  const contextUnits = all.length ? all.slice(first, last) : selected;
  const xs = contextUnits.flatMap(u => [u.bbox.x0, u.bbox.x1]);
  const ys = contextUnits.flatMap(u => [u.bbox.y0, u.bbox.y1]);
  if (!xs.length || !ys.length) return null;

  const candidateXs = selected.flatMap(u => [u.bbox.x0, u.bbox.x1]);
  const candidateYs = selected.flatMap(u => [u.bbox.y0, u.bbox.y1]);
  const rawW = Math.max(...candidateXs) - Math.min(...candidateXs);
  const rawH = Math.max(...candidateYs) - Math.min(...candidateYs);
  const padX = Math.max(30, Math.round(rawW * 0.65));
  const padY = Math.max(30, Math.round(rawH * 0.55));

  const sx0 = Math.max(0, Math.floor((Math.min(...xs) - padX) / scale));
  const sy0 = Math.max(0, Math.floor((Math.min(...ys) - padY) / scale));
  const sx1 = Math.min(canvas.width, Math.ceil((Math.max(...xs) + padX) / scale));
  const sy1 = Math.min(canvas.height, Math.ceil((Math.max(...ys) + padY) / scale));
  if (sx1 <= sx0 || sy1 <= sy0) return null;

  const c = document.createElement('canvas');
  c.width = Math.max(1, sx1 - sx0);
  c.height = Math.max(1, sy1 - sy0);
  const cc = c.getContext('2d');
  cc.imageSmoothingEnabled = true;
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(sourceImage, sx0, sy0, c.width, c.height, 0, 0, c.width, c.height);
  return { canvas: c, x0: sx0, y0: sy0 };
}

function shiftOcrBboxes(value,dx,dy){
  if(Array.isArray(value)) return value.map(v=>shiftOcrBboxes(v,dx,dy));
  if(!value || typeof value!=="object") return value;
  const out={};
  for(const [k,v] of Object.entries(value)){
    if(k==="bbox" && v && typeof v.x0==="number") out[k]={...v,x0:v.x0-dx,y0:v.y0-dy,x1:v.x1-dx,y1:v.y1-dy};
    else out[k]=shiftOcrBboxes(v,dx,dy);
  }
  return out;
}

async function recognizeVariant(worker,inputCanvas,target,mode,scale,offsetX=0,offsetY=0){const result=await worker.recognize(inputCanvas,{tessedit_pageseg_mode:"11"});const data=result?.data||{},rawLines=data.lines||[],lines=(offsetX||offsetY)?shiftOcrBboxes(rawLines,offsetX,offsetY):rawLines,matches=[];for(const line of lines){const units=extractLineUnits(line),hits=findTargetInUnits(units,target),lineText=units.map(u=>u.ch).join("");for(const hit of hits){
    // symbols[].bbox はOCR用に拡大したcanvas(scale倍)の座標。境界線を追加した場合は
    // その分のoffsetも引いて元画像座標へ戻す。
    const scaleBbox=b=>b?{x0:(b.x0)/scale,y0:(b.y0)/scale,x1:(b.x1)/scale,y1:(b.y1)/scale}:null;
    const symbols=hit.symbols.map(s=>({...s,bbox:scaleBbox(s.bbox)}));
    matches.push({x0:hit.targetBox.x0/scale,y0:hit.targetBox.y0/scale,x1:hit.targetBox.x1/scale,y1:hit.targetBox.y1/scale,mode,lineText,symbols});
}}const words=(offsetX||offsetY)?shiftOcrBboxes(data.words||[],offsetX,offsetY):(data.words||[]);return {mode,lines,words,rawText:String(data.text||""),matches,near:findNearCandidates(lines,target)};}

const OCR_BORDER_PX = 10;

function makeWhiteBorderCanvas(src,pad){
  const c=document.createElement("canvas");
  c.width=src.width+pad*2;
  c.height=src.height+pad*2;
  const g=c.getContext("2d");
  g.fillStyle="#fff";
  g.fillRect(0,0,c.width,c.height);
  g.drawImage(src,pad,pad);
  return c;
}

const ANALYSIS_CANVAS_MAX_WIDTH = 1000;
const ANALYSIS_CANVAS_MAX_PIXELS = 2500000;

function buildAnalysisCanvas(source=sourceImage){
  const sw=source?.naturalWidth||source?.width||canvas.width;
  const sh=source?.naturalHeight||source?.height||canvas.height;
  if(!sw||!sh) return {canvas:source,scale:1,resized:false,width:sw||0,height:sh||0};

  const byWidth=ANALYSIS_CANVAS_MAX_WIDTH/sw;
  const byPixels=Math.sqrt(ANALYSIS_CANVAS_MAX_PIXELS/Math.max(1,sw*sh));
  const scale=Math.min(1,byWidth,byPixels);
  if(scale>=0.995){
    return {canvas:source,scale:1,resized:false,width:sw,height:sh};
  }

  const c=document.createElement("canvas");
  c.width=Math.max(1,Math.round(sw*scale));
  c.height=Math.max(1,Math.round(sh*scale));
  const g=c.getContext("2d");
  g.imageSmoothingEnabled=true;
  g.imageSmoothingQuality="high";
  g.drawImage(source,0,0,sw,sh,0,0,c.width,c.height);
  return {canvas:c,scale,resized:true,width:c.width,height:c.height};
}

function buildOcrCanvas(baseCanvas=sourceImage){
  // 解析用の基準キャンバスからOCRキャンバスを作る。
  // これでOCR・局所OCR・イタリック探索が同じ座標系を共有しつつ、OCRだけは必要な倍率を保てる。
  const srcW=baseCanvas?.width||canvas.width;
  const srcH=baseCanvas?.height||canvas.height;
  const baseScale=2.5;
  const maxOcrPixels=11000000;
  const srcPixels=Math.max(1,srcW*srcH);
  const safeScale=Math.sqrt(maxOcrPixels/srcPixels);
  const scale=Math.max(1.8,Math.min(baseScale,safeScale));
  const oc=document.createElement("canvas");
  oc.width=Math.round(srcW*scale);
  oc.height=Math.round(srcH*scale);
  const c=oc.getContext("2d");
  c.imageSmoothingEnabled=true;
  c.imageSmoothingQuality="high";
  c.drawImage(baseCanvas,0,0,srcW,srcH,0,0,oc.width,oc.height);
  return {canvas:oc,scale};
}

async function collectOcrResults(worker,target,analysisState=null){
  const analysis=analysisState||buildAnalysisCanvas();
  const analysisCanvas=analysis.canvas;
  const analysisScale=analysis.scale||1;
  const {canvas:oc,scale:ocrScale}=buildOcrCanvas(analysisCanvas);
  const totalScale=analysisScale*ocrScale;
  const results=[];
  const stats={primaryMs:0,fallbackMs:0,primaryHitCount:0,fallbackUsed:false,primaryName:"グレー＋コントラスト",fallbackSkippedForSpeed:false};

  // 主OCRは「グレー＋コントラスト」を1回だけ実行する。
  // 重い全画面fallbackは使わず、後段の近似候補・局所OCR・補助探索へつなぐ。
  const primaryStarted=performance.now();
  status("実行中…");
  const primaryBase=makeOcrVariant(oc,stats.primaryName);
  const primaryVariant=makeWhiteBorderCanvas(primaryBase,OCR_BORDER_PX*ocrScale);
  try {
    const primary=await recognizeVariant(worker,primaryVariant,target,stats.primaryName,totalScale,OCR_BORDER_PX*ocrScale,OCR_BORDER_PX*ocrScale);
    primary._ocrToOriginalScale=1/totalScale;
    results.push(primary);
    stats.primaryHitCount=primary.matches.length;
  } finally {
    primaryVariant.width=1;primaryVariant.height=1;
    if(primaryBase!==oc){primaryBase.width=1;primaryBase.height=1;}
    stats.primaryMs=performance.now()-primaryStarted;
  }

  // primary HITが0件でも重い全画面OCRは追加せず、近似候補群をそのまま救出へ渡す。
  stats.fallbackUsed=false;
  stats.fallbackSkippedForSpeed = stats.primaryHitCount===0;
  stats.fallbackMs=0;
  stats.fallbackReason = stats.primaryHitCount===0 ? "近似候補救出を優先して省略" : "不要";

  // 色抽出OCRは主OCRのHIT数に関係なく1回だけ追加実行する。
  const colorStarted=performance.now();
  const colorBase=makeOcrVariant(oc,"色抽出");
  const colorVariant=makeWhiteBorderCanvas(colorBase,OCR_BORDER_PX*ocrScale);
  try {
    const color=await recognizeVariant(worker,colorVariant,target,"色抽出",totalScale,OCR_BORDER_PX*ocrScale,OCR_BORDER_PX*ocrScale);
    color._ocrToOriginalScale=1/totalScale;
    results.push(color);
    stats.colorHitCount=color.matches.length;
  } finally {
    colorVariant.width=1;colorVariant.height=1;
    if(colorBase!==oc){colorBase.width=1;colorBase.height=1;}
  }
  stats.colorMs=performance.now()-colorStarted;

  return {results,scale:totalScale,ocrCanvas:oc,stats,analysisCanvas,analysisScale,ocrScale,analysis};
}

function getCandidateBox(candidate, scale) {
  const units = candidate.units || [];
  if (!units.length) return null;
  const xs = units.flatMap(u => [u.bbox.x0, u.bbox.x1]);
  const ys = units.flatMap(u => [u.bbox.y0, u.bbox.y1]);
  return {
    x0: Math.min(...xs) / scale,
    y0: Math.min(...ys) / scale,
    x1: Math.max(...xs) / scale,
    y1: Math.max(...ys) / scale
  };
}

function groupNearCandidates(results, scale) {
  const groups = [];
  for (const result of results) {
    for (const candidate of result.near || []) {
      if (candidate.similarity >= 0.999) continue;
      const box = getCandidateBox(candidate, scale);
      if (!box) continue;
      let group = groups.find(g => {
        const a = g.box, b = box;
        const cxA = (a.x0 + a.x1) / 2, cyA = (a.y0 + a.y1) / 2;
        const cxB = (b.x0 + b.x1) / 2, cyB = (b.y0 + b.y1) / 2;
        const w = Math.max(a.x1 - a.x0, b.x1 - b.x0, 1);
        const h = Math.max(a.y1 - a.y0, b.y1 - b.y0, 1);
        return Math.abs(cxA - cxB) <= Math.max(28, w * 0.45) &&
               Math.abs(cyA - cyB) <= Math.max(28, h * 0.65);
      });
      if (!group) {
        group = { box, candidates: [], modes: new Set() };
        groups.push(group);
      }
      group.candidates.push({...candidate, mode: result.mode});
      group.modes.add(result.mode);
      group.box = {
        x0: Math.min(group.box.x0, box.x0),
        y0: Math.min(group.box.y0, box.y0),
        x1: Math.max(group.box.x1, box.x1),
        y1: Math.max(group.box.y1, box.y1)
      };
    }
  }
  groups.sort((a, b) => {
    const sa = Math.max(...a.candidates.map(c => c.similarity));
    const sb = Math.max(...b.candidates.map(c => c.similarity));
    return sb - sa;
  });
  return groups;
}

function makeGroupCandidate(group) {
  const best = [...group.candidates].sort((a,b) => b.similarity - a.similarity)[0];
  return {...best, box: group.box, candidateCount: group.candidates.length, modeCount: group.modes.size};
}

function groupTouchesExactHit(group, results) {
  const hits = results.flatMap(r => r.matches || []);
  if (!hits.length) return false;
  const a = group.box;
  const acx = (a.x0 + a.x1) / 2, acy = (a.y0 + a.y1) / 2;
  return hits.some(h => {
    const b = {x0:h.x0,y0:h.y0,x1:h.x1,y1:h.y1};
    const bcx = (b.x0 + b.x1) / 2, bcy = (b.y0 + b.y1) / 2;
    const aw = Math.max(1, a.x1-a.x0), ah = Math.max(1, a.y1-a.y0);
    const bw = Math.max(1, b.x1-b.x0), bh = Math.max(1, b.y1-b.y0);
    return Math.abs(acx-bcx) <= Math.max(24, Math.max(aw,bw)*0.55) &&
           Math.abs(acy-bcy) <= Math.max(24, Math.max(ah,bh)*0.70);
  });
}

async function refineNearCandidates(worker, results, ocrCanvas, target, scale) {
  const refined = [];
  const acceptedNear = [];
  const groups = groupNearCandidates(results, scale);
  const started = performance.now();
  let attempted = 0;
  let skippedExact = 0;
  let extraPasses = 0;
  let fastRecovered = 0;
  let fastRejected = 0;
  const MAX_REFINE_GROUPS = 8;

  // 3文字名の近似候補救出:
  // 3文字名は1文字誤認で67%まで落ちるため、「同一地点で2回」だけでなく、
  // 画像内の別地点でも同じ誤認文字列が繰り返された場合を強い根拠として扱う。
  // 同一group内の重複は1票にまとめ、別groupごとに1票だけ数える。
  const threeCharGlobalCounts = new Map();
  if ([...target].length === 3) {
    for (const g of groups) {
      const seenInGroup = new Set();
      for (const c of g.candidates) {
        if ([...c.candidate].length !== 3) continue;
        if (editDistance(target, c.candidate) !== 1) continue;
        if (c.similarity < 0.66) continue;
        seenInGroup.add(c.candidate);
      }
      for (const name of seenInGroup) {
        threeCharGlobalCounts.set(name, (threeCharGlobalCounts.get(name) || 0) + 1);
      }
    }
  }

  // V36: 再OCRより先に「かなり強い近似候補」を救出する。
  // 今回のように Tesseract が「ゆーざー」を「めーざー」と読むケースでは、
  // 4文字中3文字が同じ位置に残るため、局所OCRを何度回しても同じ誤読を
  // 繰り返すことがある。そうした候補は、同じ地点に複数の近似候補が集まり、
  // かつ対象と同じ文字数で、編集類似度が高い場合に先に採用する。
  function getFastRecovery(group) {
    const tlen = [...target].length;
    const sameLength = group.candidates.filter(c => [...c.candidate].length === tlen);
    if (!sameLength.length) return null;

    // 同じ文字数で編集距離1なら「1文字だけの誤認」。
    // 4文字以上は従来どおり72%以上で即救出。
    // 3文字は1文字誤認だけで類似度が67%まで落ちるため、
    // 同じ誤認文字列が同一地点で2回以上出た時だけ安全側に救出する。
    const distanceOne = sameLength
      .map(c => ({...c, recoveryDistance: editDistance(target, c.candidate)}))
      .filter(c => c.recoveryDistance <= 1);

    if (!distanceOne.length || tlen < 3) return null;

    let strong = [];
    if (tlen === 3) {
      const counts = new Map();
      for (const c of distanceOne) {
        if (c.recoveryDistance !== 1 || c.similarity < 0.66) continue;
        counts.set(c.candidate, (counts.get(c.candidate) || 0) + 1);
      }
      strong = distanceOne
        .filter(c => {
          if (c.recoveryDistance !== 1 || c.similarity < 0.66) return false;
          const sameSpotCount = counts.get(c.candidate) || 0;
          const globalSpotCount = threeCharGlobalCounts.get(c.candidate) || 0;
          return sameSpotCount >= 2 || globalSpotCount >= 2;
        })
        .sort((a,b) => b.similarity - a.similarity);
    } else {
      strong = distanceOne
        .filter(c => c.similarity >= 0.72)
        .sort((a,b) => {
          if (a.recoveryDistance !== b.recoveryDistance) return a.recoveryDistance - b.recoveryDistance;
          return b.similarity - a.similarity;
        });
    }

    if (!strong.length) return null;

    const best = strong[0];
    const distinctCandidates = new Set(strong.map(c => c.candidate));

    // 黒塗りには候補地点全体ではなく、採用した近似候補自身のbboxを使う。
    const units = best.units || [];
    const xs = units.flatMap(u => [u.bbox.x0, u.bbox.x1]);
    const ys = units.flatMap(u => [u.bbox.y0, u.bbox.y1]);
    if (!xs.length || !ys.length) return null;

    const candidateBox = {
      x0: Math.min(...xs) / scale,
      y0: Math.min(...ys) / scale,
      x1: Math.max(...xs) / scale,
      y1: Math.max(...ys) / scale
    };

    return {
      candidate: best.candidate,
      similarity: best.similarity,
      recoveryDistance: best.recoveryDistance,
      exactChars: best.exactChars || 0,
      lineText: best.lineText,
      mode: best.mode,
      box: candidateBox,
      candidateBox,
      groupBox: group.box,
      candidateCount: group.candidates.length,
      strongCandidateCount: strong.length,
      distinctStrongCandidates: distinctCandidates.size,
      threeCharConsensus: tlen === 3,
      threeCharGlobalSpotCount: tlen === 3 ? (threeCharGlobalCounts.get(best.candidate) || 0) : 0
    };
  }

  for (let gi = 0; gi < groups.length && gi < MAX_REFINE_GROUPS; gi++) {
    const group = groups[gi];
    if (groupTouchesExactHit(group, results)) {
      skippedExact++;
      continue;
    }

    const fast = getFastRecovery(group);
    if (fast) {
      fastRecovered++;
      acceptedNear.push({
        ...fast,
        recovery: '近似候補救出',
        refinedText: `近似候補採用：${fast.candidate}`
      });
      continue;
    }
    fastRejected++;

    const cand = makeGroupCandidate(group);
    const grayCrop = makeCandidateCrop(ocrCanvas, cand);
    const sourceCrop = makeSourceCandidateCrop(cand, scale);
    if (!grayCrop && !sourceCrop) continue;
    attempted++;
    status(`OCR診断中…\n候補地点 ${gi+1}/${Math.min(groups.length, MAX_REFINE_GROUPS)} を再確認しています。`);

    const hits = [];
    const checked = new Set();

    async function runLocalCrop(crop, label, psm) {
      if (!crop) return false;
      const REFINE_SCALE = 3;
      const enlarged = document.createElement('canvas');
      enlarged.width = Math.max(1, Math.round(crop.canvas.width * REFINE_SCALE));
      enlarged.height = Math.max(1, Math.round(crop.canvas.height * REFINE_SCALE));
      const eg = enlarged.getContext('2d');
      eg.imageSmoothingEnabled = true;
      eg.imageSmoothingQuality = 'high';
      eg.drawImage(crop.canvas, 0, 0, enlarged.width, enlarged.height);

      const key = `${label}|${psm}`;
      if (checked.has(key)) { enlarged.width = 1; enlarged.height = 1; return false; }
      checked.add(key);
      const result = await worker.recognize(enlarged, {tessedit_pageseg_mode:String(psm)});
      const text = normalize(String(result?.data?.text || ''));
      const ok = text.includes(target);
      if (ok) hits.push({text, mode:`候補再OCR・${label}・${REFINE_SCALE}倍`, psm:String(psm)});
      enlarged.width = 1; enlarged.height = 1;
      return ok;
    }

    // まず元画像。色文字（右側のユーザー名など）を落とさないためのルート。
    let ok = await runLocalCrop(sourceCrop, '元画像', 7);

    // 元画像で拾えなければ、全体OCRで実績のあるグレー＋コントラスト。
    if (!ok) {
      extraPasses++;
      ok = await runLocalCrop(grayCrop, 'グレー', 7);
    }

    // それでもダメな「ゆーゴー」「めーざぴー」のような候補だけ、PSM8を1回追加。
    if (!ok && (cand.similarity < 0.70 || (cand.exactChars || 0) <= 2)) {
      extraPasses++;
      ok = await runLocalCrop(sourceCrop || grayCrop, '元画像', 8);
    }

    // 元画像・グレー・PSM8でも読めない候補だけ、二値化・反転もこの候補地点に
    // 絞って試す。全体OCRでこれらを毎回回すと画像全体分の時間がかかるが、
    // 候補地点（最大8箇所）だけなら低コストで済む。
    if (!ok && sourceCrop) {
      for (const variantName of ['二値化180', '二値化220', '反転']) {
        if (ok) break;
        extraPasses++;
        const variantCanvas = makeOcrVariant(sourceCrop.canvas, variantName);
        ok = await runLocalCrop({canvas: variantCanvas, x0: sourceCrop.x0, y0: sourceCrop.y0}, variantName, 7);
        if (variantCanvas !== sourceCrop.canvas) { variantCanvas.width = 1; variantCanvas.height = 1; }
      }
    }

    if (ok) {
      refined.push({
        candidate:cand.candidate,
        similarity:cand.similarity,
        exactChars:cand.exactChars || 0,
        lineText:cand.lineText,
        mode:cand.mode,
        refinedText:hits[0].text,
        hits,
        candidateCount:cand.candidateCount,
        modeCount:cand.modeCount,
        box:group.box,
        refinedBox:getCandidateBox(cand,scale) || group.box,
        cropBox:grayCrop ? {x0:grayCrop.x0/scale,y0:grayCrop.y0/scale,x1:(grayCrop.x0+grayCrop.canvas.width)/scale,y1:(grayCrop.y0+grayCrop.canvas.height)/scale} : null,
        passCount:hits.length
      });
    }

    if (grayCrop) { grayCrop.canvas.width = 1; grayCrop.canvas.height = 1; }
    if (sourceCrop) { sourceCrop.canvas.width = 1; sourceCrop.canvas.height = 1; }
  }

  return {
    groups,
    refined,
    acceptedNear,
    attempted,
    skippedExact,
    extraPasses,
    fastRecovered,
    fastRejected,
    elapsedMs: performance.now() - started
  };
}


// V70：周囲の文字を手掛かりに、対象文字そのものをOCRできなかった地点を救出する。
// 例：「ねるちゃん」を1件でも認識できたら「ちゃん」を文脈として学習し、
// 別の局所OCRで「ちゃん」だけ認識された場合、その直前に対象文字があると推定する。
// 推定矩形は既知の完全一致HITから得た対象文字の平均サイズと、
// 対象→文脈の実測間隔を使う。診断にも使えるよう候補情報を返す。
function mergeMatches(results){const all=results.flatMap(r=>r.matches),final=[];for(const box of all){const dup=final.some(o=>{const ix0=Math.max(box.x0,o.x0),iy0=Math.max(box.y0,o.y0),ix1=Math.min(box.x1,o.x1),iy1=Math.min(box.y1,o.y1);if(ix1<=ix0||iy1<=iy0)return false;const inter=(ix1-ix0)*(iy1-iy0),area=Math.min((box.x1-box.x0)*(box.y1-box.y0),(o.x1-o.x0)*(o.y1-o.y0));return area>0&&inter/area>.45;});if(!dup)final.push(box);}return final;}

async function run(){
  errorEl.hidden=true; ocrDiagnostics.hidden=true; ocrDebugLayer.hidden=true; ocrDebugLayer.innerHTML="";
  try{
    if(!sourceImage) throw new Error("先に画像を選択してください。");
    const target=normalize(targetText.value);
    if(!target) throw new Error("黒塗りする文字を入力してください。");
    saveTargetHistoryEntry(targetText.value);

    manualStamps.length=0; manualHistory.length=0; selectedManualIndex=-1; editMode=null; ocrBaseCanvas=null; redrawFromBase();
    const worker=await getWorker(getOcrLanguage(target));
    const analysisState=buildAnalysisCanvas();
    status("OCR中…\n基準キャンバスを作成しています。");

    // V33の高速OCRをそのまま使用。通常HITはV19の黒塗り処理へ接続する。
    const {results,scale,ocrCanvas,stats,analysisCanvas,analysisScale}=await collectOcrResults(worker,target,analysisState);
    const matches=mergeMatches(results);

    // 通常OCRで見つかった対象文字を黒塗り候補として登録。
    // 実際の描画は最後にまとめて行い、OCR結果も手動黒塗りと同じ編集対象にする。
    const paintBoxes=matches.map(b=>({
      x:b.x0, y:b.y0, w:b.x1-b.x0, h:b.y1-b.y0, symbols:b.symbols||[], source:"OCR"
    }));

    // 完全一致HITの高倍率再OCRは行わない。
    // symbol union + 一律8%余白だけで最終位置を決める。
    const exactRefineAttempted = 0;
    const exactRefineSkipped = paintBoxes.length;

    // 通常OCRで拾えなかった候補だけ、V33の局所再OCRを実行。
    // 再OCRで対象文字を確認できた地点は、その候補文字のbboxを黒塗り範囲として追加する。
    const refine=await refineNearCandidates(worker,results,ocrCanvas,target,scale);
    for(const r of [...refine.refined, ...refine.acceptedNear]){
      const b=r.refinedBox || r.box;
      if(!b) continue;
      const duplicate=paintBoxes.some(o=>{
        const ix0=Math.max(o.x,b.x0), iy0=Math.max(o.y,b.y0);
        const ix1=Math.min(o.x+o.w,b.x1), iy1=Math.min(o.y+o.h,b.y1);
        if(ix1<=ix0 || iy1<=iy0) return false;
        const inter=(ix1-ix0)*(iy1-iy0);
        const area=Math.min(o.w*o.h,(b.x1-b.x0)*(b.y1-b.y0));
        return area>0 && inter/area>.45;
      });
      if(!duplicate) paintBoxes.push({x:b.x0,y:b.y0,w:b.x1-b.x0,h:b.y1-b.y0,symbols:r.symbols||[],source:r.recovery||"再OCR"});
    }


    // V70：V68の「文字領域全走査＋局所OCR」を正式な追加検出ルートとして使用。
    // 全体OCRで拾えなかった文字も、文字っぽい領域内のPSM7 OCRで拾えた場合は追加する。
    status("OCR中…\n文字領域を追加走査しています。");
    const regionScan = await collectTextRegionMatches(worker, analysisCanvas, target, analysisScale);
    for (const b of regionScan.matches) {
      const duplicate = paintBoxes.some(o => {
        const ix0 = Math.max(o.x, b.x0), iy0 = Math.max(o.y, b.y0);
        const ix1 = Math.min(o.x + o.w, b.x1), iy1 = Math.min(o.y + o.h, b.y1);
        if (ix1 <= ix0 || iy1 <= iy0) return false;
        const inter = (ix1 - ix0) * (iy1 - iy0);
        const area = Math.min(o.w * o.h, (b.x1 - b.x0) * (b.y1 - b.y0));
        return area > 0 && inter / area > .45;
      });
      if (!duplicate) {
        paintBoxes.push({
          x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0,
          symbols: b.symbols || [], source: "局所OCR"
        });
      }
    }


    // 通常OCR/局所OCRで拾えなかった場所だけ、
    // コントラスト補正→イタリックテンプレートを補助候補として追加する。
    status("OCR中…\nイタリック文字の取りこぼしを補助確認しています。");
    const italicHeightChoice = chooseItalicVariantHeights(results, target, analysisScale);
    const italicVariantHeights = italicHeightChoice.heights;
    const italicRescue = collectItalicRescueCandidates(analysisCanvas, target, paintBoxes, italicVariantHeights, regionScan.detected, analysisScale);
    for (const c of italicRescue.accepted) {
      paintBoxes.push({
        x:c.x, y:c.y, w:c.w, h:c.h,
        symbols:[], source:"イタリック救出"
      });
    }


    // OCR黒塗りを編集可能なオブジェクトとして登録する。
    // OCR専用の補正・余白計算はここで一度だけ行い、以後の移動・サイズ変更では
    // その最終黒塗り矩形をそのまま編集する。
    ocrBaseCanvas=document.createElement("canvas");
    ocrBaseCanvas.width=canvas.width; ocrBaseCanvas.height=canvas.height;
    const baseCtx=ocrBaseCanvas.getContext("2d");
    baseCtx.drawImage(sourceImage,0,0);

    pushManualHistory();
    for(const b of paintBoxes){
      const rect=getOcrVisualRect({x:b.x,y:b.y,w:b.w,h:b.h},b.symbols||[],{source:b.source});
      if(rect.w < 1 || rect.h < 1) continue;
      manualStamps.push({
        x:rect.x, y:rect.y, w:rect.w, h:rect.h,
        style:getCurrentRedactionStyle(),
        kind:"ocr"
      });
    }
    redrawFromBase();
    saveBtn.disabled=false; manualBtn.disabled=false;
    const italicAdded = italicRescue?.accepted?.length || 0;
    const localAdded = Math.max(0, paintBoxes.length - matches.length - italicAdded);
    status(`黒塗り完了：${manualStamps.length}箇所\n通常OCR：${matches.length}箇所 / 追加局所OCR：${localAdded}箇所 / イタリック救出：${italicAdded}箇所\nイタリック探索：${italicRescue.searchMode} ${italicRescue.searchRegionCount}領域 / 評価${italicRescue.scoredPositions}地点 / HIT済み省略${italicRescue.skippedExisting}地点\n位置再確認：${exactRefineAttempted}件 / 省略：${exactRefineSkipped}件${stats.fallbackSkippedForSpeed ? " / 重い全画面fallback省略" : ""}`);
  }catch(error){status("OCRでエラーが発生しました。下のエラー詳細を確認してください。",error);}
}


// ===== イタリック補助探索用テンプレート =====
// 14pxで描画した文字のアルファ領域を切り出し、目標高さへ拡大して検索する。
const TEMPLATE_FONT_STACK='-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", "Yu Gothic", sans-serif';
const TEMPLATE_BASE_FONT_SIZE=14;
const TEMPLATE_TARGET_HEIGHT=32;
const TEMPLATE_FG_WEIGHT=0.72;
const TEMPLATE_BG_WEIGHT=0.28;
const TEMPLATE_SEARCH_LEFT_RATIO=0.10;
const TEMPLATE_SEARCH_RIGHT_RATIO=0.02;
const TEMPLATE_SEARCH_TOP_RATIO=0.12;

// ===== コントラスト補正＋イタリック補助探索 =====
// 文字領域を先に探索し、既存HITを除外しながら全画面を補完する。
const ITALIC_VARIANT_HEIGHTS = [26, 28]; // 1000px統一解析キャンバス基準のテスト値
const ITALIC_VARIANT_SKEWS = [0.00];
const ITALIC_DIAGNOSTIC_SKEWS = [-0.10, 0.00, 0.10];
const ITALIC_COARSE_STEP = 6;
const ITALIC_REFINE_STEP = 2;
const ITALIC_SECONDARY_OFFSET = 3;
const ITALIC_COARSE_LIMIT = 10;
const ITALIC_FINAL_LIMIT = 6;
const ITALIC_RESCUE_SCORE_MIN = 0.62;
const ITALIC_RESCUE_FG_MIN = 0.47;
const ITALIC_RESCUE_BG_MIN = 0.93;
const ITALIC_RESCUE_MAX_NEW = 3;

// V90.26: イタリック探索専用の縮小キャンバス。
// 元画像が大きい時だけ縮小し、探索画素数とテンプレートの見かけサイズを安定させる。
// OCR用キャンバスとは分離し、OCR精度や既存処理には影響させない。
const ITALIC_SEARCH_MAX_WIDTH = 900;
const ITALIC_SEARCH_MAX_PIXELS = 1800000;

function buildItalicSearchCanvas(source){
  const sw=source.naturalWidth||source.width, sh=source.naturalHeight||source.height;
  if(!sw||!sh) return {source, scale:1, width:sw||0, height:sh||0, resized:false};
  const byWidth=ITALIC_SEARCH_MAX_WIDTH/sw;
  const byPixels=Math.sqrt(ITALIC_SEARCH_MAX_PIXELS/(sw*sh));
  const scale=Math.min(1,byWidth,byPixels);
  if(scale>=0.995) return {source, scale:1, width:sw, height:sh, resized:false};
  const c=document.createElement('canvas');
  c.width=Math.max(1,Math.round(sw*scale));
  c.height=Math.max(1,Math.round(sh*scale));
  const g=c.getContext('2d',{willReadFrequently:true});
  g.imageSmoothingEnabled=true;
  g.imageSmoothingQuality='high';
  g.drawImage(source,0,0,sw,sh,0,0,c.width,c.height);
  return {source:c, scale:c.width/sw, width:c.width, height:c.height, resized:true};
}

function scaleItalicRects(rects, scale){
  if(scale===1) return rects||[];
  return (rects||[]).map(r=>({
    ...r,
    x:(r.x??r.x0??0)*scale,
    y:(r.y??r.y0??0)*scale,
    w:(r.w??((r.x1??0)-(r.x0??0)))*scale,
    h:(r.h??((r.y1??0)-(r.y0??0)))*scale
  }));
}

function mapItalicCandidateToOriginal(c, scale){
  if(scale===1) return c;
  return {
    ...c,
    x:Math.round(c.x/scale),
    y:Math.round(c.y/scale),
    w:Math.max(1,Math.round(c.w/scale)),
    h:Math.max(1,Math.round(c.h/scale)),
    searchX:c.x, searchY:c.y, searchW:c.w, searchH:c.h
  };
}


function medianNumber(values){
  const nums=(values||[]).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!nums.length) return null;
  const mid=Math.floor(nums.length/2);
  return nums.length%2 ? nums[mid] : (nums[mid-1]+nums[mid])/2;
}

function chooseItalicVariantHeights(results, target, analysisScale=1){
  // V91.2: 追加の画像解析はせず、すでに取得済みのOCR bboxから
  // 解析キャンバス上の実文字高さを推定する。テンプレート本数は2本のまま。
  // 優先順位: 完全一致 > 強い近似候補 > 既定値。
  const exactHeights=[];
  for(const r of (results||[])){
    for(const m of (r.matches||[])){
      const h=(m.y1??0)-(m.y0??0);
      if(Number.isFinite(h) && h>0) exactHeights.push(h*analysisScale);
    }
  }

  let basis=medianNumber(exactHeights);
  let source='完全一致OCR';
  let sampleCount=exactHeights.length;

  if(!Number.isFinite(basis)){
    const nearHeights=[];
    const tlen=[...target].length;
    for(const r of (results||[])){
      for(const c of (r.near||[])){
        if([...c.candidate].length!==tlen) continue;
        if(editDistance(target,c.candidate)!==1) continue;
        if(c.similarity<0.66) continue;
        const ys=(c.units||[]).flatMap(u=>[u?.bbox?.y0,u?.bbox?.y1]).filter(Number.isFinite);
        if(ys.length<2) continue;
        // near候補のbboxはOCRキャンバス座標。結果の元画像換算scaleは後段で使われるため、
        // ここでは analysisScale/totalScale 相当になるよう r._ocrToOriginalScale を利用する。
        const ocrToOriginalScale=Number.isFinite(r._ocrToOriginalScale) ? r._ocrToOriginalScale : null;
        if(!ocrToOriginalScale) continue;
        const originalH=(Math.max(...ys)-Math.min(...ys))*ocrToOriginalScale;
        if(Number.isFinite(originalH) && originalH>0) nearHeights.push(originalH*analysisScale);
      }
    }
    basis=medianNumber(nearHeights);
    source='強い近似OCR';
    sampleCount=nearHeights.length;
  }

  if(!Number.isFinite(basis)){
    return {heights:[...ITALIC_VARIANT_HEIGHTS], basis:null, source:'既定値', sampleCount:0};
  }

  const center=Math.max(22,Math.min(40,Math.round(basis)));
  let a=Math.max(22,center-1), b=Math.min(40,center+1);
  if(a===b) b=Math.min(40,a+1);
  return {heights:[a,b], basis, source, sampleCount};
}

function buildTextTemplateStyled(text, opts={}){
  const italic = opts.italic !== false;
  const color = opts.color || '#ffffff';
  const fontStyle = italic ? 'italic ' : '';
  const targetH = opts.targetHeight || TEMPLATE_TARGET_HEIGHT;
  const skew = Number.isFinite(opts.skew) ? opts.skew : 0;
  const marginX = 18 + Math.ceil(Math.abs(skew) * TEMPLATE_BASE_FONT_SIZE * 3);
  const rawH = Math.ceil(TEMPLATE_BASE_FONT_SIZE * 2.1);
  const probe=document.createElement('canvas');
  const probeCtx=probe.getContext('2d');
  probeCtx.font=`${fontStyle}400 ${TEMPLATE_BASE_FONT_SIZE}px ${TEMPLATE_FONT_STACK}`;
  const met=probeCtx.measureText(text);
  const rawW=Math.ceil(met.width)+marginX*2;

  const m=document.createElement('canvas');
  m.width=rawW; m.height=rawH;
  const g=m.getContext('2d',{willReadFrequently:true});
  g.clearRect(0,0,rawW,rawH);
  g.save();
  g.setTransform(1, 0, skew, 1, 0, 0);
  g.font=`${fontStyle}400 ${TEMPLATE_BASE_FONT_SIZE}px ${TEMPLATE_FONT_STACK}`;
  g.fillStyle=color;
  g.textBaseline='alphabetic';
  g.fillText(text, marginX, TEMPLATE_BASE_FONT_SIZE+4);
  g.restore();

  const d=g.getImageData(0,0,rawW,rawH).data;
  let minX=rawW,minY=rawH,maxX=-1,maxY=-1;
  for(let y=0;y<rawH;y++) for(let x=0;x<rawW;x++){
    if(d[(y*rawW+x)*4+3]>=70){
      if(x<minX)minX=x; if(x>maxX)maxX=x;
      if(y<minY)minY=y; if(y>maxY)maxY=y;
    }
  }
  if(maxX<minX||maxY<minY) return {w:0,h:0,samples:[],bgSamples:[],fontSize:TEMPLATE_BASE_FONT_SIZE,italic,skew,targetHeight:targetH};

  const cropW=maxX-minX+1, cropH=maxY-minY+1;
  const scale=targetH/cropH;
  const targetW=Math.max(1,Math.round(cropW*scale));

  const resized=document.createElement('canvas');
  resized.width=targetW; resized.height=targetH;
  const rg=resized.getContext('2d',{willReadFrequently:true});
  rg.imageSmoothingEnabled=true;
  rg.clearRect(0,0,targetW,targetH);
  rg.drawImage(m,minX,minY,cropW,cropH,0,0,targetW,targetH);

  const rd=rg.getImageData(0,0,targetW,targetH).data;
  const fg=[], bg=[];
  for(let y=0;y<targetH;y++) for(let x=0;x<targetW;x++){
    const a=rd[(y*targetW+x)*4+3];
    if(a>=95) fg.push({x,y});
    else if(a<=12) bg.push({x,y});
  }

  const fgStride=Math.max(1,Math.ceil(fg.length/165));
  const bgStride=Math.max(1,Math.ceil(bg.length/145));
  const fgSamples=[], bgSamples=[];
  for(let i=0;i<fg.length;i+=fgStride) fgSamples.push(fg[i]);
  for(let i=0;i<bg.length;i+=bgStride) bgSamples.push(bg[i]);

  return {
    canvas:resized,w:targetW,h:targetH,
    samples:fgSamples,bgSamples,
    rawW:cropW,rawH:cropH,
    fontSize:TEMPLATE_BASE_FONT_SIZE,
    targetHeight:targetH,
    italic, skew
  };
}

function createGrayFromSource(source, contrastBoost=false){
  const sw=source.naturalWidth||source.width, sh=source.naturalHeight||source.height;
  const c=document.createElement('canvas'); c.width=sw; c.height=sh;
  const g=c.getContext('2d',{willReadFrequently:true});
  g.drawImage(source,0,0,sw,sh);
  const img=g.getImageData(0,0,sw,sh), d=img.data;
  const gray=new Uint8Array(sw*sh);
  for(let i=0,p=0;i<d.length;i+=4,p++){
    let v=Math.round(d[i]*.299+d[i+1]*.587+d[i+2]*.114);
    if(contrastBoost){
      v=Math.max(0,Math.min(255,Math.round((v-128)*1.52+128)));
    }
    gray[p]=v;
  }
  return {gray, sw, sh};
}

function dedupeTemplateCandidates(list, limit=ITALIC_FINAL_LIMIT){
  list.sort((a,b)=>b.score-a.score);
  const out=[];
  for(const c of list){
    const dup=out.some(k=>{
      const ix=Math.max(0, Math.min(c.x+c.w,k.x+k.w)-Math.max(c.x,k.x));
      const iy=Math.max(0, Math.min(c.y+c.h,k.y+k.h)-Math.max(c.y,k.y));
      return ix*iy > Math.min(c.w*c.h, k.w*k.h) * 0.35;
    });
    if(!dup) out.push(c);
    if(out.length>=limit) break;
  }
  return out;
}

function scoreItalicCandidate(gray, sw, x, y, tpl, config){
  let fgHit=0, fgTotal=0, bgHit=0, bgTotal=0;
  const grayTextMin=config.grayTextMin ?? 95;
  const grayTextMax=config.grayTextMax ?? 235;
  const grayBgMax=config.grayBgMax ?? 82;
  for(const p of tpl.samples){
    const lum=gray[(y+p.y)*sw+(x+p.x)];
    if(lum>=grayTextMin && lum<=grayTextMax) fgHit++;
    fgTotal++;
  }
  for(const p of tpl.bgSamples){
    const lum=gray[(y+p.y)*sw+(x+p.x)];
    if(lum<=grayBgMax) bgHit++;
    bgTotal++;
  }
  const fgScore=fgTotal?fgHit/fgTotal:0;
  const bgScore=bgTotal?bgHit/bgTotal:0;
  const score=fgScore*TEMPLATE_FG_WEIGHT+bgScore*TEMPLATE_BG_WEIGHT;
  return {score, fgScore, bgScore};
}


function buildScanPositions(start, end, step, offset=0){
  const arr=[];
  for(let v=start+offset; v<=end; v+=step) arr.push(v);
  if(!arr.length || arr[arr.length-1]!==end) arr.push(end);
  const uniq=[...new Set(arr.filter(v=>v>=start && v<=end))];
  uniq.sort((a,b)=>a-b);
  return uniq;
}


function templateBoxOverlapsExisting(x, y, w, h, existingBoxes=[]) {
  return existingBoxes.some(o => {
    const ox=o.x ?? o.x0 ?? 0;
    const oy=o.y ?? o.y0 ?? 0;
    const ow=o.w ?? ((o.x1??0)-(o.x0??0));
    const oh=o.h ?? ((o.y1??0)-(o.y0??0));
    if(ow<=0 || oh<=0) return false;
    const ix0=Math.max(ox,x), iy0=Math.max(oy,y);
    const ix1=Math.min(ox+ow,x+w), iy1=Math.min(oy+oh,y+h);
    if(ix1<=ix0 || iy1<=iy0) return false;
    const inter=(ix1-ix0)*(iy1-iy0);
    const minArea=Math.min(Math.max(1,ow*oh), Math.max(1,w*h));
    return inter/minArea>=0.35;
  });
}

function buildRegionLimitedPositions(regions, tpl, sw, sh) {
  const margin = 18;
  const xs = new Set();
  const ys = new Set();

  for (const r of (regions || [])) {
    const x0 = Math.max(0, Math.floor(r.x - margin));
    const y0 = Math.max(0, Math.floor(r.y - margin));
    const x1 = Math.min(sw - tpl.w, Math.ceil(r.x + r.w + margin - tpl.w));
    const y1 = Math.min(sh - tpl.h, Math.ceil(r.y + r.h + margin - tpl.h));
    if (x1 < x0 || y1 < y0) continue;

    for (const x of buildScanPositions(x0, x1, ITALIC_COARSE_STEP, 0)) xs.add(x);
    for (const x of buildScanPositions(x0, x1, ITALIC_COARSE_STEP, ITALIC_SECONDARY_OFFSET)) xs.add(x);
    for (const y of buildScanPositions(y0, y1, ITALIC_COARSE_STEP, 0)) ys.add(y);
    for (const y of buildScanPositions(y0, y1, ITALIC_COARSE_STEP, ITALIC_SECONDARY_OFFSET)) ys.add(y);
  }

  return {
    xPositions:[...xs].sort((a,b)=>a-b),
    yPositions:[...ys].sort((a,b)=>a-b)
  };
}

function candidateTouchesSearchRegion(x, y, w, h, regions=[]) {
  if (!regions.length) return true;
  const cx=x+w/2, cy=y+h/2;
  const margin=18;
  return regions.some(r =>
    cx >= r.x-margin &&
    cx <= r.x+r.w+margin &&
    cy >= r.y-margin &&
    cy <= r.y+r.h+margin
  );
}

function searchContrastItalicVariant(gray, sw, sh, tpl, config={}){
  if(!tpl?.w || tpl.w>=sw || tpl.h>=sh){
    return {tpl, coarsePassCount:0, candidates:[], searchXStart:0, searchXEnd:sw, searchYStart:0, searchYEnd:sh};
  }
  const searchYStart=Math.floor(sh*TEMPLATE_SEARCH_TOP_RATIO);
  const searchYEnd=Math.max(searchYStart, sh - tpl.h);
  const searchXStart=Math.floor(sw*TEMPLATE_SEARCH_LEFT_RATIO);
  const searchXEnd=Math.max(searchXStart, sw - tpl.w - Math.floor(sw*TEMPLATE_SEARCH_RIGHT_RATIO));
  const grayTextMin=config.grayTextMin ?? 95;
  const grayTextMax=config.grayTextMax ?? 235;
  const coarseThreshold=config.coarseThreshold ?? 0.60;
  const coarseBgMin=config.coarseBgMin ?? 0.44;
  const finalThreshold=config.finalThreshold ?? 0.63;
  const finalBgMin=config.finalBgMin ?? 0.46;

  const rowHasGray=new Uint8Array(sh);
  for(let y=searchYStart;y<=Math.min(sh-1, searchYEnd+tpl.h);y++){
    let count=0;
    for(let x=searchXStart;x<=searchXEnd;x+=5){
      const v=gray[y*sw+x];
      if(v>=grayTextMin && v<=grayTextMax){
        if(++count>=4) break;
      }
    }
    if(count>=4) rowHasGray[y]=1;
  }

  const coarse=[];
  let coarsePassCount=0;
  let scoredPositionCount=0;
  let skippedExistingCount=0;
  const searchRegions = Array.isArray(config.searchRegions) ? config.searchRegions : [];
  const existingBoxes = Array.isArray(config.existingBoxes) ? config.existingBoxes : [];
  const regionLimited = searchRegions.length > 0;

  let yPositions, xPositions;
  if(regionLimited){
    const regionPositions=buildRegionLimitedPositions(searchRegions,tpl,sw,sh);
    yPositions=regionPositions.yPositions;
    xPositions=regionPositions.xPositions;
  }else{
    yPositions=[...new Set([
      ...buildScanPositions(searchYStart, searchYEnd, ITALIC_COARSE_STEP, 0),
      ...buildScanPositions(searchYStart, searchYEnd, ITALIC_COARSE_STEP, ITALIC_SECONDARY_OFFSET)
    ])].sort((a,b)=>a-b);
    xPositions=[...new Set([
      ...buildScanPositions(searchXStart, searchXEnd, ITALIC_COARSE_STEP, 0),
      ...buildScanPositions(searchXStart, searchXEnd, ITALIC_COARSE_STEP, ITALIC_SECONDARY_OFFSET)
    ])].sort((a,b)=>a-b);
  }

  for(const y of yPositions){
    let rowOk=false;
    for(let yy=0;yy<tpl.h;yy+=Math.max(2,ITALIC_COARSE_STEP)){
      if(rowHasGray[y+yy]){ rowOk=true; break; }
    }
    if(!rowOk) continue;

    for(const x of xPositions){
      if(regionLimited && !candidateTouchesSearchRegion(x,y,tpl.w,tpl.h,searchRegions)) continue;
      if(existingBoxes.length && templateBoxOverlapsExisting(x,y,tpl.w,tpl.h,existingBoxes)){
        skippedExistingCount++;
        continue;
      }
      scoredPositionCount++;
      const s=scoreItalicCandidate(gray, sw, x, y, tpl, config);
      if(s.score>=coarseThreshold && s.bgScore>=coarseBgMin){
        coarsePassCount++;
        coarse.push({x,y,w:tpl.w,h:tpl.h,...s});
      }
    }
  }

  const coarseKept=dedupeTemplateCandidates(coarse, ITALIC_COARSE_LIMIT);
  const refined=[];
  for(const seed of coarseKept){
    const x0=Math.max(searchXStart, seed.x-10), x1=Math.min(searchXEnd, seed.x+10);
    const y0=Math.max(searchYStart, seed.y-10), y1=Math.min(searchYEnd, seed.y+10);
    for(let y=y0;y<=y1;y+=ITALIC_REFINE_STEP){
      for(let x=x0;x<=x1;x+=ITALIC_REFINE_STEP){
        if(regionLimited && !candidateTouchesSearchRegion(x,y,tpl.w,tpl.h,searchRegions)) continue;
        if(existingBoxes.length && templateBoxOverlapsExisting(x,y,tpl.w,tpl.h,existingBoxes)) continue;
        const s=scoreItalicCandidate(gray, sw, x, y, tpl, config);
        if(s.score>=finalThreshold && s.bgScore>=finalBgMin){
          refined.push({x,y,w:tpl.w,h:tpl.h,...s});
        }
      }
    }
  }

  const finalCandidates=dedupeTemplateCandidates(refined, ITALIC_FINAL_LIMIT);
  return {
    tpl, coarsePassCount, candidates:finalCandidates,
    searchXStart, searchXEnd, searchYStart, searchYEnd,
    regionLimited, searchRegionCount:searchRegions.length,
    scoredPositionCount, skippedExistingCount
  };
}

function italicVariantDiagnosticSearch(source, text, variantHeights=ITALIC_VARIANT_HEIGHTS, searchConfig={}, variantSkews=ITALIC_VARIANT_SKEWS){
  const searchBase=buildItalicSearchCanvas(source);
  const searchScale=searchBase.scale||1;
  const contrast=createGrayFromSource(searchBase.source,true);
  const searchRegions=scaleItalicRects(searchConfig.searchRegions||[],searchScale);
  const existingBoxes=scaleItalicRects(searchConfig.existingBoxes||[],searchScale);
  const variants=[];
  for(const h of variantHeights){
    const scaledH=Math.max(18,Math.round(h*searchScale));
    for(const skew of variantSkews){
      const tpl=buildTextTemplateStyled(text,{italic:true,targetHeight:scaledH,skew});
      const searched=searchContrastItalicVariant(contrast.gray, contrast.sw, contrast.sh, tpl, {
        grayTextMin:95, grayTextMax:235, grayBgMax:84,
        coarseThreshold:0.57, coarseBgMin:0.42,
        finalThreshold:0.60, finalBgMin:0.44,
        searchRegions,
        existingBoxes
      });
      const mapped=(searched.candidates||[]).map(c=>mapItalicCandidateToOriginal(c,searchScale));
      searched.candidates=mapped;
      searched.label=`H${h}→${scaledH} / skew ${skew.toFixed(2)}`;
      searched.key=`h${h}_s${Math.round(skew*100)}`;
      searched.color='#f59e0b';
      searched.italic=true;
      searched.contrast=true;
      searched.targetHeight=h;
      searched.searchTargetHeight=scaledH;
      searched.skew=skew;
      searched.searchScale=searchScale;
      searched.searchCanvasWidth=contrast.sw;
      searched.searchCanvasHeight=contrast.sh;
      variants.push(searched);
    }
  }

  const mergedRaw=[];
  for(const v of variants){
    for(const c of (v.candidates||[])){
      mergedRaw.push({...c, label:v.label, key:v.key, color:v.color, targetHeight:v.targetHeight, searchTargetHeight:v.searchTargetHeight, skew:v.skew});
    }
  }
  const merged=dedupeTemplateCandidates(mergedRaw, 12);
  return {
    variants, merged,
    searchScale,
    searchCanvasWidth:contrast.sw,
    searchCanvasHeight:contrast.sh,
    resized:searchBase.resized
  };
}

function collectItalicRescueCandidates(source, text, existingBoxes=[], variantHeights=ITALIC_VARIANT_HEIGHTS, detected=null, coordScale=1){
  const regions=(detected?.regions||[]).filter(r=>r && r.w>0 && r.h>0);
  const scaleBoxToSource = o => ({
    ...o,
    x:(o.x ?? o.x0 ?? 0)*coordScale,
    y:(o.y ?? o.y0 ?? 0)*coordScale,
    w:(o.w ?? ((o.x1??0)-(o.x0??0)))*coordScale,
    h:(o.h ?? ((o.y1??0)-(o.y0??0)))*coordScale
  });
  const mapCandidateToOriginal = c => ({
    ...c,
    x:Math.round(c.x/coordScale),
    y:Math.round(c.y/coordScale),
    w:Math.max(1,Math.round(c.w/coordScale)),
    h:Math.max(1,Math.round(c.h/coordScale))
  });
  const accepted=[];
  const acceptedBoxes=[...existingBoxes];
  const existingBoxesSource=(existingBoxes||[]).map(scaleBoxToSource);
  const acceptedBoxesSource=[...existingBoxesSource];
  const passes=[];
  let scoredPositions=0;
  let skippedExisting=0;

  function overlapsExisting(c, boxes=acceptedBoxes){
    return boxes.some(o=>{
      const ox=o.x ?? o.x0 ?? 0;
      const oy=o.y ?? o.y0 ?? 0;
      const ow=o.w ?? ((o.x1??0)-(o.x0??0));
      const oh=o.h ?? ((o.y1??0)-(o.y0??0));
      const ix0=Math.max(ox,c.x), iy0=Math.max(oy,c.y);
      const ix1=Math.min(ox+ow,c.x+c.w), iy1=Math.min(oy+oh,c.y+c.h);
      if(ix1<=ix0||iy1<=iy0) return false;
      const inter=(ix1-ix0)*(iy1-iy0);
      const minArea=Math.min(Math.max(1,ow*oh),c.w*c.h);
      return inter/minArea>=0.35;
    });
  }

  function runPass(label, searchConfig={}){
    const sourceResult=italicVariantDiagnosticSearch(source,text,variantHeights,searchConfig);
    const result={
      ...sourceResult,
      variants:(sourceResult.variants||[]).map(v=>({
        ...v,
        candidates:(v.candidates||[]).map(mapCandidateToOriginal)
      })),
      merged:(sourceResult.merged||[]).map(mapCandidateToOriginal)
    };
    passes.push({label, result});
    const variants=sourceResult.variants||[];
    scoredPositions+=variants.reduce((n,v)=>n+(v.scoredPositionCount||0),0);
    skippedExisting+=variants.reduce((n,v)=>n+(v.skippedExistingCount||0),0);
    for(const c of (sourceResult.merged||[])){
      if(c.score<ITALIC_RESCUE_SCORE_MIN) continue;
      if(c.fgScore<ITALIC_RESCUE_FG_MIN) continue;
      if(c.bgScore<ITALIC_RESCUE_BG_MIN) continue;
      if(overlapsExisting(c, acceptedBoxesSource)) continue;
      const mapped=mapCandidateToOriginal(c);
      accepted.push({...mapped, source:"イタリック救出", passLabel:label});
      acceptedBoxes.push({x:mapped.x,y:mapped.y,w:mapped.w,h:mapped.h});
      acceptedBoxesSource.push({x:c.x,y:c.y,w:c.w,h:c.h});
      if(accepted.length>=ITALIC_RESCUE_MAX_NEW) break;
    }
  }

  if(regions.length){
    // 先に文字領域を優先探索し、その後は未検出部分だけ全画面で補完する。
    runPass("文字領域優先", {searchRegions:regions, existingBoxes:acceptedBoxesSource});
    if(accepted.length<ITALIC_RESCUE_MAX_NEW){
      runPass("全画面補完", {existingBoxes:acceptedBoxesSource});
    }
  }else{
    runPass("全画面", {existingBoxes:acceptedBoxesSource});
  }

  return {
    result: passes[0]?.result || {variants:[], merged:[]},
    passes,
    accepted,
    searchMode: regions.length ? "文字領域優先＋全画面補完" : "全画面",
    searchRegionCount: regions.length,
    scoredPositions,
    skippedExisting
  };
}

// ===== /イタリック補助探索 =====



async function diagnoseOCR(){
  ocrDiagnostics.hidden=false;
  ocrDebugLayer.hidden=true;
  ocrDebugLayer.innerHTML="";
  canvas.hidden=false;
  canvas.style.display='block';
  try{
    if(!sourceImage)throw new Error("先に画像を選択してください。");
    const target=normalize(targetText.value);
    if(!target)throw new Error("黒塗りする文字を入力してください。");
    saveTargetHistoryEntry(targetText.value);
    const totalStarted=performance.now();
    const worker=await getWorker(getOcrLanguage(target));
    canvas.hidden=false; canvas.style.display="block";
    status("OCR診断中…\n認識条件を比較しています。画像表示は維持します。");
    const ocrStarted=performance.now();
    const analysisState=buildAnalysisCanvas();
    const {results,scale,ocrCanvas,stats,analysisCanvas,analysisScale}=await collectOcrResults(worker,target,analysisState);
    const diagnosticTextRegions=detectTextLikeRegions(analysisCanvas);
    const diagnosticItalicHeightChoice=chooseItalicVariantHeights(results,target,analysisScale);
    const diagnosticItalicHeights=diagnosticItalicHeightChoice.heights;
    const italicVariantResult=italicVariantDiagnosticSearch(analysisCanvas,target,diagnosticItalicHeights,{},ITALIC_DIAGNOSTIC_SKEWS);
    italicVariantResult.variants=(italicVariantResult.variants||[]).map(v=>({...v,candidates:(v.candidates||[]).map(c=>({...c,x:Math.round(c.x/analysisScale),y:Math.round(c.y/analysisScale),w:Math.max(1,Math.round(c.w/analysisScale)),h:Math.max(1,Math.round(c.h/analysisScale))}))}));
    italicVariantResult.merged=(italicVariantResult.merged||[]).map(c=>({...c,x:Math.round(c.x/analysisScale),y:Math.round(c.y/analysisScale),w:Math.max(1,Math.round(c.w/analysisScale)),h:Math.max(1,Math.round(c.h/analysisScale))}));
    const italicProductionPreview=collectItalicRescueCandidates(analysisCanvas,target,[],diagnosticItalicHeights,diagnosticTextRegions,analysisScale);
    const ocrElapsed=performance.now()-ocrStarted;
    const refineStarted=performance.now();
    const refine=await refineNearCandidates(worker,results,ocrCanvas,target,scale);
    const refineElapsed=performance.now()-refineStarted;
    const {groups:candidateGroups,refined,acceptedNear}=refine;
    // V70.1: 診断側でも文脈救出結果を必ず初期化する。
    // 実処理(run)では局所OCR結果も渡すが、診断ではここまでで局所OCRを
    // 実行していないため、まず全体OCRだけを対象にする。
    const totalElapsed=performance.now()-totalStarted;
    const exactCount=results.reduce((n,r)=>n+r.matches.length,0);
    const candidateCount=results.reduce((n,r)=>n+r.near.length,0);
    const lines=[`対象文字：${targetText.value}`,`正規化後：${target}`,`OCR境界線：${OCR_BORDER_PX}px（白）`,""];
    for(const r of results){
      lines.push(`===== ${r.mode} / PSM 11 =====`,`HIT：${r.matches.length}件`);
      for(const m of r.matches){
        const b={x0:m.x0,y0:m.y0,x1:m.x1,y1:m.y1};
        lines.push(`  HIT行：「${m.lineText}」`,`    target bbox=(${b.x0},${b.y0})-(${b.x1},${b.y1})`);
        m.symbols.forEach((s,i)=>{const q=s.bbox;const src=s.bboxSource==="word-split"?" / word均等分割":"";lines.push(`      symbol[${i}] 「${s.ch}」 raw=「${s.raw}」 bbox=(${q.x0},${q.y0})-(${q.x1},${q.y1})${src}`);});
      }
      if(r.near.length)lines.push(`近似候補：${r.near.map(x=>`「${x.candidate}」${Math.round(x.similarity*100)}%`).join(" / ")}`);
      lines.push(`認識テキスト：${r.rawText.replace(/\n/g," / ")}`,"");
    }
    lines.push(`===== 候補地点の統合 =====`, `候補地点：${candidateGroups.length}箇所 / 個別候補：${candidateCount}件`);
    candidateGroups.forEach((g,i)=>{
      const best=Math.max(...g.candidates.map(c=>c.similarity));
      const names=[...new Set(g.candidates.map(c=>c.candidate))].slice(0,8);
      const alreadyHit=groupTouchesExactHit(g,results);
      const recoveryPreview=[...g.candidates].filter(c=>[...c.candidate].length===[...target].length).map(c=>({c,d:editDistance(target,c.candidate)})).filter(x=>x.d<=1).sort((a,b)=>a.d-b.d||b.c.similarity-a.c.similarity)[0];
      const preview=recoveryPreview?` / 1文字誤認候補「${recoveryPreview.c.candidate}」距離${recoveryPreview.d}`:'';
      lines.push(`  地点${i+1}: 候補${g.candidates.length}件 / 前処理${g.modes.size}種 / 最高${Math.round(best*100)}% / ${alreadyHit?'既存HITあり・再OCR省略':'再OCR対象'} / ${names.map(x=>`「${x}」`).join('・')}${preview}`);
    });
    lines.push("",`===== 候補地点の再OCR =====`);
    if(refined.length){
      for(const x of refined){
        const detail=x.hits.map(h=>`${h.text} [${h.mode}/PSM${h.psm}]`).join(' / ');
        lines.push(`再OCR HIT：「${x.refinedText}」 / 元候補「${x.candidate}」 / 同地点候補${x.candidateCount}件 / ${detail}`);
      }
    }
    if(acceptedNear.length){
      for(const x of acceptedNear){
        lines.push(`近似候補救出：「${target}」として採用 / OCR候補「${x.candidate}」 / 編集距離${x.recoveryDistance} / 類似度${Math.round(x.similarity*100)}% / 同地点候補${x.candidateCount}件 / 強候補${x.strongCandidateCount}件${x.threeCharConsensus?` / 3文字救出・同誤認${x.threeCharGlobalSpotCount||0}地点`:""}`);
      }
    }
    if(!refined.length && !acceptedNear.length) lines.push('再OCR・近似候補救出で対象文字を確認できた候補地点はありません。');

    lines.push("",`===== 完全一致の最終黒塗り位置 =====`);
    const exactMatches=mergeMatches(results);
    const verifyStarted=performance.now();
    let changedCount=0;
    for(const m of exactMatches){
      const before={x:m.x0,y:m.y0,w:m.x1-m.x0,h:m.y1-m.y0};
      const after=before;
      const moved=Math.abs(after.x-before.x)>1||Math.abs(after.y-before.y)>1||Math.abs(after.w-before.w)>1||Math.abs(after.h-before.h)>1;
      if(moved)changedCount++;
      const bboxNote=(m.symbols||[]).some(s=>s.bboxSource==="word-split")?" / symbol異常→word均等分割":"";
      const paintBox=getOcrPaintBox(after,m.symbols||[]);
      const widthGuardNote=paintBox.shortNameWidthGuard?` / 短名幅ガード ${Math.round(paintBox.originalWidth)}→${Math.round(paintBox.w)}px（左端固定）`:"";
      lines.push(`「${m.lineText}」： 元bbox=(${Math.round(before.x)},${Math.round(before.y)},w${Math.round(before.w)},h${Math.round(before.h)}) → 使用bbox=(${Math.round(after.x)},${Math.round(after.y)},w${Math.round(after.w)},h${Math.round(after.h)}) ${moved?'※位置を修正':'変更なし'}${bboxNote}${widthGuardNote}`);
      // 実際に黒塗りが描画される最終矩形も、同じ計算式で再現。
      const finalRect=getOcrVisualRect(after, m.symbols||[]);
      const widthNormNote=finalRect.shortNameWidthNormalized ? ` / 短名幅正常化:${finalRect.shortNameWidthNormalized}` : '';
      lines.push(`　→ 最終黒塗り座標=(${Math.round(finalRect.x)},${Math.round(finalRect.y)},w${Math.round(finalRect.w)},h${Math.round(finalRect.h)})${widthNormNote}${finalRect.w<=4?' ※幅が極端に狭い(縦棒の疑いあり)':''}`);
    }
    const verifyElapsed=performance.now()-verifyStarted;
    lines.push(`検証時間：${(verifyElapsed/1000).toFixed(2)}秒 / 修正：${changedCount}件 / 対象：${exactMatches.length}件`);

    // 診断でも本番と同じ文字領域検出を使って局所OCR結果を確認する。
    lines.push("",`===== 文字領域全走査＋局所OCR =====`);
    const regionResult=await runTextRegionExperiment(worker,analysisCanvas,target,analysisScale);
    lines.push(`検出候補：${regionResult.detected.regions.length}領域 / 局所OCR実行：${regionResult.tested.length}領域 / 走査間隔：${regionResult.detected.sample}px / 通常：2倍・PSM7`);
    lines.push(`追加前処理：なし / 追加OCR実行：0回`);
    const regionHits=regionResult.tested.filter(r=>r.hit);
    const baseHits=regionResult.tested.filter(r=>r.baseHit);
    const extraHits=regionResult.tested.filter(r=>r.extraHit);
    lines.push(`対象文字HIT：${regionHits.length}領域（通常OCR：${baseHits.length} / 前処理追加：${extraHits.length}）`);
    regionResult.tested.forEach((r,i)=>{
      const hitModes=r.variants.filter(v=>v.hit).map(v=>v.mode);
      const display=hitModes.length?`★対象HIT [${hitModes.join('・')}]`:'HITなし';
      const rawPreview=r.variants.map(v=>`${v.mode}「${v.raw.length>55?v.raw.slice(0,55)+'…':v.raw}」`).join(' / ');
      lines.push(`  領域${i+1}: (${r.x},${r.y},w${r.w},h${r.h}) / ${r.mode} / ${display} / ${rawPreview}`);
    });
    lines.push(`局所OCR時間：${(regionResult.elapsed/1000).toFixed(2)}秒`);
    lines.push(`色抽出OCR：${stats.colorHitCount||0}件 / ${(stats.colorMs/1000).toFixed(2)}秒`);
    lines.push(`※ この局所OCRのHITは、自動黒塗り候補にも統合します。`);

    lines.push("",`===== イタリック救出診断 =====`);
    lines.push(`解析キャンバス：${analysisCanvas.width}x${analysisCanvas.height} / scale ${analysisScale.toFixed(3)}${analysisState.resized ? "（統一縮小）" : "（原寸）"}`);
    lines.push(`方式：コントラスト補正 → イタリックテンプレート / 粗探索${ITALIC_COARSE_STEP}px → 局所再探索${ITALIC_REFINE_STEP}px`);
    lines.push(`探索キャンバス：${italicVariantResult.searchCanvasWidth}x${italicVariantResult.searchCanvasHeight} / scale ${italicVariantResult.searchScale.toFixed(3)}${italicVariantResult.resized ? "（縮小）" : "（原寸）"}`);
    lines.push(`テンプレート高さ推定：${diagnosticItalicHeightChoice.source} ${diagnosticItalicHeightChoice.sampleCount}件${Number.isFinite(diagnosticItalicHeightChoice.basis)?` / 中央値 ${diagnosticItalicHeightChoice.basis.toFixed(1)}px`:''}`);
    lines.push(`テンプレートバリエーション：解析基準 ${diagnosticItalicHeights.join("/")}px → 探索時はscale連動 × 診断傾き ${ITALIC_DIAGNOSTIC_SKEWS.map(v=>v.toFixed(2)).join("/")}（本番は ${ITALIC_VARIANT_SKEWS.map(v=>v.toFixed(2)).join("/")}）`);
    const firstVariant=italicVariantResult.variants?.[0];
    lines.push(`探索範囲：x=${firstVariant?.searchXStart||0}〜${firstVariant?.searchXEnd||0} / y=${firstVariant?.searchYStart||0}〜${firstVariant?.searchYEnd||0}`);
    for(const v of (italicVariantResult.variants||[])){
      lines.push(`【${v.label}】 テンプレート:${v.tpl?.w||0}x${v.tpl?.h||0}px / 粗候補${v.coarsePassCount||0}件 / 最終${v.candidates?.length||0}件`);
      (v.candidates||[]).slice(0,3).forEach((c,i)=>lines.push(`  候補${i+1}: score ${c.score.toFixed(3)} / 形状${c.fgScore.toFixed(3)} / 背景${c.bgScore.toFixed(3)} / (${c.x},${c.y},w${c.w},h${c.h})`));
    }
    lines.push(`最終候補：${italicVariantResult.merged?.length||0}件`);
    (italicVariantResult.merged||[]).slice(0,10).forEach((c,i)=>lines.push(`  統合候補${i+1}: score ${c.score.toFixed(3)} / 形状${c.fgScore.toFixed(3)} / 背景${c.bgScore.toFixed(3)} / ${c.label} / (${c.x},${c.y},w${c.w},h${c.h})`));
    lines.push(`本番採用候補：${italicProductionPreview.accepted.length}件 / 条件 score≥${ITALIC_RESCUE_SCORE_MIN.toFixed(2)}・形状≥${ITALIC_RESCUE_FG_MIN.toFixed(2)}・背景≥${ITALIC_RESCUE_BG_MIN.toFixed(2)}`);
    (italicProductionPreview.accepted||[]).slice(0,10).forEach((c,i)=>lines.push(`  本番候補${i+1}: score ${c.score.toFixed(3)} / 形状${c.fgScore.toFixed(3)} / 背景${c.bgScore.toFixed(3)} / (${c.x},${c.y},w${c.w},h${c.h})`));
    lines.push(`※ 3文字名の1文字誤認（例：コカゲ→コカグ）は、同じ誤認が複数地点で確認できた場合に近似候補救出します。オレンジ枠は本番採用候補だけです。`);


    lines.push("",`===== 処理時間 =====`,
      `OCR全体：${(ocrElapsed/1000).toFixed(2)}秒`,
      `  第1段階（グレー＋コントラスト）：${(stats.primaryMs/1000).toFixed(2)}秒 / HIT ${stats.primaryHitCount}件`,
      `  追加全体OCR：${stats.fallbackUsed ? (stats.fallbackMs/1000).toFixed(2)+"秒 / "+stats.fallbackReason : (stats.fallbackSkippedForSpeed ? "0.00秒 / "+stats.fallbackReason : "0.00秒 / 不要")}`,
      `候補再OCR：${(refineElapsed/1000).toFixed(2)}秒`,
      `診断全体：${(totalElapsed/1000).toFixed(2)}秒`,
      `候補地点：${candidateGroups.length} / 色抽出HIT：${stats.colorHitCount||0} / 近似候補救出：${refine.fastRecovered} / 再OCR実行：${refine.attempted} / 再OCR追加パス：${refine.extraPasses} / 既存HITで省略：${refine.skippedExact}`,
      "",
      `※ 全画面OCRはグレー＋コントラストを主経路にし、重いfallbackは省略します。`,
      `※ イタリック救出は文字領域を先に確認し、既存HITを除外しながら全画面を補完探索します。`,
      `※ 解析処理は先に基準キャンバスへ揃えてから実行し、最後に元画像座標へ戻しています。`,
      `※ 大画像や強い近似候補がある場合は全画面fallbackを省略し、後段の局所救出へ進みます。`,
      `※ 候補地点は同じ位置付近の候補をまとめています。`,
      `※ 近似候補は、対象文字と同じ文字数で、3文字以上の対象なら「対象の1文字違い」程度を先に救出します。
※ 近似候補の黒塗り範囲は、候補地点全体ではなく採用候補自身のbboxを使います。`,
      `※ 近似候補救出は再OCRより先に判定し、時間を増やしにくい構成です。`,
      `※ 再OCRは近似候補救出で確定できなかった地点だけ実行します。`,
      `※ 診断で救出した候補は、自動黒塗りにも使用されます。`
    );
    ocrDiagnostics.textContent=lines.join("\n");
    canvas.hidden=false; canvas.style.display='block';
    const tr=getCanvasDisplayTransform(),seen=[];
    for(const r of results)for(const m of r.matches){
      if(seen.some(o=>Math.abs(o.x0-m.x0)<3&&Math.abs(o.y0-m.y0)<3&&Math.abs(o.x1-m.x1)<3&&Math.abs(o.y1-m.y1)<3))continue;
      seen.push(m);
      const rawBox={x:m.x0,y:m.y0,w:m.x1-m.x0,h:m.y1-m.y0};
      const finalRect=getOcrVisualRect(rawBox,m.symbols||[]);
      const box=document.createElement('div');
      box.className='ocr-debug-box'; box.style.borderColor='#22aa55';
      box.style.left=`${tr.left+finalRect.x*tr.scaleX}px`;
      box.style.top=`${tr.top+finalRect.y*tr.scaleY}px`;
      box.style.width=`${finalRect.w*tr.scaleX}px`;
      box.style.height=`${finalRect.h*tr.scaleY}px`;
      const label=document.createElement('span'); label.className='ocr-debug-label'; label.textContent=`${r.mode}: ${target}`;
      box.appendChild(label); ocrDebugLayer.appendChild(box);
    }
    // オレンジ枠は「本番で実際に採用される候補」だけ表示する。
    // 閾値未満の生候補は診断テキストには残すが、画像上には出さない。
    for(const c of (italicProductionPreview.accepted||[])){
      const box=document.createElement('div');
      box.className='ocr-debug-box'; box.style.borderColor=c.color||'#f59e0b';
      box.style.left=`${tr.left+c.x*tr.scaleX}px`; box.style.top=`${tr.top+c.y*tr.scaleY}px`;
      box.style.width=`${c.w*tr.scaleX}px`; box.style.height=`${c.h*tr.scaleY}px`;
      const label=document.createElement('span'); label.className='ocr-debug-label';
      label.textContent=`イタリック候補 ${c.score.toFixed(2)}`;
      box.appendChild(label); ocrDebugLayer.appendChild(box);
    }

    ocrDebugLayer.hidden=ocrDebugLayer.childElementCount===0;
    status(`OCR診断完了。\n検出：${exactCount}件（重複を含む） / 候補地点：${candidateGroups.length}箇所 / 再OCR確認：${refined.length}箇所\n処理時間：${(totalElapsed/1000).toFixed(2)}秒\n下の診断結果を確認してください。`);
  }catch(error){canvas.hidden=false;canvas.style.display='block';status("OCR診断でエラーが発生しました。",error);}
}
function getCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height
    };
}

// canvas が中央寄せ・ズーム・スクロールされていても、
// canvasWrap 内の「実際に見えているcanvas」の位置と表示倍率を正しく取得する。
// offsetLeft / offsetTop は margin:auto やスクロールの影響を受けるため使わない。
function getCanvasDisplayTransform() {
    const canvasRect = canvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    return {
        left: canvasRect.left - wrapRect.left + canvasWrap.scrollLeft,
        top: canvasRect.top - wrapRect.top + canvasWrap.scrollTop,
        scaleX: canvasRect.width / canvas.width,
        scaleY: canvasRect.height / canvas.height
    };
}

function updateSelection(start, current) {
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const w = Math.abs(current.x - start.x);
    const h = Math.abs(current.y - start.y);

    const transform = getCanvasDisplayTransform();

    selection.hidden = false;
    selection.style.left = `${transform.left + x * transform.scaleX}px`;
    selection.style.top = `${transform.top + y * transform.scaleY}px`;
    selection.style.width = `${w * transform.scaleX}px`;
    selection.style.height = `${h * transform.scaleY}px`;
}

function getTraceCanvasHeight() {
    if (!canvas.width || !canvas.height) return TRACE_DISPLAY_HEIGHT_PX;
    const base = getBaseDisplaySize();
    const baseScaleY = Math.max(0.0001, base.height / canvas.height);
    // 画像が縮小表示されているほど、元画像側では太い矩形にする。
    // zoom値は使わない。通常は32px相当、高解像度画像でも最大44pxまでに抑える。
    return Math.max(32, Math.min(44, TRACE_DISPLAY_HEIGHT_PX / baseScaleY));
}

function getTraceRect(start, current) {
    const x = Math.min(start.x, current.x);
    const w = Math.abs(current.x - start.x);
    const h = getTraceCanvasHeight();
    // Yは開始地点を基準に固定。指が上下にぶれても黒塗りが蛇行しない。
    const y = Math.max(0, Math.min(canvas.height - h, start.y - h / 2));
    return { x, y, w, h };
}

function updateTraceSelection(start, current) {
    const rect = getTraceRect(start, current);
    const transform = getCanvasDisplayTransform();
    selection.hidden = false;
    selection.style.left = `${transform.left + rect.x * transform.scaleX}px`;
    selection.style.top = `${transform.top + rect.y * transform.scaleY}px`;
    selection.style.width = `${rect.w * transform.scaleX}px`;
    selection.style.height = `${rect.h * transform.scaleY}px`;
}

function startManualMode() {
    if (!sourceImage) return;
    manualMode = true;
    document.body.classList.add("manual-mode");
    manualDoneBtn.hidden = false;
    manualBtn.disabled = true;
    updateStampModeUI();
    status(`手動黒塗りモードです。\n描画方法：${manualDrawMode?.value === "trace" ? "なぞり式" : "自由矩形"}`);
}

function stopManualMode() {
    manualMode = false;
    document.body.classList.remove("manual-mode");
    isDragging = false;
    dragStart = null;
    stampTapStart = null;
    selection.hidden = true;
    hideManualDeleteButton();
    if (stampMode) stampMode.checked = false;
    manualDoneBtn.hidden = true;
    manualBtn.disabled = !sourceImage;
    updateStampModeUI();
    if (sourceImage) status(`手動黒塗り終了：追加した黒塗り ${manualStamps.length}箇所`);
}

function placeStampAt(point) {
    if (!manualStamps.length) return;

    const last = getLastManualStamp();
    if (!last) return;
    const stamp = {
        x: point.x - last.w / 2,
        y: point.y - last.h / 2,
        w: last.w,
        h: last.h,
        style: getCurrentRedactionStyle(),
        kind: "manual"
    };

    stamp.x = Math.max(0, Math.min(canvas.width - stamp.w, stamp.x));
    stamp.y = Math.max(0, Math.min(canvas.height - stamp.h, stamp.y));

    pushManualHistory();
    manualStamps.push(stamp);
    paintManual(stamp, stamp.style);
    updateUndoButton();
    saveBtn.disabled = false;
    status(`スタンプを追加しました。\n追加済み：${manualStamps.length}箇所`);
}

function finishStamp(point) {
    if (!dragStart) return;

    let x, y, w, h;
    if (manualDrawMode?.value === "trace") {
        const rect = getTraceRect(dragStart, point);
        ({ x, y, w, h } = rect);
    } else {
        x = Math.min(dragStart.x, point.x);
        y = Math.min(dragStart.y, point.y);
        w = Math.abs(point.x - dragStart.x);
        h = Math.abs(point.y - dragStart.y);
    }
    selection.hidden = true;

    // なぞり式は高さ固定なので横幅だけ最低サイズを確認。
    if (w < MIN_MANUAL_SIZE || h < MIN_MANUAL_SIZE) {
        dragStart = null;
        return;
    }

    const stamp = { x, y, w, h, style: getCurrentRedactionStyle(), kind: "manual" };
    pushManualHistory();
    manualStamps.push(stamp);
    paintManual(stamp, stamp.style);
    updateUndoButton();
    saveBtn.disabled = false;
    status(`${manualDrawMode?.value === "trace" ? "なぞり式" : "手動"}黒塗りを追加しました。\n追加済み：${manualStamps.length}箇所`);
    dragStart = null;
}

function getRawManualPoint(event) {
    return getCanvasPoint(event);
}

// 新規描画時の指オフセットは画面表示上のCSS pxをcanvas座標へ変換する。
// これにより等倍・拡大時のどちらでも、指から見た描画位置を同じ感覚に保つ。
// 横方向は自由矩形・なぞり式とも指の実位置に合わせ、Y方向だけ上へずらす。
function getManualDrawPoint(event) {
    if (event.pointerType !== "touch") return getRawManualPoint(event);

    const raw = getRawManualPoint(event);
    const transform = getCanvasDisplayTransform();
    const scaleY = Math.max(0.0001, transform.scaleY);

    return {
        x: raw.x,
        y: raw.y + TOUCH_Y_OFFSET_SCREEN_PX / scaleY
    };
}

function getManualPoint(event, applyOffset = true) {
    return applyOffset ? getManualDrawPoint(event) : getRawManualPoint(event);
}

function getTraceManualPoint(event) {
    return getManualDrawPoint(event);
}

function getPointerCenter() {
    const values = [...pointers.values()];
    if (!values.length) return null;
    return {
        x: values.reduce((sum, p) => sum + p.x, 0) / values.length,
        y: values.reduce((sum, p) => sum + p.y, 0) / values.length
    };
}

function resetManualGestureState() {
    pointers.clear();
    pinchStartDistance = 0;
    pinchStartZoom = zoom;
    panLastCenter = null;
    isDragging = false;
    dragStart = null;
    stampTapStart = null;
    editMode = null;
}

function deleteSelectedManualStamp() {
    if (selectedManualIndex < 0 || !manualStamps[selectedManualIndex]) return;
    pushManualHistory();
    manualStamps.splice(selectedManualIndex, 1);
    selectedManualIndex = -1;
    resetManualGestureState();
    hideManualDeleteButton();
    redrawFromBase();
    saveBtn.disabled = false;
    status(`選択した黒塗りを削除しました。\n残り：${manualStamps.length}箇所`);
}

// ×ボタンはselection/ハンドルとは完全に別要素。
// pointerdown/pointerupの時点でcanvas側への伝播を止め、clickで削除する。
manualDeleteBtn?.addEventListener("pointerdown", event => {
    event.preventDefault();
    event.stopPropagation();
    // ×操作はcanvasのポインタ追跡と完全に切り離す。
    resetManualGestureState();
});

manualDeleteBtn?.addEventListener("pointerup", event => {
    event.preventDefault();
    event.stopPropagation();
});

manualDeleteBtn?.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    deleteSelectedManualStamp();
});

canvasWrap.addEventListener("pointerdown", event => {
    if (!sourceImage) return;

    // iOS Safariで×削除後に古いpointerIdが残るケースを防ぐ。
    // 新しい1本指操作の開始時に、前ジェスチャーの残骸だけなら破棄する。
    if (event.pointerType === "touch" && event.isPrimary && !isDragging && !panLastCenter && pinchStartDistance === 0) {
        pointers.clear();
    }

    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvasWrap.setPointerCapture?.(event.pointerId);

    if (pointers.size >= 2) {
        isDragging = false;
        dragStart = null;
        selection.hidden = true;
        hideManualDeleteButton();
        pinchStartDistance = getPointerDistance();
        pinchStartZoom = zoom;
        panLastCenter = getPointerCenter();
        event.preventDefault();
        return;
    }

    panLastCenter = null;
    pinchStartDistance = 0;

    if (!manualMode) return;
    event.preventDefault();

    // 新しい操作開始時はいったん削除ボタンを消す。
    // 既存黒塗りを選択した場合だけ、この後 renderManualSelection() で再表示する。
    hideManualDeleteButton();

    const rawPoint = getRawManualPoint(event);

    // 既存の手動黒塗りをタップすると編集対象にする。
    // 編集時はオフセットを使わず、指の位置をそのまま操作位置にする。
    // スタンプモード中でも、まず既存黒塗りの編集を優先する。
    const editTarget = findManualEditTarget(rawPoint);
    if (editTarget) {
        dragStart = rawPoint;
        selectedManualIndex = editTarget.index;
        const hitStamp = manualStamps[editTarget.index];
        editMode = {
            type: editTarget.type,
            handle: editTarget.handle,
            startPoint: { ...dragStart },
            original: { ...hitStamp },
            historyPushed: false
        };
        isDragging = true;
        renderManualSelection();
        status(editTarget.type === "resize"
            ? "黒塗りの角を掴みました。\nドラッグでサイズ変更できます。"
            : "黒塗りを掴みました。\nドラッグで移動できます。");
        return;
    }

    selectedManualIndex = -1;
    editMode = null;
    renderManualSelection();

    const isStampPlacement = stampMode.checked && getLastManualStamp();

    // スタンプ配置は「ここに置きたい」というタップ位置を最優先し、オフセットを使わない。
    // 通常の手動描画だけY方向のオフセットを使う。
    dragStart = isStampPlacement
        ? getRawManualPoint(event)
        : (manualDrawMode?.value === "trace"
            ? getTraceManualPoint(event)
            : getManualPoint(event, true));

    if (isStampPlacement) {
        stampTapStart = { x: event.clientX, y: event.clientY };
        isDragging = false;
        const last = getLastManualStamp();
        updateSelection(
            { x: dragStart.x - last.w / 2, y: dragStart.y - last.h / 2 },
            { x: dragStart.x + last.w / 2, y: dragStart.y + last.h / 2 }
        );
        return;
    }

    isDragging = true;
    if (manualDrawMode?.value === "trace") updateTraceSelection(dragStart, dragStart);
    else updateSelection(dragStart, dragStart);
});

canvasWrap.addEventListener("pointermove", event => {
    // PCでmouseupを取りこぼしても、ボタンを離したマウスには追従しない。
    if (event.pointerType === "mouse" && event.buttons === 0 && isDragging && editMode) {
        isDragging = false;
        dragStart = null;
        editMode = null;
        pointers.delete(event.pointerId);
        renderManualSelection();
        return;
    }

    if (pointers.has(event.pointerId)) {
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (pointers.size >= 2) {
        const distance = getPointerDistance();
        const center = getPointerCenter();
        if (pinchStartDistance > 0 && distance > 0) {
            setZoom(pinchStartZoom * distance / pinchStartDistance);
        }
        if (center && panLastCenter) {
            canvasWrap.scrollLeft -= center.x - panLastCenter.x;
            canvasWrap.scrollTop -= center.y - panLastCenter.y;
        }
        panLastCenter = center;
        event.preventDefault();
        return;
    }

    if (!manualMode) return;
    event.preventDefault();

    if (editMode && selectedManualIndex >= 0 && isDragging) {
        const point = getManualPoint(event, false);
        if (!editMode.historyPushed) {
            pushManualHistory();
            editMode.historyPushed = true;
        }
        if (editMode.type === "move") applyMoveEdit(point);
        else applyResizeEdit(point);
        redrawFromBase();
        return;
    }

    if (stampMode.checked && stampTapStart && getLastManualStamp()) {
        const point = getRawManualPoint(event);
        const last = getLastManualStamp();
        updateSelection(
            { x: point.x - last.w / 2, y: point.y - last.h / 2 },
            { x: point.x + last.w / 2, y: point.y + last.h / 2 }
        );
        return;
    }

    if (!isDragging || !dragStart) return;
    const point = manualDrawMode?.value === "trace"
        ? getTraceManualPoint(event)
        : getManualPoint(event, true);
    if (manualDrawMode?.value === "trace") updateTraceSelection(dragStart, point);
    else updateSelection(dragStart, point);
});

function endPointer(event) {
    pointers.delete(event.pointerId);

    if (pointers.size >= 1) {
        isDragging = false;
        dragStart = null;
        selection.hidden = true;
        panLastCenter = getPointerCenter();
        return;
    }

    panLastCenter = null;

    if (!manualMode) return;
    event.preventDefault();

    if (editMode && selectedManualIndex >= 0 && isDragging) {
        const point = getManualPoint(event, false);
        if (!editMode.historyPushed) {
            pushManualHistory();
            editMode.historyPushed = true;
        }
        if (editMode.type === "move") applyMoveEdit(point);
        else applyResizeEdit(point);

        // PCマウスではpointerup後もeditMode/isDraggingが残ると、
        // カーソル移動だけで黒塗りが追従し続ける。
        // 選択状態だけ残し、ドラッグ状態はここで必ず終了する。
        isDragging = false;
        dragStart = null;
        editMode = null;
        redrawFromBase();
        renderManualSelection();
        return;
    }

    if (stampMode.checked && stampTapStart && getLastManualStamp()) {
        const moved = Math.hypot(event.clientX - stampTapStart.x, event.clientY - stampTapStart.y);
        const point = getRawManualPoint(event);
        stampTapStart = null;
        selection.hidden = true;
        dragStart = null;
        isDragging = false;
        if (moved < 12) placeStampAt(point);
        return;
    }

    if (!isDragging || !dragStart) return;
    isDragging = false;
    finishStamp(
        manualDrawMode?.value === "trace"
            ? getTraceManualPoint(event)
            : getManualPoint(event)
    );
}

canvasWrap.addEventListener("pointerup", endPointer);
canvasWrap.addEventListener("lostpointercapture", event => {
    if (event.pointerType !== "mouse") return;
    pointers.delete(event.pointerId);
    if (isDragging && editMode) {
        isDragging = false;
        dragStart = null;
        editMode = null;
        renderManualSelection();
    }
});
canvasWrap.addEventListener("dblclick", event => {
    if (!manualMode || selectedManualIndex < 0 || !manualStamps[selectedManualIndex]) return;
    const point = getRawManualPoint(event);
    if (hitTestManual(point) !== selectedManualIndex) return;
    pushManualHistory();
    manualStamps.splice(selectedManualIndex, 1);
    selectedManualIndex = -1;
    editMode = null;
    redrawFromBase();
    saveBtn.disabled = false;
    status(`選択した黒塗りを削除しました。\n残り：${manualStamps.length}箇所`);
});

canvasWrap.addEventListener("pointercancel", event => {
    pointers.delete(event.pointerId);
    panLastCenter = pointers.size ? getPointerCenter() : null;
    isDragging = false;
    dragStart = null;
    stampTapStart = null;
    if (!pointers.size) pinchStartDistance = 0;
    selection.hidden = true;
    hideManualDeleteButton();
});

function openManualHelp() {
    if (!manualHelpDialog) return;
    manualHelpDialog.hidden = false;
    document.body.classList.add("help-dialog-open");
    manualHelpCloseBtn?.focus();
}

function closeManualHelp() {
    if (!manualHelpDialog || manualHelpDialog.hidden) return;
    manualHelpDialog.hidden = true;
    document.body.classList.remove("help-dialog-open");
    manualHelpBtn?.focus();
}

manualHelpBtn?.addEventListener("click", openManualHelp);
manualHelpCloseBtn?.addEventListener("click", closeManualHelp);
manualHelpDialog?.addEventListener("click", event => {
    if (event.target.closest("[data-help-close]")) closeManualHelp();
});
document.addEventListener("keydown", event => {
    if (event.key === "Escape" && manualHelpDialog && !manualHelpDialog.hidden) {
        closeManualHelp();
    }
});

manualDrawMode?.addEventListener("change", () => {
    savePreferences();
    selection.hidden = true;
    hideManualDeleteButton();
    dragStart = null;
    isDragging = false;
    const label = manualDrawMode.value === "trace" ? "なぞり式（表示サイズに自動調整）" : "自由矩形";
    status(`手動の描画方法を「${label}」にしました。`);
});

stampMode.addEventListener("change", () => {
    if (!stampMode.checked) {
        selection.hidden = true;
        status("スタンプモードをOFFにしました。\n通常の手動黒塗りに戻ります。");
    } else if (manualStamps.length) {
        status("スタンプモードONです。\n画像をタップすると、直前の手動黒塗りと同じサイズで黒塗りします。");
    }
});


redactionMode?.addEventListener("change", () => {
    updateRedactionStyleUI();
    savePreferences();
    const label = redactionMode.selectedOptions?.[0]?.textContent || "黒塗り";
    status(`隠し方を「${label}」にしました。`);
});
redactionColor?.addEventListener("input", savePreferences);
manualDrawMode?.addEventListener("change", savePreferences);
targetText?.addEventListener("keydown", event => {
    if (event.key === "Enter") saveTargetHistoryEntry(targetText.value);
});

zoomOutBtn.addEventListener("click", () => setZoom(zoom - 0.25));
zoomInBtn.addEventListener("click", () => setZoom(zoom + 0.25));

undoBtn.addEventListener("click", () => {
    if (!manualHistory.length) return;
    const previous = manualHistory.pop();
    restoreManualSnapshot(previous);
    status(`直前の操作を取り消しました。\n残り：${manualStamps.length}箇所`);
});

resetBtn.addEventListener("click", () => {
    if (!sourceImage) return;
    // 自動(OCR)・手動を問わず、黒塗りを全て取り消して元画像の状態に戻す。
    manualStamps.length = 0;
    manualHistory.length = 0;
    selectedManualIndex = -1;
    editMode = null;
    hideManualDeleteButton();
    ocrBaseCanvas = null;
    redrawFromBase();
    status("黒塗りをすべてリセットしました。");
});

manualBtn.addEventListener("click", startManualMode);
manualDoneBtn.addEventListener("click", stopManualMode);

// 保存設定/履歴は定数とヘルパー定義が済んでから初期化する。
loadPreferences();
renderTargetHistory();

fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
        stopManualMode();
        ocrDiagnostics.hidden = true;
        ocrDebugLayer.hidden = true;
        ocrDebugLayer.innerHTML = "";
        sourceImage = await loadImage(file);
        buildSourceCanvas();
        fileName = (file.name.replace(/\.[^.]+$/, "") || "redacted") + "_redacted.png";
        manualStamps.length = 0;
        manualHistory.length = 0;
        selectedManualIndex = -1;
        editMode = null;
        hideManualDeleteButton();
        ocrBaseCanvas = null;
        canvas.width = sourceImage.naturalWidth;
        canvas.height = sourceImage.naturalHeight;
        zoom = 1;
        ctx.drawImage(sourceImage, 0, 0);
        updateZoomUI();
        redactBtn.disabled = false;
        diagnoseBtn.disabled = !ENABLE_DIAGNOSTIC;
        manualBtn.disabled = false;
        saveBtn.disabled = false;
        resetBtn.disabled = false;
        updateUndoButton();
        status(`画像を読み込みました。\n${canvas.width} × ${canvas.height}px`);
    } catch (error) {
        status("画像の読み込みに失敗しました。", error);
    }
});

redactBtn.addEventListener("click", run);
if (ENABLE_DIAGNOSTIC) diagnoseBtn.addEventListener("click", diagnoseOCR);

function canvasToBlob() {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG画像の作成に失敗しました。")), "image/png");
    });
}

function isLikelyMobileSaveEnvironment() {
    const ua = navigator.userAgent || "";
    const touch = navigator.maxTouchPoints || 0;
    return /iPhone|iPad|iPod|Android/i.test(ua) || (touch > 0 && Math.min(window.innerWidth || 0, window.innerHeight || 0) <= 1024);
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveBlobWithPicker(blob, name) {
    if (!window.showSaveFilePicker) return false;
    const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{
            description: "PNG画像",
            accept: { "image/png": [".png"] }
        }]
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
}

async function saveImage() {
    if (!sourceImage || !canvas.width || !canvas.height) {
        status("先に画像を処理してください。");
        return;
    }

    saveBtn.disabled = true;
    try {
        const blob = await canvasToBlob();
        const file = new File([blob], fileName, { type: "image/png" });
        const preferNativeSave = !isLikelyMobileSaveEnvironment();

        if (preferNativeSave && window.showSaveFilePicker) {
            await saveBlobWithPicker(blob, fileName);
            status("PNGを保存しました。");
            return;
        }

        if (!preferNativeSave && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
            status("画像を共有シートに渡しました。\n必要な場所へ保存してください。");
            return;
        }

        downloadBlob(blob, fileName);
        status("PNGを保存しました。");
    } catch (error) {
        if (error?.name === "AbortError") {
            status("保存をキャンセルしました。");
        } else {
            status("画像の保存に失敗しました。もう一度お試しください。", error);
        }
    } finally {
        saveBtn.disabled = false;
    }
}

saveBtn.addEventListener("click", saveImage);

window.addEventListener("beforeunload", () => worker?.terminate());

updateStampModeUI();
