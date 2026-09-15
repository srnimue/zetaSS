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
        .replace(/\s+/g, "")
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

        status("画像をOCR中…");

        const result = await ocrWorker.recognize(canvas);
        const words = result?.data?.words || [];

        const matches = words.filter((word) => {
            return normalize(word.text).includes(target);
        });

        for (const word of matches) {
            const box = word.bbox;

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

        status(`黒塗り完了：${matches.length}箇所`);
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
