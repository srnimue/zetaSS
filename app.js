const $ = id => document.getElementById(id);

// 診断モードを不要になったら false にするだけで非表示にできます。
const ENABLE_DIAGNOSTIC = true;

const fileInput = $("fileInput");
const targetText = $("targetText");
const overlayText = $("overlayText");
const overlayName = $("overlayName");
const stampMode = $("stampMode");
const redactBtn = $("redactBtn");
const diagnoseBtn = $("diagnoseBtn");
const manualBtn = $("manualBtn");
const undoBtn = $("undoBtn");
const resetBtn = $("resetBtn");
const manualDoneBtn = $("manualDoneBtn");
const saveBtn = $("saveBtn");
const manualHelp = $("manualHelp");
const statusEl = $("status");
const errorEl = $("errorDetails");
const canvasWrap = $("canvasWrap");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const selection = $("selection");
const ocrDebugLayer = $("ocrDebugLayer");
const ocrDiagnostics = $("ocrDiagnostics");
const zoomOutBtn = $("zoomOutBtn");
const zoomInBtn = $("zoomInBtn");
const zoomLabel = $("zoomLabel");

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
const TOUCH_X_OFFSET = -30;
const TOUCH_Y_OFFSET = -40;

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

const OCR_EDGE_PAD = 2; // 対象文字の字形がbboxから少しはみ出す場合の左右余白(px)
const OCR_MIN_PADDING = 3; // 最低限のパディング(px)。文字が小さくても黒塗りが欠けないように。
const OCR_PADDING_RATIO = 0.08; // 文字サイズに対するパディング比率
const OCR_FIRST_SYMBOL_MIN_HEIGHT_RATIO = 0.25; // 1文字目bboxが極端に薄い時だけ補正
const OCR_FIRST_SYMBOL_MAX_WIDTH_RATIO = 0.6; // 2文字目に対して1文字目の幅が極端に狭い時だけ補正
const OCR_RESCUE_EXTRA = 14; // 近似候補救出だけ左右に追加する余白(px)

// symbols[].bbox は呼び出し側で必ずbox.x/w/y/hと同じ座標系(元画像のcanvas座標)に
// 揃えてから渡すこと。座標系が食い違うと、ここでの比率判定が正しく機能しない。
//
// 方針：1文字目のbboxがOCRの癖で極端に細い/薄いと分かった場合、
// 「パディングを削って帳尻を合わせる」のではなく、box自体(x, w)を
// その文字の本来の位置まで広げる。黒塗りツールは隠しすぎるより
// 隠し漏れる方が致命的なので、疑わしい時は常に広げる方向で補正する。
const OCR_PREV_GAP_MAX = 10; // 直前の生シンボルとの隙間がこれを超えたら位置ズレを疑う(px)
const OCR_PREV_GAP_REANCHOR = 2; // 位置ズレを疑った時、直前シンボルの右端からこの分だけ空けて開始点にする(px)

function getOcrPaintBox(box, symbols = []) {
    const out = { ...box };
    if (symbols.length && box.h > 0) {
        const first = symbols[0]?.bbox;
        const second = symbols[1]?.bbox;
        if (first) {
            const firstHeight = Math.max(0, first.y1 - first.y0);
            if (firstHeight / box.h < OCR_FIRST_SYMBOL_MIN_HEIGHT_RATIO) {
                // 高さが極端に薄い＝bboxが文字の一部しか捉えていない可能性が高い。
                // 左端をその分広げる（右端はそのまま、対象外の文字を巻き込まない）。
                const extra = Math.max(0, box.h - firstHeight);
                out.x = Math.max(0, Math.min(out.x, first.x0) - extra);
                out.w = (box.x + box.w) - out.x;
            }

            if (symbols.length === 2 && second) {
                const firstWidth = Math.max(0, first.x1 - first.x0);
                const secondWidth = Math.max(0, second.x1 - second.x0);
                // secondWidthを「1文字目の本来の幅」の基準として使う前に、
                // それ自体が1文字ぶんとして妥当な幅かを確認する。文字の高さに対して
                // 幅が異常に大きい場合、Tesseractがその文字自体を隣接文字と
                // 巻き込んで誤検出している（＝基準にできない）ため、widthを
                // 使った補正はスキップする（変に広げるより何もしない方が安全）。
                const secondPlausible = secondWidth > 0 && secondWidth <= box.h * 1.6;
                if (secondPlausible && firstWidth / secondWidth < OCR_FIRST_SYMBOL_MAX_WIDTH_RATIO) {
                    // 1文字目の幅だけが極端に狭い＝右端の検出漏れの可能性が高い。
                    // box全体の左端を、1文字目の本来の開始位置まで広げる。
                    const expectedWidth = secondWidth; // 2文字目と同程度の幅があったはず
                    const missing = Math.max(0, expectedWidth - firstWidth);
                    out.x = Math.max(0, Math.min(out.x, first.x0) - missing);
                    out.w = (box.x + box.w) - out.x;
                }
            }

            // 「？」などの記号の直後の文字だけ、bboxが不自然に右へズレて
            // 報告されるケースが繰り返し確認されている（記号自体の認識位置は
            // 合っているのに、直後の文字が1文字分ほど右にズレる）。
            // 直前の生シンボル（正規化で消える記号も含む）との隙間が
            // 通常のカーニングよりあきらかに大きい場合は、位置ズレを疑って
            // 直前シンボルの右端まで左端を戻す。
            const prev = symbols[0]?.prevRawBbox;
            if (prev) {
                const gap = first.x0 - prev.x1;
                if (gap > OCR_PREV_GAP_MAX) {
                    const newX0 = Math.max(0, prev.x1 + OCR_PREV_GAP_REANCHOR);
                    if (newX0 < out.x) {
                        const rightEdge = out.x + out.w;
                        out.x = newX0;
                        out.w = rightEdge - newX0;
                    }
                }
                // paddingが直前の文字（「？」など）まで侵食しないよう、
                // 直前シンボルの右端を絶対に超えない境界として持っておく。
                // ただし、prevRawBbox自体が（ローカル再OCR時など）誤って
                // 対象文字の右端より右に来てしまうと、境界線が本体を
                // 追い越してbox幅が潰れる（＝縦棒になる）ため、
                // 境界が対象boxの右端より十分左にある時だけ採用する。
                const candidateBoundary = prev.x1 + 1;
                if (candidateBoundary < (out.x + out.w) - 4) {
                    out._leftBoundary = candidateBoundary;
                }
            }
        }

        // 最終保険：文字数に対してboxの幅があきらかに広すぎる場合
        // （＝どこかのsymbol自体のbboxがガタっと壊れている可能性が高い）は、
        // 左端はそのままに、幅を「1文字あたり高さの2倍」程度まで切り詰める。
        // 隠したい本体（1文字目）は左端にあるはずなので、切り詰めても
        // 対象自体が露出することはなく、余計な巻き込みだけを防げる。
        const maxPlausibleWidth = box.h * Math.max(1, symbols.length) * 2;
        if (out.w > maxPlausibleWidth) {
            out.w = maxPlausibleWidth;
        }
    }
    return out;
}

function getOcrVisualRect(box, symbols = [], rescue = false) {
    box = getOcrPaintBox(box, symbols);
    // 近似候補救出（例：「めーざー」→「ゆーざー」）は、1文字目の誤認で
    // 位置がずれやすいので、左右均等に余白を足す。
    if (rescue) {
        box.x = Math.max(0, box.x - OCR_RESCUE_EXTRA);
        box.w += OCR_RESCUE_EXTRA * 2;
    }
    // パディングは常に左右・上下対称。片側だけ削る特殊分岐は作らない
    // （そこが今回、文字の一部を隠し漏らしていた原因だったため）。
    const padding = Math.max(OCR_MIN_PADDING, Math.round(Math.min(box.w, box.h) * OCR_PADDING_RATIO));
    let left = Math.max(0, box.x - OCR_EDGE_PAD - padding);
    const right = Math.min(canvas.width, box.x + box.w + OCR_EDGE_PAD + padding);
    // _leftBoundaryは「直前の文字を巻き込まない」ためだけの制約なので、
    // 万一おかしな値が来ても、最低限の幅(box.wの半分か8pxの大きい方)は必ず確保する。
    if (typeof box._leftBoundary === "number") {
        const minWidth = Math.max(8, box.w * 0.5);
        left = Math.max(left, Math.min(box._leftBoundary, right - minWidth));
    }
    const width = Math.max(1, right - left);
    const top = Math.max(0, box.y - padding);
    const height = box.h + padding * 2;

    return { x: left, y: top, w: width, h: height };
}

function paintOcr(box, text = "", symbols = [], rescue = false) {
    const rect = getOcrVisualRect(box, symbols, rescue);
    ctx.fillStyle = "#000";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    if (text) {
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.max(12, Math.round(box.h * 0.8))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2);
    }
    return rect;
}

function paintManual(box, text = "") {
    const padding = Math.max(4, Math.round(Math.min(box.w, box.h) * 0.12));
    const verticalPadding = padding + 2;
    const left = Math.max(0, box.x - padding - 6);
    const top = Math.max(0, box.y - verticalPadding);
    const width = box.w + padding;
    const height = box.h + verticalPadding * 2;

    ctx.fillStyle = "#000";
    ctx.fillRect(left, top, width, height);

    if (text) {
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.max(12, Math.round(box.h * 0.8))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, left + width / 2, top + height / 2);
    }
}

function paintStamp(stamp) {
    if (stamp.kind === "ocr") {
        ctx.fillStyle = "#000";
        ctx.fillRect(stamp.x, stamp.y, stamp.w, stamp.h);
        if (stamp.text) {
            ctx.fillStyle = "#fff";
            ctx.font = `bold ${Math.max(12, Math.round(stamp.h * 0.8))}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(stamp.text, stamp.x + stamp.w / 2, stamp.y + stamp.h / 2);
        }
        return;
    }
    paintManual(stamp, stamp.text);
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

function updateUndoButton() {
    undoBtn.disabled = manualHistory.length === 0;
    const lastManual = getLastManualStamp();
    stampMode.disabled = !lastManual;
    if (!lastManual) stampMode.checked = false;
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

function getManualVisualRect(stamp) {
    const padding = Math.max(4, Math.round(Math.min(stamp.w, stamp.h) * 0.12));
    const verticalPadding = padding + 2;
    return {
        x: Math.max(0, stamp.x - padding - 6),
        y: Math.max(0, stamp.y - verticalPadding),
        w: stamp.w + padding,
        h: stamp.h + verticalPadding * 2
    };
}

function renderManualSelection() {
    if (selectedManualIndex < 0 || !manualStamps[selectedManualIndex]) {
        selection.hidden = true;
        selection.innerHTML = "";
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
    for (const handle of ["nw", "ne", "sw", "se"]) {
        const el = document.createElement("span");
        el.className = `edit-handle handle-${handle}`;
        el.dataset.handle = handle;
        selection.appendChild(el);
    }
}

function hitTestManual(point) {
    for (let i = manualStamps.length - 1; i >= 0; i--) {
        const b = manualStamps[i];
        const padX = Math.max(8, b.w * 0.08);
        const padY = Math.max(8, b.h * 0.08);
        if (point.x >= b.x - padX && point.x <= b.x + b.w + padX &&
            point.y >= b.y - padY && point.y <= b.y + b.h + padY) return i;
    }
    return -1;
}

function getResizeHandle(point, stamp) {
    const transform = getCanvasDisplayTransform();
    const size = 22 / Math.max(transform.scaleX, transform.scaleY);
    const handles = {
        nw: [stamp.x, stamp.y],
        ne: [stamp.x + stamp.w, stamp.y],
        sw: [stamp.x, stamp.y + stamp.h],
        se: [stamp.x + stamp.w, stamp.y + stamp.h]
    };
    for (const [name, [x, y]] of Object.entries(handles)) {
        if (Math.hypot(point.x - x, point.y - y) <= size) return name;
    }
    return null;
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

    // 編集中にcanvasを描き直しても、現在のズーム率とスクロール位置を
    // 変えない。canvas.width/heightを書き換えるとブラウザがスクロール位置を
    // 戻してしまうことがあるため、編集前の表示位置を保存して復元する。
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
        zoom = 1;
        ctx.drawImage(sourceImage, 0, 0);
        updateZoomUI();
    }

    for (const stamp of manualStamps) {
        paintStamp(stamp);
    }
    updateUndoButton();
    renderManualSelection();

    if (ocrBaseCanvas && keepZoom > 1.001) {
        zoom = keepZoom;
        canvasWrap.classList.add("zoomed");
        const base = getBaseDisplaySize();
        canvas.style.width = `${base.width * zoom}px`;
        canvas.style.height = `${base.height * zoom}px`;
        zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
        requestAnimationFrame(() => {
            canvasWrap.scrollLeft = keepScrollLeft;
            canvasWrap.scrollTop = keepScrollTop;
            renderManualSelection();
        });
    }
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

function makeGrayContrast(src){
  const c=document.createElement('canvas'); c.width=src.width; c.height=src.height;
  const ctx=c.getContext('2d'); ctx.drawImage(src,0,0);
  const img=ctx.getImageData(0,0,c.width,c.height),d=img.data;
  for(let i=0;i<d.length;i+=4){const g=Math.max(0,Math.min(255,((0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])-128)*1.35+128));d[i]=d[i+1]=d[i+2]=g;}
  ctx.putImageData(img,0,0); return c;
}
function makeInverted(src){
  const c=document.createElement('canvas'); c.width=src.width; c.height=src.height;
  const ctx=c.getContext('2d'); ctx.drawImage(src,0,0);
  const img=ctx.getImageData(0,0,c.width,c.height),d=img.data;
  for(let i=0;i<d.length;i+=4){d[i]=255-d[i];d[i+1]=255-d[i+1];d[i+2]=255-d[i+2];}
  ctx.putImageData(img,0,0); return c;
}
function makeColorExtract(src){
  // 色付き文字を補助的に拾うための簡易色抽出。
  // 彩度が低い画素は白、彩度が高い画素は元の明度を保持したグレーにする。
  const c=document.createElement('canvas'); c.width=src.width; c.height=src.height;
  const ctx=c.getContext('2d'); ctx.drawImage(src,0,0);
  const img=ctx.getImageData(0,0,c.width,c.height),d=img.data;
  for(let i=0;i<d.length;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2];
    const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
    const sat=mx-mn;
    if(sat < 32){ d[i]=d[i+1]=d[i+2]=255; }
    else {
      const y=Math.round(r*.299+g*.587+b*.114);
      d[i]=d[i+1]=d[i+2]=y;
    }
  }
  ctx.putImageData(img,0,0); return c;
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
        if (s.bbox.x0 < prevX1 - 2) return false; // 前の文字と逆転/大きく重複＝並び順が崩れている
        prevX1 = s.bbox.x1;
    }
    const first = syms[0].bbox, last = syms[syms.length - 1].bbox;
    const wordWidth = Math.max(1, wb.x1 - wb.x0);
    const leftGap = first.x0 - wb.x0;
    const rightGap = wb.x1 - last.x1;
    // 先頭/末尾の文字が単語の枠から離れすぎている＝どこかの文字が
    // 本来の位置からズレて報告されている可能性が高い。
    return leftGap <= wordWidth * 0.25 && rightGap <= wordWidth * 0.25;
}

// punctuation（正規化で消える記号）も含めて「直前の生シンボルのbbox」を
// 各文字に記録しておく。「？」の直後の文字だけbboxが不自然に右へズレる
// パターンが繰り返し確認されているため、後段(getOcrPaintBox)でこの
// prevRawBboxとの隙間を見て、怪しければ位置を補正する。
function extractLineUnits(line){
  const units=[];
  let prevBbox=null;
  for(const word of (line?.words||[])){
    const rawSyms=(word?.symbols||[]).filter(s=>s?.bbox);
    const kept=rawSyms.filter(s=>normalize(s.text));
    if(kept.length&&symbolsLookValid(word,kept)){
      for(let idx=0;idx<rawSyms.length;idx++){
        const s=rawSyms[idx];
        const chNorm=normalize(s.text);
        if(chNorm){
          const chars=[...chNorm];
          let ch;
          if(chars.length>1){
            // Tesseractが稀に、本来1文字ずつ正しく分かれているsymbol列に対して、
            // 同じ複数文字のテキスト（例：「ネル」）を重複して報告することがある
            // （bboxの分割自体は正しいのに、textラベルだけ被って長くなる）。
            // このsymbol自身のbboxはそのまま信用し、直前から続く「同じテキストを
            // 繰り返す連続グループ」の中で自分が何番目かを見て、その順番の
            // 1文字だけを割り当てる。
            let runStart=idx;
            while(runStart>0&&normalize(rawSyms[runStart-1].text)===chNorm)runStart--;
            const posInRun=idx-runStart;
            ch=chars[Math.min(posInRun,chars.length-1)];
          }else{
            ch=chars[0];
          }
          units.push({ch,bbox:s.bbox,raw:s.text,prevRawBbox:prevBbox});
        }
        prevBbox=s.bbox;
      }
    }else if(word?.bbox&&normalize(word.text)){
      const chars=[...normalize(word.text)],b=word.bbox;
      chars.forEach((ch,i)=>{
        const bbox={x0:b.x0+(b.x1-b.x0)*i/chars.length,y0:b.y0,x1:b.x0+(b.x1-b.x0)*(i+1)/chars.length,y1:b.y1};
        units.push({ch,raw:word.text,bbox,prevRawBbox:prevBbox});
        prevBbox=bbox;
      });
    }else if(rawSyms.length){
      // 「？」単体のように、文字としては1つも残らない(=正規化で空になる)
      // 単語。ここでunitsには何も追加しないが、直後の文字が正しく
      // 「直前の右端」を参照できるよう、この単語の右端だけは必ず記録する。
      prevBbox=rawSyms[rawSyms.length-1].bbox;
    }else if(word?.bbox){
      prevBbox=word.bbox;
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

// V76実験：OCRが対象文字の間に余計なunitを挟んだり、文字を細かく分割しても、
// 「対象文字がこの順番で出現しているか」を見る。完全一致とは別の診断用ルート。
// 近似文字そのものへの置換は行わず、対象文字が実際にunits内に存在する場合だけ拾う。
function findTargetInUnitsRobust(units,target,options={}){
  const chars=[...target];
  if(!chars.length) return [];
  const maxSkip=Math.max(0, options.maxSkip ?? 2);
  const maxGapFactor=Math.max(1, options.maxGapFactor ?? 3.2);
  const out=[];

  for(let start=0; start<units.length; start++){
    if(units[start]?.ch!==chars[0]) continue;
    const selected=[units[start]];
    const skipped=[];
    let cursor=start;
    let ok=true;

    for(let ti=1; ti<chars.length; ti++){
      let foundIndex=-1;
      const first=selected[selected.length-1];
      const firstW=Math.max(1, first.bbox.x1-first.bbox.x0);
      const firstH=Math.max(1, first.bbox.y1-first.bbox.y0);
      for(let j=cursor+1; j<=Math.min(units.length-1,cursor+maxSkip+1); j++){
        const u=units[j];
        if(u.ch!==chars[ti]) continue;
        const dx=u.bbox.x0-first.bbox.x1;
        const dy=Math.abs(((u.bbox.y0+u.bbox.y1)/2)-((first.bbox.y0+first.bbox.y1)/2));
        const h=Math.max(1,u.bbox.y1-u.bbox.y0);
        const maxDx=Math.max(45, Math.max(firstW,h)*maxGapFactor);
        const maxDy=Math.max(18, Math.max(firstH,h)*0.9);
        if(dx>=-Math.max(6,firstW*0.25) && dx<=maxDx && dy<=maxDy){
          foundIndex=j;
          break;
        }
      }
      if(foundIndex<0){ ok=false; break; }
      for(let j=cursor+1;j<foundIndex;j++) skipped.push(units[j]);
      selected.push(units[foundIndex]);
      cursor=foundIndex;
    }
    if(ok && selected.length===chars.length && skipped.length>0){
      out.push(makeTargetHit(selected,'robust',skipped));
    }
  }
  return out;
}



// V63実験：OCRで正しく拾えた「文字単体」をテンプレートにして、
// 同じ文字形＋文字間隔を画像そのものから探す。まずは診断専用で、黒塗りには使用しない。
function grayPixel(data, w, x, y) {
  const i = (y * w + x) * 4;
  return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
}

function makeTemplateSamples(imageData, x, y, w, h, cols=16, rows=16) {
  const out=[];
  for(let ry=0; ry<rows; ry++) for(let rx=0; rx<cols; rx++) {
    const px=Math.min(imageData.width-1, Math.max(0, Math.floor(x+(rx+0.5)*w/cols)));
    const py=Math.min(imageData.height-1, Math.max(0, Math.floor(y+(ry+0.5)*h/rows)));
    out.push(grayPixel(imageData.data,imageData.width,px,py));
  }
  const mean=out.reduce((a,b)=>a+b,0)/out.length;
  const norm=Math.sqrt(out.reduce((a,v)=>a+(v-mean)*(v-mean),0))||1;
  return {values:out,mean,norm,cols,rows,w,h};
}

function samplePatchScore(imageData, template, x, y, w=template.w, h=template.h) {
  const vals=[];
  for(let ry=0; ry<template.rows; ry++) for(let rx=0; rx<template.cols; rx++) {
    const px=Math.min(imageData.width-1, Math.max(0, Math.floor(x+(rx+0.5)*w/template.cols)));
    const py=Math.min(imageData.height-1, Math.max(0, Math.floor(y+(ry+0.5)*h/template.rows)));
    vals.push(grayPixel(imageData.data,imageData.width,px,py));
  }
  const mean=vals.reduce((a,b)=>a+b,0)/vals.length;
  let dot=0, norm=0;
  for(let i=0;i<vals.length;i++) {
    const a=template.values[i]-template.mean, b=vals[i]-mean;
    dot+=a*b; norm+=b*b;
  }
  return dot/(template.norm*Math.sqrt(norm)||1);
}

function runGlyphTemplateMatch(sourceCanvas, referenceMatch) {
  const srcCtx=sourceCanvas.getContext('2d',{willReadFrequently:true});
  const data=srcCtx.getImageData(0,0,sourceCanvas.width,sourceCanvas.height);
  const symbols=(referenceMatch.symbols||[]).slice(0,2);
  if(symbols.length<2) return {error:'基準HITから2文字のsymbol bboxを取得できません。'};

  const glyphs=symbols.map((u,i)=>{
    const b=u.bbox;
    return {
      ch:u.ch,
      x:Math.round(b.x0), y:Math.round(b.y0),
      w:Math.max(6,Math.round(b.x1-b.x0)), h:Math.max(6,Math.round(b.y1-b.y0)),
      index:i
    };
  });

  const step=5;
  const threshold=.72;
  const perGlyph=[];
  for(const g of glyphs){
    const template=makeTemplateSamples(data,g.x,g.y,g.w,g.h,12,12);
    const candidates=[];
    for(let y=0;y<=sourceCanvas.height-g.h;y+=step){
      for(let x=0;x<=sourceCanvas.width-g.w;x+=step){
        if(Math.abs(x-g.x)<g.w*1.2 && Math.abs(y-g.y)<g.h*1.2) continue;
        const score=samplePatchScore(data,template,x,y,g.w,g.h);
        if(score>=threshold) candidates.push({x,y,w:g.w,h:g.h,score,ch:g.ch});
      }
    }
    candidates.sort((a,b)=>b.score-a.score);
    perGlyph.push({glyph:g,template,candidates:candidates.slice(0,80),rawCount:candidates.length});
  }

  const a=perGlyph[0], b=perGlyph[1];
  const pairs=[];
  const expectedDx=glyphs[1].x-glyphs[0].x;
  const expectedDy=glyphs[1].y-glyphs[0].y;
  for(const ca of a.candidates){
    for(const cb of b.candidates){
      const dx=cb.x-ca.x, dy=cb.y-ca.y;
      const dxErr=Math.abs(dx-expectedDx);
      const dyErr=Math.abs(dy-expectedDy);
      if(dxErr>Math.max(12,expectedDx*.45) || dyErr>Math.max(10,glyphs[0].h*.5)) continue;
      const positionScore=Math.max(0,1-dxErr/Math.max(12,expectedDx*.45))*0.7 + Math.max(0,1-dyErr/Math.max(10,glyphs[0].h*.5))*0.3;
      const score=(ca.score+cb.score)/2 + positionScore*.08;
      pairs.push({x:ca.x,y:ca.y,w:(cb.x+cb.w)-ca.x,h:Math.max(ca.h,cb.h),score,scoreA:ca.score,scoreB:cb.score,dx,dy});
    }
  }
  pairs.sort((a,b)=>b.score-a.score);
  const dedup=[];
  for(const p of pairs){
    if(dedup.some(q=>Math.abs(q.x-p.x)<12 && Math.abs(q.y-p.y)<12)) continue;
    dedup.push(p);
    if(dedup.length>=20) break;
  }
  return {
    glyphs,
    step,threshold,
    perGlyph:perGlyph.map(x=>({ch:x.glyph.ch,rawCount:x.rawCount,candidates:x.candidates.slice(0,10)})),
    pairs:dedup,
    expectedDx,expectedDy
  };
}


// V64実験：画像を機械的に分割するのではなく、画素の密度から
// 「文字がありそうな横長の領域」を推定し、その領域だけを局所OCRする。
// 診断専用。黒塗りには使用しない。
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
  const robustMatches = [];
  const nearMatches = [];
  const lineData = [];
  try {
    const result = await worker.recognize(input, {tessedit_pageseg_mode:'7'});
    raw = String(result?.data?.text || '').replace(/\s+/g,' ').trim();
    for (const line of (result?.data?.lines || [])) {
      const units = extractLineUnits(line);
      const found = findTargetInUnits(units, target);
      const robust = findTargetInUnitsRobust(units, target);
      lineData.push({units, text: units.map(u => u.ch).join(''), robust});
      if (found.length) {
        hit = true;
        matches.push(...found);
      }
      robustMatches.push(...robust);
      nearMatches.push(...robust);
    }
  } catch (e) {
    raw = `ERROR: ${e?.message || e}`;
  } finally {
    if (input !== crop) { input.width = 1; input.height = 1; }
  }
  return {mode, raw, hit, matches, robustMatches, nearMatches, lineData};
}

// V68実験：V64の「文字っぽい横長領域」の検出を維持し、
// 上位16領域だけでなく検出された全領域を通常OCRする。
// まず「未走査領域に3個目が存在するか」を確認するためのカバレッジ実験。
// 前処理追加はこの版では行わず、OCR回数を必要最小限にする。診断専用。
async function runTextRegionExperiment(worker,sourceCanvas,target) {
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
      hit:normal.hit,
      baseHit:normal.hit,
      extraHit:false,
      variants:[normal],
      raw:normal.raw
    });
    crop.width=1; crop.height=1;
  }
  return {
    detected,
    tested,
    elapsed:performance.now()-started,
    extraRuns:0,
    extraModes:[]
  };
}

// V70本採用用：V68と同じ文字領域検出＋全領域局所OCRを、
// 実際の自動黒塗り候補として返す。OCRのbboxは2倍拡大した局所画像上の
// 座標なので、元画像の領域座標へ戻してから既存のmergeMatchesへ渡す。
async function collectTextRegionMatches(worker, sourceCanvas, target) {
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
        x0: r.x + b.x0 / SCALE,
        y0: r.y + b.y0 / SCALE,
        x1: r.x + b.x1 / SCALE,
        y1: r.y + b.y1 / SCALE,
        symbols: (hit.symbols || []).map(u => ({
          ...u,
          bbox: {
            x0: r.x + u.bbox.x0 / SCALE,
            y0: r.y + u.bbox.y0 / SCALE,
            x1: r.x + u.bbox.x1 / SCALE,
            y1: r.y + u.bbox.y1 / SCALE
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

// V81: かな限定の誤認識救出。V74の「1文字違いなら何でも候補」より
// かなり厳しく、対象文字ごとに限定した置換だけを許容する。
// 漢字はここでは扱わない。
const V81_KANA_PAIRS = new Map([
  ['ネ', new Set(['デ','ね'])], ['ね', new Set(['ネ'])],
  ['ル', new Set(['る','レ'])], ['る', new Set(['ル'])],
  ['レ', new Set(['ル'])],
  ['ナ', new Set(['な'])], ['な', new Set(['ナ'])],
  ['ニ', new Set(['二','に'])], ['に', new Set(['ニ'])],
  ['二', new Set(['ニ'])],
  ['カ', new Set(['力','か'])], ['か', new Set(['カ'])],
  ['キ', new Set(['き'])], ['き', new Set(['キ'])],
  ['ク', new Set(['く'])], ['く', new Set(['ク'])],
  ['ケ', new Set(['け'])], ['け', new Set(['ケ'])],
  ['コ', new Set(['こ'])], ['こ', new Set(['コ'])],
  ['サ', new Set(['さ'])], ['さ', new Set(['サ'])],
  ['シ', new Set(['し'])], ['し', new Set(['シ'])],
  ['ス', new Set(['す'])], ['す', new Set(['ス'])],
  ['セ', new Set(['せ'])], ['せ', new Set(['セ'])],
  ['ソ', new Set(['そ'])], ['そ', new Set(['ソ'])],
  ['タ', new Set(['た'])], ['た', new Set(['タ'])],
  ['チ', new Set(['ち'])], ['ち', new Set(['チ'])],
  ['ツ', new Set(['つ'])], ['つ', new Set(['ツ'])],
  ['テ', new Set(['て'])], ['て', new Set(['テ'])],
  ['ト', new Set(['と'])], ['と', new Set(['ト'])],
  ['ハ', new Set(['は'])], ['は', new Set(['ハ'])],
  ['ヒ', new Set(['ひ'])], ['ひ', new Set(['ヒ'])],
  ['フ', new Set(['ふ'])], ['ふ', new Set(['フ'])],
  ['ヘ', new Set(['へ'])], ['へ', new Set(['ヘ'])],
  ['ホ', new Set(['ほ'])], ['ほ', new Set(['ホ'])],
  ['マ', new Set(['ま'])], ['ま', new Set(['マ'])],
  ['ミ', new Set(['み'])], ['み', new Set(['ミ'])],
  ['ム', new Set(['む'])], ['む', new Set(['ム'])],
  ['メ', new Set(['め'])], ['め', new Set(['メ'])],
  ['モ', new Set(['も'])], ['も', new Set(['モ'])],
  ['ヤ', new Set(['や'])], ['や', new Set(['ヤ'])],
  ['ユ', new Set(['ゆ'])], ['ゆ', new Set(['ユ'])],
  ['ヨ', new Set(['よ'])], ['よ', new Set(['ヨ'])],
  ['ラ', new Set(['ら'])], ['ら', new Set(['ラ'])],
  ['リ', new Set(['り'])], ['り', new Set(['リ'])],
  ['ロ', new Set(['ろ'])], ['ろ', new Set(['ロ'])],
  ['ワ', new Set(['わ'])], ['わ', new Set(['ワ'])]
]);
function isV81Kana(ch){ return /[ぁ-ゖァ-ヺー]/u.test(ch); }
function isV81Kanji(ch){ return /\p{Script=Han}/u.test(ch); }
function v81KanaEquivalent(targetCh, ocrCh){
  if(targetCh===ocrCh) return true;
  return V81_KANA_PAIRS.get(targetCh)?.has(ocrCh) || false;
}
function findV81KanaRescue(results,target,scale){
  const targetChars=[...target];
  if(!targetChars.length || targetChars.some(ch=>!isV81Kana(ch))) return [];
  const out=[];
  for(const r of results||[]){
    for(const line of r.lines||[]){
      const units=extractLineUnits(line);
      if(!units.length) continue;
      // 対象と同じ文字数の窓だけを見る。追加・削除を許すとV74と同じく候補が爆発するため。
      for(let i=0;i<=units.length-targetChars.length;i++){
        const selected=units.slice(i,i+targetChars.length);
        let substitutions=0;
        let ok=true;
        for(let j=0;j<targetChars.length;j++){
          if(!v81KanaEquivalent(targetChars[j],selected[j].ch)){ ok=false; break; }
          if(targetChars[j]!==selected[j].ch) substitutions++;
        }
        if(!ok || substitutions<1 || substitutions>1) continue;
        // すべて同じ文字種の「かな置換」だけ。漢字混入は除外。
        if(selected.some(u=>!isV81Kana(u.ch))) continue;
        const b=makeTargetHit(selected,'v81-kana').targetBox;
        out.push({
          ocr:selected.map(u=>u.ch).join(''),
          target,
          substitutions,
          box:b,
          lineText:units.map(u=>u.ch).join(''),
          mode:r.mode
        });
      }
    }
  }
  // 同じ場所に複数候補が出た場合は1件にまとめる。
  const unique=[];
  for(const x of out){
    const dup=unique.some(q=>{
      const a=x.box,b=q.box;
      const ix0=Math.max(a.x0,b.x0),iy0=Math.max(a.y0,b.y0),ix1=Math.min(a.x1,b.x1),iy1=Math.min(a.y1,b.y1);
      if(ix1<=ix0||iy1<=iy0) return false;
      const inter=(ix1-ix0)*(iy1-iy0), area=Math.min((a.x1-a.x0)*(a.y1-a.y0),(b.x1-b.x0)*(b.y1-b.y0));
      return area>0 && inter/area>.45;
    });
    if(!dup) unique.push(x);
  }
  return unique;
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
    const symbols=hit.symbols.map(s=>({...s,bbox:scaleBbox(s.bbox),prevRawBbox:scaleBbox(s.prevRawBbox)}));
    matches.push({x0:hit.targetBox.x0/scale,y0:hit.targetBox.y0/scale,x1:hit.targetBox.x1/scale,y1:hit.targetBox.y1/scale,mode,lineText,symbols});
}}const words=(offsetX||offsetY)?shiftOcrBboxes(data.words||[],offsetX,offsetY):(data.words||[]);return {mode,lines,words,rawText:String(data.text||""),matches,near:findNearCandidates(lines,target)};}

// 完全一致した箇所でも、Tesseractがページ全体を一度にOCRした際に
// 文字1つ分だけ座標がズレて報告されることがある（周辺のノイズ・隣接文字の影響）。
// 単語のbbox自体がそのズレた文字から組み立てられている場合、
// symbolsLookValidの内部チェックだけではすり抜けてしまう。
// なので、候補の周辺だけを切り出してノイズを減らし、高倍率で再OCRすることで
// より位置ズレの少ないbboxを取り直す。見つからなければ元のboxをそのまま使う
// （黒塗りが消えることは絶対にないようにする）。
//
// 注意：ここは必ず sourceImage（無加工の元画像）から直接切り出す。
// 表示用canvasは黒塗り実行後は既に黒塗り済みになっているため、そこから切り出すと
// 「既に黒く塗られた場所」を再OCRすることになり、見つからず「変更なし」という
// 誤った（一見正しく見える）結果になる。
async function refineExactHitBox(worker, box, target) {
    const padX = Math.max(30, box.w);
    // 縦方向は広げすぎない。ここを広げすぎると、吹き出し内の次の行まで
    // 巻き込んでPSM7(単一行想定)の認識がその行またぎでbboxを誤って
    // 縦に間延びさせてしまう（実際に発生した不具合）。
    const padY = Math.min(14, Math.max(6, box.h * 0.3));
    const x0 = Math.max(0, Math.round(box.x - padX));
    const y0 = Math.max(0, Math.round(box.y - padY));
    const x1 = Math.min(sourceImage.naturalWidth, Math.round(box.x + box.w + padX));
    const y1 = Math.min(sourceImage.naturalHeight, Math.round(box.y + box.h + padY));
    if (x1 <= x0 || y1 <= y0) return box;

    const LOCAL_SCALE = 4;
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round((x1 - x0) * LOCAL_SCALE));
    crop.height = Math.max(1, Math.round((y1 - y0) * LOCAL_SCALE));
    const cctx = crop.getContext('2d');
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(sourceImage, x0, y0, x1 - x0, y1 - y0, 0, 0, crop.width, crop.height);

    try {
        const result = await worker.recognize(crop, { tessedit_pageseg_mode: '7' });
        const lines = result?.data?.lines || [];
        for (const line of lines) {
            const units = extractLineUnits(line);
            const hits = findTargetInUnits(units, target);
            if (hits.length) {
                const h = hits[0].targetBox;
                const newW = (h.x1 - h.x0) / LOCAL_SCALE;
                const newH = (h.y1 - h.y0) / LOCAL_SCALE;
                // 別の行を巻き込んで縦に間延びした・不自然に幅広くなったbboxは
                // 信用せず、元のboxを使う（隠し漏れより誤爆の方が実害が大きいため）。
                if (box.h > 0 && newH > box.h * 1.6) return box;
                if (box.w > 0 && newW > box.w * 1.8) return box;
                // 逆に、元のboxよりあきらかに狭すぎる結果（＝縦棒のような
                // 潰れた黒塗りになる）も信用せず、元のboxを使う。
                if (box.w > 0 && newW < box.w * 0.5) return box;
                const mapBbox=b=>b?{x0:x0+b.x0/LOCAL_SCALE,y0:y0+b.y0/LOCAL_SCALE,x1:x0+b.x1/LOCAL_SCALE,y1:y0+b.y1/LOCAL_SCALE}:null;
                return {
                    x: x0 + h.x0 / LOCAL_SCALE,
                    y: y0 + h.y0 / LOCAL_SCALE,
                    w: newW,
                    h: newH,
                    symbols: hits[0].symbols.map(s => ({
                        ...s,
                        bbox: mapBbox(s.bbox),
                        prevRawBbox: mapBbox(s.prevRawBbox)
                    })),
                    source: box.source
                };
            }
        }
    } catch (e) {
        // 失敗しても黙って元のboxを使う。
    } finally {
        crop.width = 1; crop.height = 1;
    }
    return box;
}

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

function buildOcrCanvas(){
  // OCR用キャンバス本体は従来の座標系のまま保持し、実際にTesseractへ渡す
  // キャンバスだけに白い10px境界線を追加する。表示用canvasは変更しない。
  const scale=2.5;
  const oc=document.createElement("canvas");
  oc.width=Math.round(canvas.width*scale);
  oc.height=Math.round(canvas.height*scale);
  const c=oc.getContext("2d");
  c.imageSmoothingEnabled=true;
  c.imageSmoothingQuality="high";
  c.drawImage(sourceImage,0,0,oc.width,oc.height);
  return {canvas:oc,scale};
}

async function collectOcrResults(worker,target){
  const {canvas:oc,scale}=buildOcrCanvas();
  const results=[];
  const stats={primaryMs:0,fallbackMs:0,primaryHitCount:0,fallbackUsed:false,primaryName:"グレー＋コントラスト",fallbackNames:["二値化180","二値化220","反転"]};

  // まず今回の実験で最も安定していた「グレー＋コントラスト」だけを実行。
  // ここで1件でも正確に見つかれば、追加の全体OCRは省略する。
  // ※診断用の速度実験版。見落としの有無を確認するため、V32は別に保存しておく。
  const primaryStarted=performance.now();
  status("実行中…");
  const primaryBase=makeOcrVariant(oc,stats.primaryName);
  const primaryVariant=makeWhiteBorderCanvas(primaryBase,OCR_BORDER_PX*scale);
  try {
    const primary=await recognizeVariant(worker,primaryVariant,target,stats.primaryName,scale,OCR_BORDER_PX*scale,OCR_BORDER_PX*scale);
    results.push(primary);
    stats.primaryHitCount=primary.matches.length;
  } finally {
    primaryVariant.width=1;primaryVariant.height=1;
    if(primaryBase!==oc){primaryBase.width=1;primaryBase.height=1;}
    stats.primaryMs=performance.now()-primaryStarted;
  }

  // グレー＋コントラストで1件も見つからなかった場合だけ、
  // 補助的な全体OCRを追加する。通常・グレースケールは今回の実験では外す。
  if(stats.primaryHitCount===0){
    stats.fallbackUsed=true;
    const fallbackStarted=performance.now();
    for(const name of stats.fallbackNames){
      status("実行中…");
      const baseVariant=makeOcrVariant(oc,name);
      const variant=makeWhiteBorderCanvas(baseVariant,OCR_BORDER_PX*scale);
      try {
        results.push(await recognizeVariant(worker,variant,target,name,scale,OCR_BORDER_PX*scale,OCR_BORDER_PX*scale));
      } finally {
        variant.width=1;variant.height=1;
        if(baseVariant!==oc){baseVariant.width=1;baseVariant.height=1;}
      }
    }
    stats.fallbackMs=performance.now()-fallbackStarted;
  }

  // V82.1: 過去の色抽出実験でヒットしたケースを退行させないため、
  // 色抽出OCRは主OCRのHIT数に関係なく1回だけ追加実行する。
  const colorStarted=performance.now();
  const colorBase=makeOcrVariant(oc,"色抽出");
  const colorVariant=makeWhiteBorderCanvas(colorBase,OCR_BORDER_PX*scale);
  try {
    const color=await recognizeVariant(worker,colorVariant,target,"色抽出",scale,OCR_BORDER_PX*scale,OCR_BORDER_PX*scale);
    results.push(color);
    stats.colorHitCount=color.matches.length;
  } finally {
    colorVariant.width=1;colorVariant.height=1;
    if(colorBase!==oc){colorBase.width=1;colorBase.height=1;}
  }
  stats.colorMs=performance.now()-colorStarted;

  return {results,scale,ocrCanvas:oc,stats};
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

function candidateLocationKey(candidate, scale) {
  const b = getCandidateBox(candidate, scale);
  if (!b) return null;
  // 同じ文字列の候補が数pxずれて複数の前処理から出ても、同一地点としてまとめる。
  return `${Math.round(b.x0 / 18)}:${Math.round(b.y0 / 18)}:${Math.round(b.x1 / 18)}:${Math.round(b.y1 / 18)}`;
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

  // V36: 再OCRより先に「かなり強い近似候補」を救出する。
  // 今回のように Tesseract が「ゆーざー」を「めーざー」と読むケースでは、
  // 4文字中3文字が同じ位置に残るため、局所OCRを何度回しても同じ誤読を
  // 繰り返すことがある。そうした候補は、同じ地点に複数の近似候補が集まり、
  // かつ対象と同じ文字数で、編集類似度が高い場合に先に採用する。
  function getFastRecovery(group) {
    const tlen = [...target].length;
    const sameLength = group.candidates.filter(c => [...c.candidate].length === tlen);
    if (!sameLength.length) return null;

    // V37: 「めーざー」のような1文字誤認を明示的に救出する。
    // exactChars は同じ文字が重複する「ー」をうまく評価できないため、
    // ここでは文字列そのものの編集距離を基準にする。
    const strong = sameLength
      .map(c => ({...c, recoveryDistance: editDistance(target, c.candidate)}))
      .filter(c => c.recoveryDistance <= 1)
      .filter(c => c.similarity >= 0.72)
      .sort((a,b) => {
        if (a.recoveryDistance !== b.recoveryDistance) return a.recoveryDistance - b.recoveryDistance;
        return b.similarity - a.similarity;
      });

    if (!strong.length) return null;

    const best = strong[0];
    const distinctCandidates = new Set(strong.map(c => c.candidate));
    const enoughSupport = strong.length >= 1;
    const conservativeLengthRule = tlen >= 3;
    if (!enoughSupport || !conservativeLengthRule) return null;

    // V38: 黒塗りには「候補地点全体」ではなく、採用した近似候補自身のbboxを使う。
    // group.box は同じ地点に集まった複数候補の外接矩形なので、これをそのまま
    // 黒塗りすると周囲の文章まで巻き込んでしまう。
    const units = best.units || [];
    const xs = units.flatMap(u => [u.bbox.x0, u.bbox.x1]);
    const ys = units.flatMap(u => [u.bbox.y0, u.bbox.y1]);
    if (!xs.length || !ys.length) return null;
    // OCRキャンバスは元画像のscale倍なので、黒塗りへ渡す前に元画像座標へ戻す。
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
      distinctStrongCandidates: distinctCandidates.size
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
function collectContextRescueCandidates(results, regionScan, target) {
  const contexts = [];
  const exactHits = [];
  const tlen = [...target].length;

  function addContext(contextText, targetBox, contextBox, source) {
    if (!contextText || contextText.length < 2 || contextText.length > 4) return;
    const key = contextText;
    const gap = contextBox.x0 - targetBox.x1;
    const width = targetBox.x1 - targetBox.x0;
    const height = targetBox.y1 - targetBox.y0;
    if (!(width > 2 && height > 2)) return;
    const old = contexts.find(x => x.text === key);
    const sample = {width, height, gap, source};
    if (old) old.samples.push(sample);
    else contexts.push({text:key, samples:[sample]});
  }

  // 全体OCRの完全一致から文脈を学習。
  for (const r of results || []) {
    for (const line of r.lines || []) {
      const units = extractLineUnits(line);
      const text = units.map(u => u.ch).join('');
      if (!text) continue;
      let from = 0;
      while (from <= text.length - tlen) {
        const idx = text.indexOf(target, from);
        if (idx < 0) break;
        const selected = units.slice(idx, idx + tlen);
        if (selected.length === tlen) {
          const tb = {
            x0: Math.min(...selected.map(u => u.bbox.x0)) / 1,
            y0: Math.min(...selected.map(u => u.bbox.y0)) / 1,
            x1: Math.max(...selected.map(u => u.bbox.x1)) / 1,
            y1: Math.max(...selected.map(u => u.bbox.y1)) / 1
          };
          // targetの直後2～4文字を候補にする。最長を優先して学習する。
          for (const n of [4,3,2]) {
            const after = units.slice(idx + tlen, idx + tlen + n);
            if (after.length >= 2) {
              const ct = after.map(u => u.ch).join('');
              const cb = {
                x0: after[0].bbox.x0,
                y0: Math.min(...after.map(u => u.bbox.y0)),
                x1: Math.max(...after.map(u => u.bbox.x1)),
                y1: Math.max(...after.map(u => u.bbox.y1))
              };
              addContext(ct, tb, cb, r.mode || '全体OCR');
            }
          }
          exactHits.push({text, targetBox:tb});
        }
        from = idx + Math.max(1, tlen);
      }
    }
  }

  // 長い文脈を優先。単独の「ちゃん」より「ちゃん元気」のような文脈が
  // 得られた場合はそちらを先に使う。
  contexts.sort((a,b) => b.text.length - a.text.length);

  const stats = contexts.map(c => {
    const widths = c.samples.map(x=>x.width);
    const heights = c.samples.map(x=>x.height);
    const gaps = c.samples.map(x=>x.gap);
    return {
      text:c.text,
      width:widths.reduce((a,b)=>a+b,0)/widths.length,
      height:heights.reduce((a,b)=>a+b,0)/heights.length,
      gap:gaps.reduce((a,b)=>a+b,0)/gaps.length,
      samples:c.samples.length
    };
  });

  const candidates = [];
  const scanLines = [];
  for (const r of results || []) {
    for (const line of r.lines || []) {
      scanLines.push({units:extractLineUnits(line), scale:1, ox:0, oy:0, source:r.mode || '全体OCR'});
    }
  }
  for (const r of (regionScan?.tested || [])) {
    for (const ld of r.lineData || []) {
      scanLines.push({units:ld.units || [], scale:2, ox:r.x, oy:r.y, source:'局所OCR'});
    }
  }

  for (const c of stats) {
    for (const line of scanLines) {
      const units=line.units || [];
      const text=units.map(u=>u.ch).join('');
      if (!text || text.includes(target)) continue;
      let from=0;
      while (from <= text.length-c.text.length) {
        const idx=text.indexOf(c.text,from);
        if (idx<0) break;
        const contextUnits=units.slice(idx,idx+[...c.text].length);
        if (contextUnits.length === [...c.text].length) {
          const first=contextUnits[0].bbox;
          const last=contextUnits[contextUnits.length-1].bbox;
          const cx0=line.ox + first.x0/line.scale;
          const cy0=line.oy + Math.min(...contextUnits.map(u=>u.bbox.y0))/line.scale;
          const cx1=line.ox + last.x1/line.scale;
          const cy1=line.oy + Math.max(...contextUnits.map(u=>u.bbox.y1))/line.scale;
          const targetW=c.width/line.scale;
          const targetH=c.height/line.scale;
          const gap=Math.max(0,c.gap/line.scale);
          const x1=cx0-gap;
          const x0=x1-targetW;
          const y0=((cy0+cy1)/2)-targetH/2;
          const box={x0,y0,x1,y1:y0+targetH};
          // 同一行に対象文字の完全一致が実際に存在する場合は救出しない。
          const nearExact=exactHits.some(h=>Math.abs(((h.targetBox.x0+h.targetBox.x1)/2)-((box.x0+box.x1)/2))<Math.max(30,targetW*.9) && Math.abs(((h.targetBox.y0+h.targetBox.y1)/2)-((box.y0+box.y1)/2))<Math.max(25,targetH));
          if (!nearExact) candidates.push({context:c.text,box,source:line.source,samples:c.samples,confidence:c.samples>=2?'文脈学習2件以上':'文脈学習1件'});
        }
        from=idx+1;
      }
    }
  }

  // 同じ地点に複数の文脈が重なった場合は1件にまとめる。
  const dedup=[];
  for(const c of candidates){
    const dup=dedup.some(o=>{
      const ix0=Math.max(o.box.x0,c.box.x0),iy0=Math.max(o.box.y0,c.box.y0);
      const ix1=Math.min(o.box.x1,c.box.x1),iy1=Math.min(o.box.y1,c.box.y1);
      if(ix1<=ix0||iy1<=iy0)return false;
      const inter=(ix1-ix0)*(iy1-iy0),area=Math.min((o.box.x1-o.box.x0)*(o.box.y1-o.box.y0),(c.box.x1-c.box.x0)*(c.box.y1-c.box.y0));
      return area>0&&inter/area>.45;
    });
    if(!dup)dedup.push(c);
  }
  return {contexts:stats,candidates:dedup};
}

function mergeMatches(results){const all=results.flatMap(r=>r.matches),final=[];for(const box of all){const dup=final.some(o=>{const ix0=Math.max(box.x0,o.x0),iy0=Math.max(box.y0,o.y0),ix1=Math.min(box.x1,o.x1),iy1=Math.min(box.y1,o.y1);if(ix1<=ix0||iy1<=iy0)return false;const inter=(ix1-ix0)*(iy1-iy0),area=Math.min((box.x1-box.x0)*(box.y1-box.y0),(o.x1-o.x0)*(o.y1-o.y0));return area>0&&inter/area>.45;});if(!dup)final.push(box);}return final;}

async function run(){
  errorEl.hidden=true; ocrDiagnostics.hidden=true; ocrDebugLayer.hidden=true; ocrDebugLayer.innerHTML="";
  try{
    if(!sourceImage) throw new Error("先に画像を選択してください。");
    const target=normalize(targetText.value);
    if(!target) throw new Error("黒塗りする文字を入力してください。");

    manualStamps.length=0; manualHistory.length=0; selectedManualIndex=-1; editMode=null; ocrBaseCanvas=null; redrawFromBase();
    const worker=await getWorker(getOcrLanguage(target));
    status("OCR中…\n対象文字を探しています。");

    // V33の高速OCRをそのまま使用。通常HITはV19の黒塗り処理へ接続する。
    const {results,scale,ocrCanvas}=await collectOcrResults(worker,target);
    const matches=mergeMatches(results);

    // 通常OCRで見つかった対象文字を黒塗り候補として登録。
    // 実際の描画は最後にまとめて行い、OCR結果も手動黒塗りと同じ編集対象にする。
    const paintBoxes=matches.map(b=>({
      x:b.x0, y:b.y0, w:b.x1-b.x0, h:b.y1-b.y0, symbols:b.symbols||[], source:"OCR"
    }));

    // 完全一致した箇所でも、周辺ノイズが少ない状態で高倍率再OCRし、
    // 文字1つ分ズレるようなbboxの誤検出を取り直す。見つからなければ元のboxのまま。
    status("OCR中…\n黒塗り位置を検証しています。");
    for(let i=0;i<paintBoxes.length;i++){
      const refinedBox=await refineExactHitBox(worker,paintBoxes[i],target);
      paintBoxes[i]={...paintBoxes[i],...refinedBox};
    }

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
      if(!duplicate) paintBoxes.push({x:b.x0,y:b.y0,w:b.x1-b.x0,h:b.y1-b.y0,symbols:r.symbols||[],source:r.recovery||"再OCR",rescue:r.recovery==="近似候補救出"});
    }


    // V70：V68の「文字領域全走査＋局所OCR」を正式な追加検出ルートとして使用。
    // 全体OCRで拾えなかった文字も、文字っぽい領域内のPSM7 OCRで拾えた場合は追加する。
    status("OCR中…\n文字領域を追加走査しています。");
    const regionScan = await collectTextRegionMatches(worker, canvas, target);
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

    // V70：周囲の文字を手掛かりにした追加救出。
    // まず今回のOCR結果から「対象文字の直後に出やすい文脈」を学習し、
    // 局所OCRで文脈だけ拾えた地点を対象文字の推定位置として追加する。
    status("OCR中…\n周囲の文字から見落としを確認しています。");
    const contextRescue = collectContextRescueCandidates(results, regionScan, target);
    for (const c of contextRescue.candidates) {
      const b = c.box;
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
          x:b.x0, y:b.y0, w:b.x1-b.x0, h:b.y1-b.y0,
          symbols:[], source:"文脈救出", rescue:true, context:c.context
        });
      }
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
      const rect=getOcrVisualRect({x:b.x,y:b.y,w:b.w,h:b.h},b.symbols||[],b.rescue===true);
      if(rect.w < 1 || rect.h < 1) continue;
      manualStamps.push({
        x:rect.x, y:rect.y, w:rect.w, h:rect.h,
        text:overlayName.checked?overlayText.value:"",
        kind:"ocr"
      });
    }
    redrawFromBase();
    saveBtn.disabled=false; manualBtn.disabled=false;
    const localAdded = Math.max(0, paintBoxes.length - matches.length);
    status(`黒塗り完了：${manualStamps.length}箇所\n通常OCR：${matches.length}箇所 / 追加局所OCR：${localAdded}箇所`);
  }catch(error){status("OCRでエラーが発生しました。下のエラー詳細を確認してください。",error);}
}


// ===== V83.4 実験：14px Canvas文字テンプレート検索（実描画＋形状＋背景） =====
// OCRのbboxをテンプレートの横幅として引き伸ばさず、14pxで実際に描画した文字の
// アルファ領域だけを切り出し、目標高さへ等倍比率で拡大して検索する。
// 診断専用。自動黒塗りにはまだ接続しない。
const TEMPLATE_FONT_STACK='-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", "Yu Gothic", sans-serif';
const TEMPLATE_BASE_FONT_SIZE=14;
const TEMPLATE_TARGET_HEIGHT=32;
const TEMPLATE_STEP=4;
const TEMPLATE_SCORE_THRESHOLD=0.72;
const TEMPLATE_MIN_BRIGHTNESS=105;
const TEMPLATE_FG_WEIGHT=0.72;
const TEMPLATE_BG_WEIGHT=0.28;

function buildTextTemplate(text){
  // まず14pxで描画し、実際に文字が存在するアルファ領域だけをcropする。
  const m=document.createElement('canvas');
  const mc=m.getContext('2d');
  mc.font=`400 ${TEMPLATE_BASE_FONT_SIZE}px ${TEMPLATE_FONT_STACK}`;
  const met=mc.measureText(text);
  const rawW=Math.ceil(met.width)+12;
  const rawH=Math.ceil(TEMPLATE_BASE_FONT_SIZE*1.8);
  m.width=rawW; m.height=rawH;
  const g=m.getContext('2d',{willReadFrequently:true});
  g.clearRect(0,0,rawW,rawH);
  g.font=`400 ${TEMPLATE_BASE_FONT_SIZE}px ${TEMPLATE_FONT_STACK}`;
  g.fillStyle='#fff';
  g.textBaseline='alphabetic';
  g.fillText(text,6,TEMPLATE_BASE_FONT_SIZE+2);

  const d=g.getImageData(0,0,rawW,rawH).data;
  let minX=rawW,minY=rawH,maxX=-1,maxY=-1;
  for(let y=0;y<rawH;y++) for(let x=0;x<rawW;x++){
    if(d[(y*rawW+x)*4+3]>=70){
      if(x<minX)minX=x; if(x>maxX)maxX=x;
      if(y<minY)minY=y; if(y>maxY)maxY=y;
    }
  }
  if(maxX<minX||maxY<minY) return {w:0,h:0,samples:[],bgSamples:[],fontSize:TEMPLATE_BASE_FONT_SIZE};

  const cropW=maxX-minX+1, cropH=maxY-minY+1;
  const targetH=TEMPLATE_TARGET_HEIGHT;
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
    if(a>=90) fg.push({x,y,a:a/255});
    else if(a<=20) bg.push({x,y});
  }

  // 背景点は全点ではなく一定間隔で固定サンプリング。
  const fgStride=Math.max(1,Math.ceil(fg.length/260));
  const bgStride=Math.max(1,Math.ceil(bg.length/220));
  const fgSamples=[];
  const bgSamples=[];
  for(let i=0;i<fg.length;i+=fgStride) fgSamples.push(fg[i]);
  for(let i=0;i<bg.length;i+=bgStride) bgSamples.push(bg[i]);

  return {
    canvas:resized,w:targetW,h:targetH,
    samples:fgSamples,bgSamples,
    rawW:cropW,rawH:cropH,
    fontSize:TEMPLATE_BASE_FONT_SIZE,
    targetHeight:targetH
  };
}

function templateSearch(source,text){
  const tpl=buildTextTemplate(text);
  const sw=source.naturalWidth||source.width, sh=source.naturalHeight||source.height;
  if(!tpl.w||tpl.w>=sw||tpl.h>=sh) return {
    tpl,candidates:[],rawCount:0,step:TEMPLATE_STEP,threshold:TEMPLATE_SCORE_THRESHOLD,
    searchYStart:0,searchYEnd:sh
  };

  const sc=document.createElement('canvas'); sc.width=sw; sc.height=sh;
  const sg=sc.getContext('2d',{willReadFrequently:true}); sg.drawImage(source,0,0,sw,sh);
  const sd=sg.getImageData(0,0,sw,sh).data;
  const gray=new Uint8Array(sw*sh);
  for(let i=0,p=0;i<sd.length;i+=4,p++){
    gray[p]=Math.round(sd[i]*.299+sd[i+1]*.587+sd[i+2]*.114);
  }

  // 上部のプロフィール・アイコン領域を探索から外す。
  // 固定pxではなく画像高さに対する割合なので、端末ごとの解像度差に強い。
  const searchYStart=Math.floor(sh*0.12);
  const searchYEnd=Math.max(searchYStart,sh-tpl.h);
  const searchXStart=Math.floor(sw*0.02);
  const searchXEnd=Math.max(searchXStart,sw-tpl.w-Math.floor(sw*0.02));

  const rowHas=new Uint8Array(sh);
  for(let y=searchYStart;y<=Math.min(sh-1,searchYEnd+tpl.h);y++){
    let count=0;
    for(let x=searchXStart;x<=searchXEnd;x+=3){
      if(gray[y*sw+x]>=TEMPLATE_MIN_BRIGHTNESS){ if(++count>=8) break; }
    }
    if(count>=8) rowHas[y]=1;
  }

  const candidates=[], step=TEMPLATE_STEP;
  for(let y=searchYStart;y<=searchYEnd;y+=step){
    let rowOk=false;
    for(let yy=0;yy<tpl.h;yy+=Math.max(2,step)){
      if(rowHas[y+yy]){rowOk=true;break;}
    }
    if(!rowOk) continue;

    for(let x=searchXStart;x<=searchXEnd;x+=step){
      let fgGood=0, fgTotal=0, bgGood=0, bgTotal=0;
      for(const p of tpl.samples){
        const v=gray[(y+p.y)*sw+(x+p.x)];
        if(v>=TEMPLATE_MIN_BRIGHTNESS) fgGood++;
        fgTotal++;
      }
      // テンプレートで文字がない場所は、画像側でも暗めであることを要求する。
      for(const p of tpl.bgSamples){
        const v=gray[(y+p.y)*sw+(x+p.x)];
        if(v<TEMPLATE_MIN_BRIGHTNESS) bgGood++;
        bgTotal++;
      }
      const fgScore=fgTotal?fgGood/fgTotal:0;
      const bgScore=bgTotal?bgGood/bgTotal:0;
      const score=fgScore*TEMPLATE_FG_WEIGHT+bgScore*TEMPLATE_BG_WEIGHT;
      if(score>=TEMPLATE_SCORE_THRESHOLD){
        if (bgScore >= 0.55) candidates.push({x,y,w:tpl.w,h:tpl.h,score,fgScore,bgScore});
      }
    }
  }

  candidates.sort((a,b)=>b.score-a.score);
  const kept=[];
  for(const c of candidates){
    const dup=kept.some(k=>{
      const ix=Math.max(0,Math.min(c.x+c.w,k.x+k.w)-Math.max(c.x,k.x));
      const iy=Math.max(0,Math.min(c.y+c.h,k.y+k.h)-Math.max(c.y,k.y));
      return ix*iy>Math.min(c.w*c.h,k.w*k.h)*.35;
    });
    if(!dup) kept.push(c);
    if(kept.length>=30) break;
  }
  return {
    tpl,candidates:kept,rawCount:candidates.length,
    step,threshold:TEMPLATE_SCORE_THRESHOLD,
    searchYStart,searchYEnd,searchXStart,searchXEnd
  };
}
// ===== /V83 実験 =====

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
    const totalStarted=performance.now();
    const worker=await getWorker(getOcrLanguage(target));
    canvas.hidden=false; canvas.style.display="block";
    status("OCR診断中…\n認識条件を比較しています。画像表示は維持します。");
    const ocrStarted=performance.now();
    const {results,scale,ocrCanvas,stats}=await collectOcrResults(worker,target);
    const templateResult=templateSearch(sourceImage,target);
    const ocrElapsed=performance.now()-ocrStarted;
    const refineStarted=performance.now();
    const refine=await refineNearCandidates(worker,results,ocrCanvas,target,scale);
    const refineElapsed=performance.now()-refineStarted;
    const {groups:candidateGroups,refined,acceptedNear}=refine;
    // V70.1: 診断側でも文脈救出結果を必ず初期化する。
    // 実処理(run)では局所OCR結果も渡すが、診断ではここまでで局所OCRを
    // 実行していないため、まず全体OCRだけを対象にする。
    const contextRescue = collectContextRescueCandidates(results, null, target);
    const totalElapsed=performance.now()-totalStarted;
    const exactCount=results.reduce((n,r)=>n+r.matches.length,0);
    const candidateCount=results.reduce((n,r)=>n+r.near.length,0);
    const lines=[`対象文字：${targetText.value}`,`正規化後：${target}`,`OCR境界線：${OCR_BORDER_PX}px（白）`,""];
    for(const r of results){
      lines.push(`===== ${r.mode} / PSM 11 =====`,`HIT：${r.matches.length}件`);
      for(const m of r.matches){
        const b={x0:m.x0*scale,y0:m.y0*scale,x1:m.x1*scale,y1:m.y1*scale};
        lines.push(`  HIT行：「${m.lineText}」`,`    target bbox=(${b.x0},${b.y0})-(${b.x1},${b.y1})`);
        m.symbols.forEach((s,i)=>{const q=s.bbox;lines.push(`      symbol[${i}] 「${s.ch}」 raw=「${s.raw}」 bbox=(${q.x0},${q.y0})-(${q.x1},${q.y1})`);});
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
        lines.push(`近似候補救出：「${target}」として採用 / OCR候補「${x.candidate}」 / 編集距離${x.recoveryDistance} / 類似度${Math.round(x.similarity*100)}% / 同地点候補${x.candidateCount}件 / 強候補${x.strongCandidateCount}件`);
      }
    }
    if(!refined.length && !acceptedNear.length) lines.push('再OCR・近似候補救出で対象文字を確認できた候補地点はありません。');

    lines.push("",`===== 完全一致の位置検証（周辺再OCR） =====`);
    const exactMatches=mergeMatches(results);
    const verifyStarted=performance.now();
    let changedCount=0;
    for(const m of exactMatches){
      const before={x:m.x0,y:m.y0,w:m.x1-m.x0,h:m.y1-m.y0};
      const after=await refineExactHitBox(worker,before,target);
      const moved=Math.abs(after.x-before.x)>1||Math.abs(after.y-before.y)>1||Math.abs(after.w-before.w)>1||Math.abs(after.h-before.h)>1;
      if(moved)changedCount++;
      lines.push(`「${m.lineText}」： 元bbox=(${Math.round(before.x)},${Math.round(before.y)},w${Math.round(before.w)},h${Math.round(before.h)}) → 検証後=(${Math.round(after.x)},${Math.round(after.y)},w${Math.round(after.w)},h${Math.round(after.h)}) ${moved?'※位置を修正':'変更なし'}`);
      // 実際に黒塗りが描画される最終矩形も、同じ計算式でここに再現しておく。
      // 「見た目上どうなるか」を診断だけで確認できるようにするため。
      const paintBox=getOcrPaintBox(after,after.symbols||[]);
      const padding=Math.max(OCR_MIN_PADDING,Math.round(Math.min(paintBox.w,paintBox.h)*OCR_PADDING_RATIO));
      let finalLeft=Math.max(0,paintBox.x-OCR_EDGE_PAD-padding);
      const finalRight=Math.min(canvas.width,paintBox.x+paintBox.w+OCR_EDGE_PAD+padding);
      if(typeof paintBox._leftBoundary==="number"){
        const minWidth=Math.max(8,paintBox.w*0.5);
        finalLeft=Math.max(finalLeft,Math.min(paintBox._leftBoundary,finalRight-minWidth));
      }
      const finalWidth=Math.max(1,finalRight-finalLeft);
      const finalTop=Math.max(0,paintBox.y-padding);
      const finalHeight=paintBox.h+padding*2;
      lines.push(`　→ 最終黒塗り座標=(${Math.round(finalLeft)},${Math.round(finalTop)},w${Math.round(finalWidth)},h${Math.round(finalHeight)})${finalWidth<=4?' ※幅が極端に狭い(縦棒の疑いあり)':''}`);
    }
    const verifyElapsed=performance.now()-verifyStarted;
    lines.push(`検証時間：${(verifyElapsed/1000).toFixed(2)}秒 / 修正：${changedCount}件 / 対象：${exactMatches.length}件`);

    // V67実験：V64の文字領域推定を維持し、通常OCRで見つからなかった領域だけ
    // 前処理違いの局所OCRを追加する。
    lines.push("",`===== 文字領域全走査＋局所OCR実験（V70） =====`);
    const regionResult=await runTextRegionExperiment(worker,canvas,target);
    lines.push(`検出候補：${regionResult.detected.regions.length}領域 / 局所OCR実行：${regionResult.tested.length}領域 / 走査間隔：${regionResult.detected.sample}px / 通常：2倍・PSM7`);
    lines.push(`追加前処理：なし / 追加OCR実行：0回`);
    const regionHits=regionResult.tested.filter(r=>r.hit);
    const baseHits=regionResult.tested.filter(r=>r.baseHit);
    const extraHits=regionResult.tested.filter(r=>r.extraHit);
    const robustRegionHits=regionResult.tested.filter(r=>(r.variants||[]).some(v=>(v.robustMatches||[]).length));
    lines.push(`対象文字HIT：${regionHits.length}領域（通常OCR：${baseHits.length} / 前処理追加：${extraHits.length} / Robust追加：${robustRegionHits.length}）`);
    regionResult.tested.forEach((r,i)=>{
      const hitModes=r.variants.filter(v=>v.hit).map(v=>v.mode);
      const robustModes=r.variants.filter(v=>(v.robustMatches||[]).length).map(v=>v.mode);
      const display=hitModes.length?`★対象HIT [${hitModes.join('・')}]`:'HITなし';
      const robustDisplay=robustModes.length?` / ☆Robust [${robustModes.join('・')}]`:'';
      const rawPreview=r.variants.map(v=>`${v.mode}「${v.raw.length>55?v.raw.slice(0,55)+'…':v.raw}」`).join(' / ');
      lines.push(`  領域${i+1}: (${r.x},${r.y},w${r.w},h${r.h}) / ${r.mode} / ${display}${robustDisplay} / ${rawPreview}`);
    });
    lines.push(`局所OCR時間：${(regionResult.elapsed/1000).toFixed(2)}秒`);
    lines.push(`色抽出OCR：${stats.colorHitCount||0}件 / ${(stats.colorMs/1000).toFixed(2)}秒`);
    lines.push(`※ V68の全領域走査方式を診断用にも使用。V70本体では、この局所OCRのHITを追加の黒塗り候補として統合します。`);

    lines.push("",`===== V83.5 Canvasテンプレート検索実験（背景閾値強化＋探索範囲調整） =====`);
    lines.push(`対象文字：${target} / Canvas基準フォント：${TEMPLATE_BASE_FONT_SIZE}px / 目標文字高：${TEMPLATE_TARGET_HEIGHT}px / 探索間隔：${templateResult.step||TEMPLATE_STEP}px / 閾値：${TEMPLATE_SCORE_THRESHOLD}`);
    lines.push(`テンプレート：${templateResult.tpl?.w||0}x${templateResult.tpl?.h||0}px（14px描画→実文字領域crop→比率維持拡大）`);
    lines.push(`探索範囲：x=${templateResult.searchXStart||0}〜${templateResult.searchXEnd||0} / y=${templateResult.searchYStart||0}〜${templateResult.searchYEnd||0}（上部を広めに除外（開始Yを280pxへ調整））`);
    lines.push(`候補：${templateResult.candidates?.length||0}件（粗候補${templateResult.rawCount||0}件）`);
    (templateResult.candidates||[]).slice(0,20).forEach((c,i)=>lines.push(`  候補${i+1}: score ${c.score.toFixed(3)} / 形状${c.fgScore.toFixed(3)} / 背景${c.bgScore.toFixed(3)} / (${c.x},${c.y},w${c.w},h${c.h})`));
    lines.push(`※ V83.4ではまだ黒塗りには使用しません。緑枠はCanvasテンプレート検索の候補です。`);

    lines.push("",`===== V82.1 誤認識救出診断（かな）＋候補bbox仮表示 =====`);
    const v81KanaRescue=findV81KanaRescue(results,target,scale);
    const hasKanjiTarget=[...target].some(isV81Kanji);
    if(hasKanjiTarget){
      lines.push(`対象文字に漢字を含むため、V81では誤認識置換を実行しません。`);
      lines.push(`漢字は置換辞書ではなく、今後は文字形・位置・サイズ等を組み合わせて救出する方針です。`);
    }else if(![...target].every(isV81Kana)){
      lines.push(`対象文字はかな専用救出の対象外です。`);
    }else{
      lines.push(`かな誤認識による新規候補：${v81KanaRescue.length}件`);
      v81KanaRescue.slice(0,20).forEach((c,i)=>{
        lines.push(`  候補${i+1}: OCR「${c.ocr}」→対象「${c.target}」 / 置換${c.substitutions}文字 / bbox=(${Math.round(c.box.x0)},${Math.round(c.box.y0)},w${Math.round(c.box.x1-c.box.x0)},h${Math.round(c.box.y1-c.box.y0)}) / 「${c.lineText}」`);
      });
      if(!v81KanaRescue.length) lines.push(`かな誤認識による新規候補はありません。`);
      lines.push(`※ V82.1ではまだ黒塗りに使用しません。候補が出た場合のみ赤枠で仮表示します。`);
    }

    lines.push('', `===== V76 局所OCR・順序維持ロバスト一致実験 =====`);
    const localRobust=[];
    for(const r of regionResult.tested){
      for(const v of (r.variants||[])){
        for(const n of (v.nearMatches||[])){
          localRobust.push({...n, region:r, mode:v.mode, raw:v.raw});
        }
      }
    }
    const robustUnique=[];
    for(const n of localRobust){
      const duplicate=robustUnique.some(q=>{
        const a=n.targetBox,b=q.targetBox;
        const ix0=Math.max(a.x0,b.x0),iy0=Math.max(a.y0,b.y0),ix1=Math.min(a.x1,b.x1),iy1=Math.min(a.y1,b.y1);
        if(ix1<=ix0||iy1<=iy0)return false;
        const inter=(ix1-ix0)*(iy1-iy0);
        const area=Math.min((a.x1-a.x0)*(a.y1-a.y0),(b.x1-b.x0)*(b.y1-b.y0));
        return area>0&&inter/area>.5;
      });
      if(!duplicate)robustUnique.push(n);
    }
    lines.push(`Robust一致：${localRobust.length}件 / 位置重複除外後：${robustUnique.length}件`);
    robustUnique.slice(0,30).forEach((n,i)=>{
      const b=n.targetBox;
      const skippedText=(n.skipped||[]).map(u=>u.ch).join('');
      lines.push(`  候補${i+1}: 対象「${target}」 / スキップ${(n.skipped||[]).length}unit${skippedText?`「${skippedText}」`:''} / (${Math.round(b.x0)},${Math.round(b.y0)},w${Math.round(b.x1-b.x0)},h${Math.round(b.y1-b.y0)}) / ${n.region.mode} / ${n.region.x},${n.region.y}`);
    });
    lines.push(`※ 文字の誤認置換はせず、対象文字が指定順で実際に認識された場合だけ対象とします。完全一致は別枠です。`);

    // V63実験：文字列全体ではなく、OCRが拾えた各文字を個別テンプレート化して組み合わせる。
    lines.push("",`===== 文字単体テンプレート照合実験（V63） =====`);
    if(exactMatches.length){
      const ref=exactMatches[0];
      const gr=runGlyphTemplateMatch(canvas,ref);
      if(gr.error){
        lines.push(gr.error);
      }else{
        lines.push(`基準文字：${gr.glyphs.map(g=>`「${g.ch}」=(${g.x},${g.y},w${g.w},h${g.h})`).join(' / ')}`);
        lines.push(`走査間隔：${gr.step}px / 採用閾値：${gr.threshold.toFixed(2)} / 想定文字間隔：dx=${gr.expectedDx}, dy=${gr.expectedDy}`);
        gr.perGlyph.forEach(g=>{
          lines.push(`文字「${g.ch}」：閾値以上 ${g.rawCount}件`);
          g.candidates.slice(0,5).forEach((c,i)=>lines.push(`  候補${i+1}: score ${c.score.toFixed(3)} / (${c.x},${c.y},w${c.w},h${c.h})`));
        });
        if(gr.pairs.length){
          lines.push(`2文字セット成立候補：${gr.pairs.length}件`);
          gr.pairs.slice(0,10).forEach((p,i)=>lines.push(`  セット${i+1}: score ${p.score.toFixed(3)} / ね(${p.x},${p.y}) + る(dx=${p.dx},dy=${p.dy}) / 個別 ${p.scoreA.toFixed(3)}・${p.scoreB.toFixed(3)}`));
        }else{
          lines.push(`2文字セット成立候補：0件`);
        }
        lines.push(`※ 文字単体の形＋2文字の相対位置だけを見ています。今回は黒塗りには使用しません。`);
      }
    }else{
      lines.push(`完全一致HITがないため文字テンプレートを作成できません。`);
    }

    lines.push("",`===== V70 文脈救出 =====`);
    if(contextRescue.contexts.length){
      lines.push(`学習文脈：${contextRescue.contexts.map(c=>`「${c.text}」(${c.samples}件)`).join(' / ')}`);
    }else{
      lines.push(`学習文脈：なし`);
    }
    lines.push(`文脈候補：${contextRescue.candidates.length}件 / 救出候補：${contextRescue.candidates.length}件`);
    contextRescue.candidates.slice(0,20).forEach((c,i)=>{
      lines.push(`  候補${i+1}: 文脈「${c.context}」 / (${Math.round(c.box.x0)},${Math.round(c.box.y0)},w${Math.round(c.box.x1-c.box.x0)},h${Math.round(c.box.y1-c.box.y0)}) / ${c.source} / ${c.confidence}`);
    });
    lines.push(`※ V70では、完全一致HITから対象文字の直後の2～4文字を文脈として学習します。`);
    lines.push(`※ 文脈だけが認識された地点では、既知の対象文字サイズと対象→文脈の間隔から位置を推定します。`);

    lines.push("",`===== 処理時間 =====`,
      `OCR全体：${(ocrElapsed/1000).toFixed(2)}秒`,
      `  第1段階（グレー＋コントラスト）：${(stats.primaryMs/1000).toFixed(2)}秒 / HIT ${stats.primaryHitCount}件`,
      `  追加全体OCR：${stats.fallbackUsed ? (stats.fallbackMs/1000).toFixed(2)+"秒 / 実行" : "0.00秒 / 省略"}`,
      `候補再OCR：${(refineElapsed/1000).toFixed(2)}秒`,
      `診断全体：${(totalElapsed/1000).toFixed(2)}秒`,
      `候補地点：${candidateGroups.length} / 色抽出HIT：${stats.colorHitCount||0} / 近似候補救出：${refine.fastRecovered} / 再OCR実行：${refine.attempted} / 再OCR追加パス：${refine.extraPasses} / 既存HITで省略：${refine.skippedExact}`,
      "",
      `※ 今回は速度実験として、まずグレー＋コントラストだけを全体OCRします。`,
      `※ 第1段階で1件以上HITした場合、二値化180・220・反転の全体OCRは省略します。`,
      `※ 第1段階でHITが0件の場合だけ、二値化180・220・反転を追加します。`,
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
      seen.push(m); const box=document.createElement('div'); box.className='ocr-debug-box'; box.style.borderColor='#22aa55'; box.style.left=`${tr.left+m.x0*tr.scaleX}px`; box.style.top=`${tr.top+m.y0*tr.scaleY}px`; box.style.width=`${(m.x1-m.x0)*tr.scaleX}px`; box.style.height=`${(m.y1-m.y0)*tr.scaleY}px`; const label=document.createElement('span'); label.className='ocr-debug-label'; label.textContent=`${r.mode}: ${target}`; box.appendChild(label); ocrDebugLayer.appendChild(box);
    }
    // V83: Canvasテンプレート候補を緑枠で表示。黒塗りには使用しない。
    for(const c of (templateResult.candidates||[])){
      const box=document.createElement('div');
      box.className='ocr-debug-box'; box.style.borderColor='#00aa66';
      box.style.left=`${tr.left+c.x*tr.scaleX}px`; box.style.top=`${tr.top+c.y*tr.scaleY}px`;
      box.style.width=`${c.w*tr.scaleX}px`; box.style.height=`${c.h*tr.scaleY}px`;
      const label=document.createElement('span'); label.className='ocr-debug-label';
      label.textContent=`V83: ${target} ${c.score.toFixed(2)}`; box.appendChild(label); ocrDebugLayer.appendChild(box);
    }

    // V82.1: かな誤認識候補は黒塗りせず、画像上に赤枠だけ表示。
    const kanaCandidates = v81KanaRescue.slice(0,20);
    for(const c of kanaCandidates){
      const b=c.box;
      const box=document.createElement('div');
      box.className='ocr-debug-box'; box.style.borderColor='#ff3333';
      box.style.left=`${tr.left+b.x0*tr.scaleX}px`; box.style.top=`${tr.top+b.y0*tr.scaleY}px`;
      box.style.width=`${(b.x1-b.x0)*tr.scaleX}px`; box.style.height=`${(b.y1-b.y0)*tr.scaleY}px`;
      const label=document.createElement('span'); label.className='ocr-debug-label';
      label.textContent=`V82.1候補: ${c.ocr}→${c.target}`; box.appendChild(label);
      ocrDebugLayer.appendChild(box);
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

function startManualMode() {
    if (!sourceImage) return;
    manualMode = true;
    document.body.classList.add("manual-mode");
    manualHelp.hidden = false;
    manualDoneBtn.hidden = false;
    manualBtn.disabled = true;
    status("手動黒塗りモードです。\n画像上をドラッグして隠したい範囲を選択してください。");
}

function stopManualMode() {
    manualMode = false;
    document.body.classList.remove("manual-mode");
    isDragging = false;
    dragStart = null;
    stampTapStart = null;
    selection.hidden = true;
    manualHelp.hidden = true;
    manualDoneBtn.hidden = true;
    manualBtn.disabled = !sourceImage;
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
        text: overlayName.checked ? overlayText.value : "",
        kind: "manual"
    };

    stamp.x = Math.max(0, Math.min(canvas.width - stamp.w, stamp.x));
    stamp.y = Math.max(0, Math.min(canvas.height - stamp.h, stamp.y));

    pushManualHistory();
    manualStamps.push(stamp);
    paintManual(stamp, stamp.text);
    updateUndoButton();
    saveBtn.disabled = false;
    status(`スタンプを追加しました。\n追加済み：${manualStamps.length}箇所`);
}

function finishStamp(point) {
    if (!dragStart) return;
    const x = Math.min(dragStart.x, point.x);
    const y = Math.min(dragStart.y, point.y);
    const w = Math.abs(point.x - dragStart.x);
    const h = Math.abs(point.y - dragStart.y);
    selection.hidden = true;

    if (w < 4 || h < 4) {
        dragStart = null;
        return;
    }

    const stamp = { x, y, w, h, text: overlayName.checked ? overlayText.value : "", kind: "manual" };
    pushManualHistory();
    manualStamps.push(stamp);
    paintManual(stamp, stamp.text);
    updateUndoButton();
    saveBtn.disabled = false;
    status(`手動黒塗りを追加しました。\n追加済み：${manualStamps.length}箇所`);
    dragStart = null;
}

function getRawManualPoint(event) {
    return getCanvasPoint(event);
}

// 新規黒塗りを作るときだけ、指から少し左上へ操作位置をずらす。
// 既存黒塗りの編集（移動・サイズ変更）では指の位置をそのまま使う。
function getManualPoint(event, applyOffset = true) {
    if (applyOffset && event.pointerType === "touch") {
        return getCanvasPoint({
            clientX: event.clientX + TOUCH_X_OFFSET,
            clientY: event.clientY + TOUCH_Y_OFFSET
        });
    }
    return getRawManualPoint(event);
}

function getPointerCenter() {
    const values = [...pointers.values()];
    if (!values.length) return null;
    return {
        x: values.reduce((sum, p) => sum + p.x, 0) / values.length,
        y: values.reduce((sum, p) => sum + p.y, 0) / values.length
    };
}

canvasWrap.addEventListener("pointerdown", event => {
    if (!sourceImage) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvasWrap.setPointerCapture?.(event.pointerId);

    if (pointers.size >= 2) {
        isDragging = false;
        dragStart = null;
        selection.hidden = true;
        pinchStartDistance = getPointerDistance();
        pinchStartZoom = zoom;
        panLastCenter = getPointerCenter();
        event.preventDefault();
        return;
    }

    panLastCenter = null;

    if (!manualMode) return;
    event.preventDefault();
    const rawPoint = getRawManualPoint(event);

    // 既存の手動黒塗りをタップすると編集対象にする。
    // 編集時はオフセットを使わず、指の位置をそのまま操作位置にする。
    // スタンプモード中でも、まず既存黒塗りの編集を優先する。
    const hitIndex = hitTestManual(rawPoint);
    if (hitIndex >= 0) {
        dragStart = rawPoint;
        selectedManualIndex = hitIndex;
        const hitStamp = manualStamps[hitIndex];
        const handle = getResizeHandle(rawPoint, hitStamp);
        editMode = {
            type: handle ? "resize" : "move",
            handle,
            startPoint: { ...dragStart },
            original: { ...hitStamp },
            historyPushed: false
        };
        isDragging = true;
        renderManualSelection();
        status("黒塗りを選択中です。\n中央をドラッグ：移動 / 四隅をドラッグ：サイズ変更");
        return;
    }

    selectedManualIndex = -1;
    editMode = null;
    renderManualSelection();

    // 新規黒塗りは指から左上へオフセットした位置を使う。
    dragStart = getManualPoint(event, true);

    if (stampMode.checked && getLastManualStamp()) {
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
    updateSelection(dragStart, dragStart);
});

canvasWrap.addEventListener("pointermove", event => {
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
        const point = getManualPoint(event, true);
        const last = getLastManualStamp();
        updateSelection(
            { x: point.x - last.w / 2, y: point.y - last.h / 2 },
            { x: point.x + last.w / 2, y: point.y + last.h / 2 }
        );
        return;
    }

    if (!isDragging || !dragStart) return;
    updateSelection(dragStart, getManualPoint(event, true));
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
        redrawFromBase();
        return;
    }

    if (stampMode.checked && stampTapStart && getLastManualStamp()) {
        const moved = Math.hypot(event.clientX - stampTapStart.x, event.clientY - stampTapStart.y);
        const point = getManualPoint(event);
        stampTapStart = null;
        selection.hidden = true;
        dragStart = null;
        isDragging = false;
        if (moved < 12) placeStampAt(point);
        return;
    }

    if (!isDragging || !dragStart) return;
    isDragging = false;
    finishStamp(getManualPoint(event));
}

canvasWrap.addEventListener("pointerup", endPointer);
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
    selection.hidden = true;
});

stampMode.addEventListener("change", () => {
    if (!stampMode.checked) {
        selection.hidden = true;
        status("スタンプモードをOFFにしました。\n通常の手動黒塗りに戻ります。");
    } else if (manualStamps.length) {
        status("スタンプモードONです。\n画像をタップすると、直前の手動黒塗りと同じサイズで黒塗りします。");
    }
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
    ocrBaseCanvas = null;
    redrawFromBase();
    status("黒塗りをすべてリセットしました。");
});

manualBtn.addEventListener("click", startManualMode);
manualDoneBtn.addEventListener("click", stopManualMode);

fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
        stopManualMode();
        ocrDiagnostics.hidden = true;
        ocrDebugLayer.hidden = true;
        ocrDebugLayer.innerHTML = "";
        sourceImage = await loadImage(file);
        fileName = (file.name.replace(/\.[^.]+$/, "") || "redacted") + "_redacted.png";
        manualStamps.length = 0;
        manualHistory.length = 0;
        selectedManualIndex = -1;
        editMode = null;
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

async function saveImage() {
    if (!sourceImage || !canvas.width || !canvas.height) {
        status("先に画像を処理してください。");
        return;
    }

    saveBtn.disabled = true;
    try {
        const blob = await canvasToBlob();
        const file = new File([blob], fileName, { type: "image/png" });

        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
            status("画像を共有シートに渡しました。\n必要な場所へ保存してください。");
            return;
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status("PNGを保存しました。");
    } catch (error) {
        status(error?.name === "AbortError" ? "保存をキャンセルしました。" : "画像の保存に失敗しました。もう一度お試しください。", error?.name === "AbortError" ? null : error);
    } finally {
        saveBtn.disabled = false;
    }
}

saveBtn.addEventListener("click", saveImage);

window.addEventListener("beforeunload", () => worker?.terminate());
