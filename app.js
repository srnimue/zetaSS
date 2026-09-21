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
        const targetRaw = targetText.value;
        const target = normalize(targetRaw);
        if (!target) throw new Error("黒塗りする文字を入力してください。");

        const ocrWorker = await getWorker(getOcrLanguage(target));
        const scale = 2.5;
        const baseCanvas = document.createElement("canvas");
        baseCanvas.width = Math.round(canvas.width * scale);
        baseCanvas.height = Math.round(canvas.height * scale);
        const baseCtx = baseCanvas.getContext("2d");
        baseCtx.imageSmoothingEnabled = true;
        baseCtx.imageSmoothingQuality = "high";
        baseCtx.drawImage(sourceImage, 0, 0, baseCanvas.width, baseCanvas.height);

        // OCRそのものの読み方を比較する実験版。
        // 黒塗り処理には一切触れず、前処理 × PSM の違いだけを調べる。
        const modes = [
            { name: "通常", make: src => src },
            { name: "グレースケール＋コントラスト", make: src => makeGrayContrast(src) },
            { name: "二値化180", make: src => makeBinary(src, 180) },
            { name: "二値化220", make: src => makeBinary(src, 220) },
            { name: "反転", make: src => makeInvert(src) }
        ];
        const psms = ["3", "6", "11", "12"];

        function cloneCanvas(src) {
            const out = document.createElement("canvas");
            out.width = src.width;
            out.height = src.height;
            out.getContext("2d").drawImage(src, 0, 0);
            return out;
        }

        function processPixels(src, fn) {
            const out = cloneCanvas(src);
            const c = out.getContext("2d");
            const imageData = c.getImageData(0, 0, out.width, out.height);
            fn(imageData.data);
            c.putImageData(imageData, 0, 0);
            return out;
        }

        function makeGrayContrast(src) {
            return processPixels(src, data => {
                for (let i = 0; i < data.length; i += 4) {
                    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                    const value = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128));
                    data[i] = data[i + 1] = data[i + 2] = value;
                }
            });
        }

        function makeBinary(src, threshold) {
            return processPixels(src, data => {
                for (let i = 0; i < data.length; i += 4) {
                    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                    const value = gray < threshold ? 0 : 255;
                    data[i] = data[i + 1] = data[i + 2] = value;
                }
            });
        }

        function makeInvert(src) {
            return processPixels(src, data => {
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = 255 - data[i];
                    data[i + 1] = 255 - data[i + 1];
                    data[i + 2] = 255 - data[i + 2];
                }
            });
        }

        function levenshtein(a, b) {
            const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
            for (let i = 1; i <= a.length; i++) {
                const cur = [i];
                for (let j = 1; j <= b.length; j++) {
                    cur[j] = Math.min(
                        cur[j - 1] + 1,
                        prev[j] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
                    );
                }
                for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
            }
            return prev[b.length];
        }

        function similarity(a, b) {
            if (!a || !b) return 0;
            const distance = levenshtein(a, b);
            return Math.max(0, 1 - distance / Math.max(a.length, b.length));
        }

        function getCandidateWords(words) {
            const candidates = [];
            const seen = new Set();
            for (const word of words) {
                const raw = String(word?.text || "");
                const normalized = normalize(raw);
                if (!normalized || !word?.bbox) continue;
                const score = similarity(normalized, target);
                const contains = normalized.includes(target);
                // 完全一致・部分一致は必ず候補にし、近似は70%以上だけ表示。
                if (contains || score >= 0.70) {
                    const key = `${raw}|${word.bbox.x0}|${word.bbox.y0}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        candidates.push({ raw, normalized, score, contains, bbox: word.bbox, confidence: word.confidence });
                    }
                }
            }
            candidates.sort((a, b) => Number(b.contains) - Number(a.contains) || b.score - a.score);
            return candidates.slice(0, 8);
        }

        function getLineCandidates(lines) {
            const candidates = [];
            for (const line of lines || []) {
                const words = (line.words || []).filter(w => w?.bbox && normalize(w.text));
                if (!words.length) continue;
                const compact = words.map(w => normalize(w.text)).join("");
                const exactIndex = compact.indexOf(target);
                if (exactIndex >= 0) {
                    candidates.push({ type: "line-exact", text: compact, score: 1, words });
                    continue;
                }
                // 行全体ではなく、target長の前後を少し含む窓を調べる。
                const windowLength = target.length;
                for (let i = 0; i <= Math.max(0, compact.length - 1); i++) {
                    const window = compact.slice(i, i + windowLength);
                    if (!window) continue;
                    const score = similarity(window, target);
                    if (score >= 0.70) {
                        candidates.push({ type: "line-near", text: window, score, words });
                    }
                }
            }
            candidates.sort((a, b) => b.score - a.score);
            return candidates.slice(0, 5);
        }

        async function inspect(inputCanvas, mode, psm) {
            const result = await ocrWorker.recognize(inputCanvas, { tessedit_pageseg_mode: psm });
            const data = result?.data || {};
            const words = data.words || [];
            const lines = data.lines || [];
            const rawText = String(data.text || "");
            const exactWords = words.filter(word => normalize(word?.text).includes(target));
            const candidateWords = getCandidateWords(words);
            const lineCandidates = getLineCandidates(lines);
            const avgConfidence = words.length
                ? words.reduce((sum, word) => sum + Number(word.confidence || 0), 0) / words.length
                : null;
            return {
                mode, psm, words, lines, rawText,
                exactWords,
                candidateWords,
                lineCandidates,
                avgConfidence
            };
        }

        const results = [];
        const total = modes.length * psms.length;
        let count = 0;

        for (const mode of modes) {
            const processed = mode.make(baseCanvas);
            for (const psm of psms) {
                count++;
                status(`OCR実験中… ${count}/${total}\n${mode.name} × PSM ${psm}`);
                const result = await inspect(processed, mode.name, psm);
                results.push(result);
            }
        }

        const lines = [];
        lines.push(`対象文字：${targetRaw}`);
        lines.push(`正規化後：${target}`);
        lines.push(`実験：${modes.length}種類の前処理 × ${psms.length}種類のPSM = ${total}回のOCR`);
        lines.push("");
        lines.push("===== 結果一覧 =====");
        for (const result of results) {
            const exact = result.exactWords.length;
            const near = result.candidateWords.filter(c => !c.contains);
            const best = result.candidateWords[0];
            lines.push(`${result.mode} / PSM ${result.psm}`);
            lines.push(`  完全一致・部分一致：${exact}件 / 平均confidence：${result.avgConfidence == null ? "-" : result.avgConfidence.toFixed(1)}`);
            if (best) {
                lines.push(`  近似候補：${best.contains ? "HIT" : "候補"} 「${best.raw}」 norm=「${best.normalized}」 類似度=${Math.round(best.score * 100)}% conf=${Number(best.confidence ?? 0).toFixed(1)}`);
            } else {
                lines.push("  近似候補：なし");
            }
        }

        lines.push("");
        lines.push("===== 近似候補の詳細 =====");
        for (const result of results) {
            const candidates = result.candidateWords;
            if (!candidates.length && !result.lineCandidates.length) continue;
            lines.push(`\n--- ${result.mode} / PSM ${result.psm} ---`);
            for (const c of candidates) {
                const b = c.bbox;
                lines.push(`word ${c.contains ? "★" : "・"} 「${c.raw}」 norm=「${c.normalized}」 類似度=${Math.round(c.score * 100)}% conf=${Number(c.confidence ?? 0).toFixed(1)} bbox=(${b.x0},${b.y0})-(${b.x1},${b.y1})`);
                const sourceWord = result.words.find(w => w === undefined ? false : w?.bbox === c.bbox);
                const symbols = sourceWord?.symbols || [];
                if (symbols.length) {
                    lines.push("  symbols：" + symbols.map((s, i) => `「${s.text || ""}」(${Math.round(s.bbox?.x0 ?? 0)},${Math.round(s.bbox?.y0 ?? 0)}-${Math.round(s.bbox?.x1 ?? 0)},${Math.round(s.bbox?.y1 ?? 0)})`).join(" "));
                }
            }
            for (const c of result.lineCandidates) {
                lines.push(`line ${c.type === "line-exact" ? "★" : "・"} 「${c.text}」 類似度=${Math.round(c.score * 100)}%`);
            }
        }

        lines.push("");
        lines.push("===== 認識テキスト比較 =====");
        // 各前処理について、最も対象文字に近かったPSMの全文だけ表示する。
        for (const mode of modes) {
            const sameMode = results.filter(r => r.mode === mode.name);
            sameMode.sort((a, b) => {
                const scoreA = a.exactWords.length ? 1 : (a.candidateWords[0]?.score || 0);
                const scoreB = b.exactWords.length ? 1 : (b.candidateWords[0]?.score || 0);
                return scoreB - scoreA;
            });
            const best = sameMode[0];
            lines.push(`--- ${mode.name} / PSM ${best.psm} ---`);
            lines.push(best.rawText.replace(/\n/g, " / "));
        }

        const exactResults = results.filter(r => r.exactWords.length > 0);
        const nearResults = results.filter(r => r.candidateWords.length > 0);
        lines.push("");
        lines.push("===== 総合 =====");
        lines.push(`完全一致・部分一致が見つかった条件：${exactResults.length} / ${total}`);
        lines.push(`70%以上の近似候補が見つかった条件：${nearResults.length} / ${total}`);
        if (nearResults.length) {
            const best = [...nearResults].sort((a, b) => {
                const scoreA = a.exactWords.length ? 1 : (a.candidateWords[0]?.score || 0);
                const scoreB = b.exactWords.length ? 1 : (b.candidateWords[0]?.score || 0);
                return scoreB - scoreA;
            })[0];
            const c = best.candidateWords[0];
            lines.push(`最有力候補：${best.mode} / PSM ${best.psm} → 「${c.raw}」 類似度=${Math.round(c.score * 100)}%`);
        }
        lines.push("");
        lines.push("※ この実験では画像への黒塗りは一切行いません。");
        lines.push("※ 完全一致・部分一致は、OCR結果を正規化して検索した結果です。");
        lines.push("※ 近似候補はLevenshtein距離による目安で、正解判定ではありません。");
        lines.push("※ bboxはOCR用2.5倍画像の座標です。");
        lines.push("※ 20回のOCRを行うため、端末によってはかなり時間がかかります。");
        ocrDiagnostics.textContent = lines.join("\n");

        // 最も良かった条件の候補だけ画像上に表示する。20条件分の枠は重ねない。
        if (nearResults.length) {
            const best = [...nearResults].sort((a, b) => {
                const scoreA = a.exactWords.length ? 1 : (a.candidateWords[0]?.score || 0);
                const scoreB = b.exactWords.length ? 1 : (b.candidateWords[0]?.score || 0);
                return scoreB - scoreA;
            })[0];
            const candidate = best.candidateWords[0];
            if (candidate?.bbox) {
                const b = candidate.bbox;
                const transform = getCanvasDisplayTransform();
                const x = (b.x0 / scale) * transform.scaleX;
                const y = (b.y0 / scale) * transform.scaleY;
                const w = ((b.x1 - b.x0) / scale) * transform.scaleX;
                const h = ((b.y1 - b.y0) / scale) * transform.scaleY;
                const box = document.createElement("div");
                box.className = "ocr-debug-box";
                box.style.borderColor = "#ff3333";
                box.style.left = `${transform.left + x}px`;
                box.style.top = `${transform.top + y}px`;
                box.style.width = `${w}px`;
                box.style.height = `${h}px`;
                const label = document.createElement("span");
                label.className = "ocr-debug-label";
                label.textContent = `${best.mode} / PSM ${best.psm}: ${candidate.raw} (${Math.round(candidate.score * 100)}%)`;
                box.appendChild(label);
                ocrDebugLayer.appendChild(box);
                ocrDebugLayer.hidden = false;
            }
        }

        const bestText = nearResults.length ? (() => {
            const best = [...nearResults].sort((a, b) => (b.candidateWords[0]?.score || 0) - (a.candidateWords[0]?.score || 0))[0];
            return `${best.mode} / PSM ${best.psm} / 「${best.candidateWords[0].raw}」`;
        })() : "候補なし";
        status(`OCR実験完了。\n完全一致・部分一致：${exactResults.length}/${total}\n近似候補：${nearResults.length}/${total}\n最有力：${bestText}`);
    } catch (error) {
        status("OCR実験でエラーが発生しました。", error);
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
