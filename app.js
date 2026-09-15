const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const targetText = $("targetText");
const overlayText = $("overlayText");
const overlayName = $("overlayName");

const redactBtn = $("redactBtn");
const saveBtn = $("saveBtn");

const statusEl = $("status");
const errorEl = $("errorDetails");

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

let sourceImage = null;
let worker = null;
let fileName = "redacted.png";

function status(message, error = null) {
    statusEl.textContent = message;
    errorEl.hidden = !error;

    if (error) {
        errorEl.textContent = [
            `message: ${error.message || error}`,
            `name: ${error.name || ""}`,
            "",
            error.stack || error
        ].join("\n");
    } else {
        errorEl.textContent = "";
    }
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();

        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };

        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("画像を読み込めませんでした。"));
        };

        image.src = url;
    });
}

function normalize(text) {
    return String(text || "")
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu, "")
        .toLowerCase();
}

function paint(box, text, options = {}) {
    const extraLeft = options.extraLeft ?? 6;
    const padding = options.padding ?? Math.max(
        4,
        Math.round(Math.min(box.w, box.h) * 0.12)
    );

    const left = Math.max(0, box.x - padding - extraLeft);
    const top = Math.max(0, box.y - padding);
    const width = box.w + padding + (options.extraRight ?? 0);
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

async function getWorker() {
    if (worker) {
        return worker;
    }

    if (!window.Tesseract) {
        throw new Error(
            "Tesseract.jsを読み込めませんでした。" +
            "インターネット接続や外部スクリプト制限を確認してください。"
        );
    }

    status("OCRエンジンを準備中…\n初回は少し時間がかかります。");

    worker = await Tesseract.createWorker(
        "jpn+eng",
        1,
        {
            logger: (message) => {
                if (message?.progress != null) {
                    status(
                        `OCR準備中… ${message.status || ""} ` +
                        `${Math.round(message.progress * 100)}%`
                    );
                }
            }
        }
    );

    return worker;
}

async function run() {
    errorEl.hidden = true;

    try {
        if (!sourceImage) {
            throw new Error("先に画像を選択してください。");
        }

        const target = normalize(targetText.value);

        if (!target) {
            throw new Error("黒塗りする文字を入力してください。");
        }

        canvas.width = sourceImage.naturalWidth;
        canvas.height = sourceImage.naturalHeight;
        ctx.drawImage(sourceImage, 0, 0);

        const ocrWorker = await getWorker();

        /*
         * OCR専用の画像を拡大します。
         * 元画像は変更せず、Tesseractには2.5倍の画像を渡します。
         * 小さな名前を拾いやすくするのが目的です。
         */
        const scale = 2.5;
        const ocrCanvas = document.createElement("canvas");
        ocrCanvas.width = Math.round(canvas.width * scale);
        ocrCanvas.height = Math.round(canvas.height * scale);
        const ocrCtx = ocrCanvas.getContext("2d");

        ocrCtx.imageSmoothingEnabled = true;
        ocrCtx.imageSmoothingQuality = "high";
        ocrCtx.drawImage(
            sourceImage,
            0,
            0,
            ocrCanvas.width,
            ocrCanvas.height
        );

        status("画像をOCR中…\n小さい文字を読み取りやすくしています。");

        const result = await ocrWorker.recognize(ocrCanvas, {
            tessedit_pageseg_mode: "11"
        });

        const data = result?.data || {};
        const words = data.words || [];
        const lines = data.lines || [];

        const matches = [];
        const seen = new Set();

        function addMatch(bbox, source) {
            if (!bbox) {
                return;
            }

            const x0 = bbox.x0 / scale;
            const y0 = bbox.y0 / scale;
            const x1 = bbox.x1 / scale;
            const y1 = bbox.y1 / scale;

            /* 極端に小さい/巨大な誤認識を除外 */
            const w = x1 - x0;
            const h = y1 - y0;

            if (w < 2 || h < 2 || w > canvas.width * 0.8) {
                return;
            }

            const key = [
                Math.round(x0),
                Math.round(y0),
                Math.round(x1),
                Math.round(y1)
            ].join(":");

            if (!seen.has(key)) {
                seen.add(key);
                matches.push({ bbox, source });
            }
        }

        /* まず通常のword単位で探す */
        for (const word of words) {
            if (normalize(word.text).includes(target)) {
                addMatch(word.bbox, "word");
            }
        }

        /*
         * wordで分割されてしまった名前をline単位でも探します。
         * 例：「にみゅ」が「に」「みゅ」のように分割された場合にも対応。
         */
        for (const line of lines) {
            const text = normalize(line.text);

            if (!text.includes(target)) {
                continue;
            }

            const lineWords = (line.words || []).filter((word) => {
                return word?.bbox;
            });

            if (lineWords.length === 0) {
                addMatch(line.bbox, "line");
                continue;
            }

            /*
             * target文字列がline内のどのword付近にあるかを推定します。
             * OCRの文字順に沿って、targetの長さぶんのwordを候補にします。
             */
            let found = false;

            for (let i = 0; i < lineWords.length; i++) {
                let combined = "";

                for (let j = i; j < lineWords.length; j++) {
                    combined += normalize(lineWords[j].text);

                    if (!combined) {
                        continue;
                    }

                    if (combined.includes(target)) {
                        const selected = lineWords.slice(i, j + 1);
                        const x0 = Math.min(...selected.map(w => w.bbox.x0));
                        const y0 = Math.min(...selected.map(w => w.bbox.y0));
                        const x1 = Math.max(...selected.map(w => w.bbox.x1));
                        const y1 = Math.max(...selected.map(w => w.bbox.y1));

                        addMatch({ x0, y0, x1, y1 }, "line-words");
                        found = true;
                        break;
                    }

                    if (combined.length >= target.length + 3) {
                        break;
                    }
                }

                if (found) {
                    break;
                }
            }

            /* word分割の推定に失敗した場合はline全体を候補にする */
            if (!found) {
                addMatch(line.bbox, "line");
            }
        }

        /*
         * 同じ名前をwordとline-wordsの両方で拾った場合に、
         * 重なっている矩形をまとめます。
         */
        const finalMatches = [];

        for (const match of matches) {
            const b = match.bbox;
            const x0 = b.x0 / scale;
            const y0 = b.y0 / scale;
            const x1 = b.x1 / scale;
            const y1 = b.y1 / scale;

            const duplicate = finalMatches.some((other) => {
                const ob = other;
                const ix0 = Math.max(x0, ob.x0);
                const iy0 = Math.max(y0, ob.y0);
                const ix1 = Math.min(x1, ob.x1);
                const iy1 = Math.min(y1, ob.y1);

                if (ix1 <= ix0 || iy1 <= iy0) {
                    return false;
                }

                const intersection = (ix1 - ix0) * (iy1 - iy0);
                const area = Math.min(
                    (x1 - x0) * (y1 - y0),
                    (ob.x1 - ob.x0) * (ob.y1 - ob.y0)
                );

                return area > 0 && intersection / area > 0.45;
            });

            if (!duplicate) {
                finalMatches.push({ x0, y0, x1, y1 });
            }
        }

        for (const box of finalMatches) {
            paint(
                {
                    x: box.x0,
                    y: box.y0,
                    w: box.x1 - box.x0,
                    h: box.y1 - box.y0
                },
                overlayName.checked ? overlayText.value : ""
            );
        }

        status(`黒塗り完了：${finalMatches.length}箇所`);
        saveBtn.disabled = false;

    } catch (error) {
        status(
            "OCRでエラーが発生しました。下のエラー詳細を確認してください。",
            error
        );
    }
}

function canvasToBlob() {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error("PNG画像の作成に失敗しました。"));
            }
        }, "image/png");
    });
}

async function saveImage() {
    if (!sourceImage || canvas.width === 0 || canvas.height === 0) {
        status("先に画像を処理してください。");
        return;
    }

    saveBtn.disabled = true;

    try {
        const blob = await canvasToBlob();
        const file = new File([blob], fileName, { type: "image/png" });

        /* iPhone / iPadではWeb Shareの共有シートから「画像を保存」が使える */
        if (
            navigator.share &&
            navigator.canShare &&
            navigator.canShare({ files: [file] })
        ) {
            await navigator.share({
                files: [file],
                title: "Zetaスクショ"
            });
            status("画像を共有シートに渡しました。必要な場所へ保存してください。");
            return;
        }

        /* PCなどでは通常のダウンロードを試す */
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
        /* 共有シートをキャンセルした場合はエラー扱いにしない */
        if (error?.name === "AbortError") {
            status("保存をキャンセルしました。");
        } else {
            status(
                "画像の保存に失敗しました。もう一度お試しください。",
                error
            );
        }
    } finally {
        saveBtn.disabled = false;
    }
}

fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];

    if (!file) {
        return;
    }

    try {
        sourceImage = await loadImage(file);

        fileName =
            (file.name.replace(/\.[^.]+$/, "") || "redacted") +
            "_redacted.png";

        canvas.width = sourceImage.naturalWidth;
        canvas.height = sourceImage.naturalHeight;
        ctx.drawImage(sourceImage, 0, 0);

        redactBtn.disabled = false;
        saveBtn.disabled = true;

        status(
            `画像を読み込みました。\n` +
            `${canvas.width} × ${canvas.height}px`
        );

    } catch (error) {
        status("画像の読み込みに失敗しました。", error);
    }
});

redactBtn.addEventListener("click", run);
saveBtn.addEventListener("click", saveImage);

window.addEventListener("beforeunload", () => {
    worker?.terminate();
});
