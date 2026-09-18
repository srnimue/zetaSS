const $ = id => document.getElementById(id);

const fileInput = $("fileInput");
const targetText = $("targetText");
const overlayText = $("overlayText");
const overlayName = $("overlayName");
const stampMode = $("stampMode");
const redactBtn = $("redactBtn");
const manualBtn = $("manualBtn");
const undoBtn = $("undoBtn");
const manualDoneBtn = $("manualDoneBtn");
const saveBtn = $("saveBtn");
const manualHelp = $("manualHelp");
const statusEl = $("status");
const errorEl = $("errorDetails");
const canvasWrap = $("canvasWrap");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const selection = $("selection");
const zoomOutBtn = $("zoomOutBtn");
const zoomInBtn = $("zoomInBtn");
const zoomLabel = $("zoomLabel");

let sourceImage = null;
let worker = null;
let fileName = "redacted.png";
let manualMode = false;
let stampTapStart = null;
let isDragging = false;
let dragStart = null;
let ocrBaseCanvas = null;
const manualStamps = [];

let zoom = 1;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const pointers = new Map();
let pinchStartDistance = 0;
let pinchStartZoom = 1;

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

const OCR_LEFT_TRIM = 30; // 自動塗りつぶしの左端だけ、ここで右方向へ削る（px）

function paintOcr(box, text = "") {
    const padding = Math.max(4, Math.round(Math.min(box.w, box.h) * 0.12));
    const left = Math.max(0, box.x - padding + OCR_LEFT_TRIM);
    const width = Math.max(1, box.w + padding - OCR_LEFT_TRIM);
    const top = Math.max(0, box.y - padding);
    const height = box.h + padding * 2;

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

function updateUndoButton() {
    undoBtn.disabled = manualStamps.length === 0;
    stampMode.disabled = manualStamps.length === 0;
    if (manualStamps.length === 0) stampMode.checked = false;
}

function redrawFromBase() {
    if (!sourceImage) return;

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
        paintManual(stamp, stamp.text);
    }
    updateUndoButton();
}

async function getWorker() {
    if (worker) return worker;
    if (!window.Tesseract) {
        throw new Error("Tesseract.jsを読み込めませんでした。インターネット接続や外部スクリプト制限を確認してください。");
    }

    status("OCRエンジンを準備中…\n初回は少し時間がかかります。");
    worker = await Tesseract.createWorker("jpn+eng", 1, {
        logger: message => {
            if (message?.progress != null) {
                status(`OCR準備中… ${message.status || ""} ${Math.round(message.progress * 100)}%`);
            }
        }
    });
    return worker;
}

async function run() {
    errorEl.hidden = true;

    try {
        if (!sourceImage) throw new Error("先に画像を選択してください。");

        const target = normalize(targetText.value);
        if (!target) throw new Error("黒塗りする文字を入力してください。");

        manualStamps.length = 0;
        ocrBaseCanvas = null;
        redrawFromBase();

        const ocrWorker = await getWorker();
        const scale = 2.5;
        const ocrCanvas = document.createElement("canvas");
        ocrCanvas.width = Math.round(canvas.width * scale);
        ocrCanvas.height = Math.round(canvas.height * scale);
        const ocrCtx = ocrCanvas.getContext("2d");
        ocrCtx.imageSmoothingEnabled = true;
        ocrCtx.imageSmoothingQuality = "high";
        ocrCtx.drawImage(sourceImage, 0, 0, ocrCanvas.width, ocrCanvas.height);

        status("画像をOCR中…\n小さい文字を読み取りやすくしています。");

        const result = await ocrWorker.recognize(ocrCanvas, { tessedit_pageseg_mode: "11" });
        const data = result?.data || {};
        const words = data.words || [];
        const lines = data.lines || [];
        const matches = [];
        const seen = new Set();

        function addMatch(bbox) {
            if (!bbox) return;
            const x0 = bbox.x0 / scale, y0 = bbox.y0 / scale;
            const x1 = bbox.x1 / scale, y1 = bbox.y1 / scale;
            const w = x1 - x0, h = y1 - y0;
            if (w < 2 || h < 2 || w > canvas.width * .8) return;
            const key = [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)].join(":");
            if (!seen.has(key)) {
                seen.add(key);
                matches.push({ x0, y0, x1, y1 });
            }
        }

        for (const word of words) {
            if (normalize(word.text).includes(target)) addMatch(word.bbox);
        }

        for (const line of lines) {
            const text = normalize(line.text);
            if (!text.includes(target)) continue;

            const lineWords = (line.words || []).filter(word => word?.bbox);
            if (!lineWords.length) {
                addMatch(line.bbox);
                continue;
            }

            let found = false;
            for (let i = 0; i < lineWords.length && !found; i++) {
                let combined = "";
                for (let j = i; j < lineWords.length; j++) {
                    combined += normalize(lineWords[j].text);
                    if (!combined) continue;

                    if (combined.includes(target)) {
                        const selected = lineWords.slice(i, j + 1);
                        addMatch({
                            x0: Math.min(...selected.map(w => w.bbox.x0)),
                            y0: Math.min(...selected.map(w => w.bbox.y0)),
                            x1: Math.max(...selected.map(w => w.bbox.x1)),
                            y1: Math.max(...selected.map(w => w.bbox.y1))
                        });
                        found = true;
                        break;
                    }
                    if (combined.length >= target.length + 3) break;
                }
            }
            if (!found) addMatch(line.bbox);
        }

        const finalMatches = [];
        for (const box of matches) {
            const duplicate = finalMatches.some(other => {
                const ix0 = Math.max(box.x0, other.x0);
                const iy0 = Math.max(box.y0, other.y0);
                const ix1 = Math.min(box.x1, other.x1);
                const iy1 = Math.min(box.y1, other.y1);
                if (ix1 <= ix0 || iy1 <= iy0) return false;
                const intersection = (ix1 - ix0) * (iy1 - iy0);
                const area = Math.min(
                    (box.x1 - box.x0) * (box.y1 - box.y0),
                    (other.x1 - other.x0) * (other.y1 - other.y0)
                );
                return area > 0 && intersection / area > .45;
            });
            if (!duplicate) finalMatches.push(box);
        }

        for (const box of finalMatches) {
            paintOcr({
                x: box.x0, y: box.y0,
                w: box.x1 - box.x0,
                h: box.y1 - box.y0
            }, overlayName.checked ? overlayText.value : "");
        }

        ocrBaseCanvas = document.createElement("canvas");
        ocrBaseCanvas.width = canvas.width;
        ocrBaseCanvas.height = canvas.height;
        ocrBaseCanvas.getContext("2d").drawImage(canvas, 0, 0);

        status(`黒塗り完了：${finalMatches.length}箇所\n取りこぼしがあれば「手動黒塗り」で追加できます。`);
        saveBtn.disabled = false;
        manualBtn.disabled = false;

    } catch (error) {
        status("OCRでエラーが発生しました。下のエラー詳細を確認してください。", error);
    }
}

function getCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height
    };
}

function updateSelection(start, current) {
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const w = Math.abs(current.x - start.x);
    const h = Math.abs(current.y - start.y);

    // canvasWrap はズーム時にスクロールするため、
    // getBoundingClientRect() の座標をそのまま使うと
    // 選択線だけスクロール量ぶんズレます。
    // offsetLeft / offsetTop を使って、スクロール領域内の座標に戻します。
    const displayScaleX = canvas.offsetWidth / canvas.width;
    const displayScaleY = canvas.offsetHeight / canvas.height;

    selection.hidden = false;
    selection.style.left = `${canvas.offsetLeft + x * displayScaleX}px`;
    selection.style.top = `${canvas.offsetTop + y * displayScaleY}px`;
    selection.style.width = `${w * displayScaleX}px`;
    selection.style.height = `${h * displayScaleY}px`;
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

    const last = manualStamps[manualStamps.length - 1];
    const stamp = {
        x: point.x - last.w / 2,
        y: point.y - last.h / 2,
        w: last.w,
        h: last.h,
        text: overlayName.checked ? overlayText.value : ""
    };

    stamp.x = Math.max(0, Math.min(canvas.width - stamp.w, stamp.x));
    stamp.y = Math.max(0, Math.min(canvas.height - stamp.h, stamp.y));

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

    const stamp = { x, y, w, h, text: overlayName.checked ? overlayText.value : "" };
    manualStamps.push(stamp);
    paintManual(stamp, stamp.text);
    updateUndoButton();
    saveBtn.disabled = false;
    status(`手動黒塗りを追加しました。\n追加済み：${manualStamps.length}箇所`);
    dragStart = null;
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
        event.preventDefault();
        return;
    }

    if (!manualMode) return;
    event.preventDefault();
    dragStart = getCanvasPoint(event);

    if (stampMode.checked && manualStamps.length) {
        stampTapStart = { x: event.clientX, y: event.clientY };
        isDragging = false;
        const last = manualStamps[manualStamps.length - 1];
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
        if (pinchStartDistance > 0 && distance > 0) {
            setZoom(pinchStartZoom * distance / pinchStartDistance);
        }
        event.preventDefault();
        return;
    }

    if (!manualMode) return;
    event.preventDefault();

    if (stampMode.checked && stampTapStart && manualStamps.length) {
        const point = getCanvasPoint(event);
        const last = manualStamps[manualStamps.length - 1];
        updateSelection(
            { x: point.x - last.w / 2, y: point.y - last.h / 2 },
            { x: point.x + last.w / 2, y: point.y + last.h / 2 }
        );
        return;
    }

    if (!isDragging || !dragStart) return;
    updateSelection(dragStart, getCanvasPoint(event));
});

function endPointer(event) {
    pointers.delete(event.pointerId);

    if (pointers.size >= 1) {
        isDragging = false;
        dragStart = null;
        selection.hidden = true;
        return;
    }

    if (!manualMode) return;
    event.preventDefault();

    if (stampMode.checked && stampTapStart && manualStamps.length) {
        const moved = Math.hypot(event.clientX - stampTapStart.x, event.clientY - stampTapStart.y);
        const point = getCanvasPoint(event);
        stampTapStart = null;
        selection.hidden = true;
        dragStart = null;
        isDragging = false;
        if (moved < 12) placeStampAt(point);
        return;
    }

    if (!isDragging || !dragStart) return;
    isDragging = false;
    finishStamp(getCanvasPoint(event));
}

canvasWrap.addEventListener("pointerup", endPointer);
canvasWrap.addEventListener("pointercancel", event => {
    pointers.delete(event.pointerId);
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
    if (!manualStamps.length) return;
    manualStamps.pop();
    redrawFromBase();
    status(`直前の手動黒塗りを取り消しました。\n残り：${manualStamps.length}箇所`);
});

manualBtn.addEventListener("click", startManualMode);
manualDoneBtn.addEventListener("click", stopManualMode);

fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
        stopManualMode();
        sourceImage = await loadImage(file);
        fileName = (file.name.replace(/\.[^.]+$/, "") || "redacted") + "_redacted.png";
        manualStamps.length = 0;
        ocrBaseCanvas = null;
        canvas.width = sourceImage.naturalWidth;
        canvas.height = sourceImage.naturalHeight;
        zoom = 1;
        ctx.drawImage(sourceImage, 0, 0);
        updateZoomUI();
        redactBtn.disabled = false;
        manualBtn.disabled = false;
        saveBtn.disabled = false;
        updateUndoButton();
        status(`画像を読み込みました。\n${canvas.width} × ${canvas.height}px`);
    } catch (error) {
        status("画像の読み込みに失敗しました。", error);
    }
});

redactBtn.addEventListener("click", run);

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
            await navigator.share({ files: [file], title: "Zetaスクショ" });
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
