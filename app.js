const $ = id => document.getElementById(id);

// 診断モードを不要になったら false にするだけで非表示にできます。
const ENABLE_DIAGNOSTIC = false;

const fileInput = $("fileInput");
const targetText = $("targetText");
const overlayText = $("overlayText");
const overlayName = $("overlayName");
const stampMode = $("stampMode");
const redactBtn = $("redactBtn");
const diagnoseBtn = $("diagnoseBtn");
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

const OCR_LEFT_TRIM = 0; // OCR対象範囲の左端微調整。+で左側を削る。
const OCR_EDGE_PAD = 2; // 対象文字の字形がbboxから少しはみ出す場合の左右余白(px)

function paintOcr(box, text = "") {
    const padding = Math.max(3, Math.round(Math.min(box.w, box.h) * 0.08));
    const left = Math.max(0, box.x - OCR_EDGE_PAD - padding + OCR_LEFT_TRIM);
    const right = Math.min(canvas.width, box.x + box.w + OCR_EDGE_PAD + padding);
    const width = Math.max(1, right - left);
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
                status(`${preferredLang === "jpn" ? "日本語" : "英語"}OCR準備中… ${message.status || ""} ${Math.round(message.progress * 100)}%`);
            }
        }
    });
    workerLang = preferredLang;
    return worker;
}

function getOcrLanguage(target) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(target) ? "jpn" : "eng";
}

async function run() {
    errorEl.hidden = true;
    ocrDiagnostics.hidden = true;
    ocrDebugLayer.hidden = true;
    ocrDebugLayer.innerHTML = "";

    try {
        if (!sourceImage) throw new Error("先に画像を選択してください。");

        const target = normalize(targetText.value);
        if (!target) throw new Error("黒塗りする文字を入力してください。");

        manualStamps.length = 0;
        ocrBaseCanvas = null;
        redrawFromBase();

        const ocrWorker = await getWorker(getOcrLanguage(target));
        const scale = 2.5;
        const ocrCanvas = document.createElement("canvas");
        ocrCanvas.width = Math.round(canvas.width * scale);
        ocrCanvas.height = Math.round(canvas.height * scale);
        const ocrCtx = ocrCanvas.getContext("2d");
        ocrCtx.imageSmoothingEnabled = true;
        ocrCtx.imageSmoothingQuality = "high";
        ocrCtx.drawImage(sourceImage, 0, 0, ocrCanvas.width, ocrCanvas.height);

        async function recognizeTarget(inputCanvas) {
            const result = await ocrWorker.recognize(inputCanvas, { tessedit_pageseg_mode: "11" });
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

            function targetBoxInWord(word) {
                const wordText = normalize(word?.text);
                if (!word?.bbox || !wordText.includes(target)) return null;

                // Tesseractが文字単位のbboxを返してくれる場合は、それを使って
                // 「対象文字そのもの」だけを囲む。これが今回の本命処理。
                const symbols = (word.symbols || []).filter(s => s?.bbox && normalize(s.text));
                if (symbols.length) {
                    const chars = [];
                    for (const symbol of symbols) {
                        for (const ch of normalize(symbol.text)) {
                            chars.push({ ch, bbox: symbol.bbox });
                        }
                    }
                    const joined = chars.map(c => c.ch).join("");
                    const index = joined.indexOf(target);
                    if (index >= 0) {
                        const selected = chars.slice(index, index + target.length);
                        if (selected.length) {
                            return {
                                x0: Math.min(...selected.map(c => c.bbox.x0)),
                                y0: Math.min(...selected.map(c => c.bbox.y0)),
                                x1: Math.max(...selected.map(c => c.bbox.x1)),
                                y1: Math.max(...selected.map(c => c.bbox.y1))
                            };
                        }
                    }
                }

                // 文字単位bboxがない環境では、単語bbox内の文字位置から概算する。
                // 完璧ではないが、行全体を黒塗りするより対象文字にかなり近づけられる。
                const idx = wordText.indexOf(target);
                const ratioStart = idx / Math.max(1, wordText.length);
                const ratioEnd = (idx + target.length) / Math.max(1, wordText.length);
                const b = word.bbox;
                return {
                    x0: b.x0 + (b.x1 - b.x0) * ratioStart,
                    y0: b.y0,
                    x1: b.x0 + (b.x1 - b.x0) * ratioEnd,
                    y1: b.y1
                };
            }

            for (const word of words) {
                const box = targetBoxInWord(word);
                if (box) addMatch(box);
            }

            // 複数wordにまたがる対象にも対応。可能なら各wordの文字bboxを使い、
            // 対象文字列に該当する連続範囲だけをまとめる。
            for (const line of lines) {
                const lineWords = (line.words || []).filter(word => word?.bbox);
                if (!lineWords.length) continue;
                for (let i = 0; i < lineWords.length; i++) {
                    let combined = "";
                    for (let j = i; j < lineWords.length; j++) {
                        combined += normalize(lineWords[j].text);
                        if (!combined) continue;
                        const idx = combined.indexOf(target);
                        if (idx >= 0) {
                            const before = combined.slice(0, idx).length;
                            let remainStart = before;
                            let remainEnd = before + target.length;
                            const selected = [];
                            let offset = 0;
                            for (const word of lineWords.slice(i, j + 1)) {
                                const wt = normalize(word.text);
                                const a = Math.max(remainStart, offset);
                                const b = Math.min(remainEnd, offset + wt.length);
                                if (b > a) {
                                    const localA = a - offset;
                                    const localB = b - offset;
                                    const wb = word.bbox;
                                    selected.push({
                                        x0: wb.x0 + (wb.x1 - wb.x0) * localA / Math.max(1, wt.length),
                                        y0: wb.y0,
                                        x1: wb.x0 + (wb.x1 - wb.x0) * localB / Math.max(1, wt.length),
                                        y1: wb.y1
                                    });
                                }
                                offset += wt.length;
                            }
                            if (selected.length) {
                                addMatch({
                                    x0: Math.min(...selected.map(b => b.x0)),
                                    y0: Math.min(...selected.map(b => b.y0)),
                                    x1: Math.max(...selected.map(b => b.x1)),
                                    y1: Math.max(...selected.map(b => b.y1))
                                });
                            }
                            break;
                        }
                        if (combined.length >= target.length + 3) break;
                    }
                }
            }

            return matches;
        }

        status("画像をOCR中…\n小さい文字を読み取りやすくしています。");
        let matches = await recognizeTarget(ocrCanvas);

        // 通常画像で見つからない場合だけ、ネガポジ反転版でもOCRする。
        // 元画像は一切変更せず、OCRに渡す画像だけを反転する。
        if (!matches.length) {
            status("通常のOCRで見つからなかったため、反転画像でも検索中…");
            const invertedCanvas = document.createElement("canvas");
            invertedCanvas.width = ocrCanvas.width;
            invertedCanvas.height = ocrCanvas.height;
            const invCtx = invertedCanvas.getContext("2d");
            invCtx.drawImage(ocrCanvas, 0, 0);
            const imageData = invCtx.getImageData(0, 0, invertedCanvas.width, invertedCanvas.height);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 255 - data[i];
                data[i + 1] = 255 - data[i + 1];
                data[i + 2] = 255 - data[i + 2];
            }
            invCtx.putImageData(imageData, 0, 0);
            matches = await recognizeTarget(invertedCanvas);
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


async function diagnoseOCR() {
    ocrDiagnostics.hidden = false;
    ocrDebugLayer.hidden = true;
    ocrDebugLayer.innerHTML = "";

    try {
        if (!sourceImage) throw new Error("先に画像を選択してください。");
        const target = normalize(targetText.value);
        if (!target) throw new Error("黒塗りする文字を入力してください。");

        const ocrWorker = await getWorker(getOcrLanguage(target));
        const scale = 2.5;
        const ocrCanvas = document.createElement("canvas");
        ocrCanvas.width = Math.round(canvas.width * scale);
        ocrCanvas.height = Math.round(canvas.height * scale);
        const ocrCtx = ocrCanvas.getContext("2d");
        ocrCtx.imageSmoothingEnabled = true;
        ocrCtx.imageSmoothingQuality = "high";
        ocrCtx.drawImage(sourceImage, 0, 0, ocrCanvas.width, ocrCanvas.height);

        async function inspect(inputCanvas, mode) {
            const result = await ocrWorker.recognize(inputCanvas, { tessedit_pageseg_mode: "11" });
            const data = result?.data || {};
            const words = data.words || [];
            const lines = data.lines || [];
            const rows = [];
            const matchedWords = [];

            for (const word of words) {
                const text = String(word?.text || "");
                if (!text.trim() || !word?.bbox) continue;
                const normalized = normalize(text);
                const symbols = (word.symbols || []).filter(s => s?.bbox && normalize(s.text));
                const hit = normalized.includes(target);
                if (hit) matchedWords.push(word);
                rows.push({ mode, text, normalized, confidence: word.confidence, bbox: word.bbox, symbolCount: symbols.length, hit });
            }

            const targetHits = [];
            for (const word of words) {
                const normalized = normalize(word?.text);
                if (!word?.bbox || !normalized.includes(target)) continue;
                const b = word.bbox;
                const symbols = (word.symbols || []).filter(s => s?.bbox && normalize(s.text));
                let targetBox = null;
                let targetSymbols = [];
                if (symbols.length) {
                    const chars = [];
                    for (const symbol of symbols) {
                        for (const ch of normalize(symbol.text)) {
                            chars.push({ ch, bbox: symbol.bbox, raw: symbol.text });
                        }
                    }
                    const joined = chars.map(c => c.ch).join("");
                    const idx = joined.indexOf(target);
                    if (idx >= 0) {
                        const selected = chars.slice(idx, idx + target.length);
                        if (selected.length) {
                            targetSymbols = selected.map(c => ({
                                text: c.ch,
                                raw: c.raw,
                                bbox: c.bbox
                            }));
                            targetBox = {
                                x0: Math.min(...selected.map(c => c.bbox.x0)),
                                y0: Math.min(...selected.map(c => c.bbox.y0)),
                                x1: Math.max(...selected.map(c => c.bbox.x1)),
                                y1: Math.max(...selected.map(c => c.bbox.y1))
                            };
                        }
                    }
                }
                targetHits.push({ mode, text: word.text, bbox: b, targetBox, targetSymbols, method: targetBox ? "symbols" : "word-ratio" });
            }

            return { mode, words: rows, lines, targetHits, rawText: String(data.text || "") };
        }

        status("OCR診断中…\n通常画像を調べています。");
        const normal = await inspect(ocrCanvas, "通常");

        status("OCR診断中…\n反転画像も調べています。");
        const invertedCanvas = document.createElement("canvas");
        invertedCanvas.width = ocrCanvas.width;
        invertedCanvas.height = ocrCanvas.height;
        const invCtx = invertedCanvas.getContext("2d");
        invCtx.drawImage(ocrCanvas, 0, 0);
        const imageData = invCtx.getImageData(0, 0, invertedCanvas.width, invertedCanvas.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] = 255 - imageData.data[i];
            imageData.data[i + 1] = 255 - imageData.data[i + 1];
            imageData.data[i + 2] = 255 - imageData.data[i + 2];
        }
        invCtx.putImageData(imageData, 0, 0);
        const inverted = await inspect(invertedCanvas, "反転");

        const lines = [];
        lines.push(`対象文字：${targetText.value}`);
        lines.push(`正規化後：${target}`);
        lines.push("");
        for (const result of [normal, inverted]) {
            lines.push(`===== ${result.mode}画像 =====`);
            lines.push(`認識文字数：${result.words.length}`);
            lines.push(`対象文字を含む単語：${result.targetHits.length}`);
            if (result.targetHits.length) {
                for (const hit of result.targetHits) {
                    const b = hit.bbox;
                    const t = hit.targetBox || b;
                    lines.push(`  HIT: 「${hit.text}」 / word bbox=(${b.x0},${b.y0})-(${b.x1},${b.y1}) / target bbox=(${t.x0},${t.y0})-(${t.x1},${t.y1}) / ${hit.method}`);
                    if (hit.targetSymbols?.length) {
                        for (const [i, symbol] of hit.targetSymbols.entries()) {
                            const sb = symbol.bbox;
                            lines.push(`    symbol[${i}] 「${symbol.text}」 raw=「${symbol.raw}」 bbox=(${sb.x0},${sb.y0})-(${sb.x1},${sb.y1})`);
                        }
                    } else {
                        lines.push(`    symbol: 対象文字に対応するsymbol bboxを取得できませんでした`);
                    }
                }
            }
            lines.push(`認識テキスト：${result.rawText.replace(/\n/g, " / ")}`);
            lines.push("-- 認識単語一覧 --");
            for (const row of result.words) {
                const b = row.bbox;
                lines.push(`${row.hit ? "★" : " "} 「${row.text}」 norm=「${row.normalized}」 conf=${Number(row.confidence ?? 0).toFixed(1)} bbox=(${b.x0},${b.y0})-(${b.x1},${b.y1}) symbols=${row.symbolCount}`);
            }
            lines.push("");
        }
        lines.push(`※ OCR画像サイズ：${ocrCanvas.width} × ${ocrCanvas.height}px / 元画像：${canvas.width} × ${canvas.height}px`);
        lines.push("※ bboxはOCR用の2.5倍画像の座標です。黒塗り時は元画像座標へ1/2.5倍して使用します。");
        lines.push("※ ★はOCRが対象文字列を含む単語として認識したものです。");
        lines.push("※ symbol[0], symbol[1]…は対象文字を構成する1文字ごとのOCR座標です。");
        lines.push("※ この診断では画像への黒塗りは行いません。");
        ocrDiagnostics.textContent = lines.join("\n");

        // 対象文字を含む単語のbboxだけを画像上に表示する。通常=枠、反転=別の枠。
        const transform = getCanvasDisplayTransform();
        function addDebugBoxes(result, borderStyle) {
            for (const hit of result.targetHits) {
                const b = hit.targetBox || hit.bbox;
                const x = (b.x0 / scale) * transform.scaleX;
                const y = (b.y0 / scale) * transform.scaleY;
                const w = ((b.x1 - b.x0) / scale) * transform.scaleX;
                const h = ((b.y1 - b.y0) / scale) * transform.scaleY;
                const box = document.createElement("div");
                box.className = "ocr-debug-box";
                box.style.borderColor = borderStyle;
                box.style.left = `${transform.left + x}px`;
                box.style.top = `${transform.top + y}px`;
                box.style.width = `${w}px`;
                box.style.height = `${h}px`;
                const label = document.createElement("span");
                label.className = "ocr-debug-label";
                label.textContent = `${result.mode}: ${hit.text}`;
                box.appendChild(label);
                ocrDebugLayer.appendChild(box);
            }
        }
        addDebugBoxes(normal, "#ff3333");
        addDebugBoxes(inverted, "#3366ff");
        ocrDebugLayer.hidden = ocrDebugLayer.childElementCount === 0;
        status(`OCR診断完了。\n通常：${normal.targetHits.length}件 / 反転：${inverted.targetHits.length}件\n下の診断結果を確認してください。`);
    } catch (error) {
        status("OCR診断でエラーが発生しました。", error);
    }
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
        ocrDiagnostics.hidden = true;
        ocrDebugLayer.hidden = true;
        ocrDebugLayer.innerHTML = "";
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
        diagnoseBtn.disabled = !ENABLE_DIAGNOSTIC;
        manualBtn.disabled = false;
        saveBtn.disabled = false;
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
            await navigator.share({ files: [file], title: "スクショ" });
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
