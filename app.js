const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const targetText = $("targetText");
const overlayText = $("overlayText");

const overlayName = $("overlayName");
const redactIcon = $("redactIcon");
const overlayIcon = $("overlayIcon");

const redactBtn = $("redactBtn");
const saveBtn = $("saveBtn");

const statusEl = $("status");
const errorEl = $("errorDetails");

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

let sourceImage = null;
let worker = null;
let fileName = "redacted.png";


/* ------------------------------
   ステータス・エラー表示
------------------------------ */

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


/* ------------------------------
   画像読み込み
------------------------------ */

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


/* ------------------------------
   OCR用文字列の正規化
------------------------------ */

function normalize(text) {
    return String(text || "")
        .replace(/\s+/g, "")
        .toLowerCase();
}


/* ------------------------------
   黒塗り＋置き換え文字
------------------------------ */

function paint(box, text) {
    const padding = Math.max(
        4,
        Math.round(Math.min(box.w, box.h) * 0.12)
    );

    /*
     * 左側だけ少し広めに黒塗り。
     *
     * Zetaの名前OCRで一文字目が少し残ることがあるため、
     * 左に6px追加しています。
     *
     * 右側は広げすぎないので、
     * 「にみゅさん」の「さん」をなるべく残します。
     */
    const left = Math.max(0, box.x - padding - 6);
    const top = Math.max(0, box.y - padding);

    const width = box.w + padding;
    const height = box.h + padding * 2;

    ctx.fillStyle = "#000";
    ctx.fillRect(left, top, width, height);

    if (text) {
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.max(12, Math.round(box.h * 0.6))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        ctx.fillText(
            text,
            left + width / 2,
            top + height / 2
        );
    }
}


/* ------------------------------
   Zeta右側アイコンの位置
------------------------------ */

/*
 * 現在のZetaスクショ（1080 × 1536程度）を基準に、
 * 薄紫の吹き出し右側にある丸アイコンを指定しています。
 *
 * 横位置・縦位置とも画像サイズに対する割合で指定しているため、
 * 同じレイアウトのスクショなら解像度が変わっても追従します。
 */
function iconBox() {
    const size = Math.round(canvas.width * 0.085);

    return {
        x: Math.round(canvas.width * 0.885),
        y: Math.round(canvas.height * 0.65),
        w: size,
        h: size
    };
}


/* ------------------------------
   Tesseract.js
------------------------------ */

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

    status(
        "OCRエンジンを準備中…\n" +
        "初回は少し時間がかかります。"
    );

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


/* ------------------------------
   OCRして黒塗り
------------------------------ */

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

        ctx.drawImage(
            sourceImage,
            0,
            0
        );

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
                overlayName.checked
                    ? overlayText.value
                    : ""
            );
        }

        if (redactIcon.checked) {
            paint(
                iconBox(),
                overlayIcon.checked
                    ? overlayText.value
                    : ""
            );
        }

        if (matches.length) {
            status(`黒塗り完了：${matches.length}箇所`);
        } else {
            status(
                "指定した文字をOCRで見つけられませんでした。\n" +
                "文字が小さい場合は、元画像を大きくして試してください。"
            );
        }

        saveBtn.disabled = false;

    } catch (error) {
        status(
            "OCRでエラーが発生しました。" +
            "下のエラー詳細を確認してください。",
            error
        );
    }
}


/* ------------------------------
   ファイル選択
------------------------------ */

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

        ctx.drawImage(
            sourceImage,
            0,
            0
        );

        redactBtn.disabled = false;
        saveBtn.disabled = true;

        status(
            `画像を読み込みました。\n` +
            `${canvas.width} × ${canvas.height}px`
        );

    } catch (error) {
        status(
            "画像の読み込みに失敗しました。",
            error
        );
    }
});


/* ------------------------------
   ボタン
------------------------------ */

redactBtn.addEventListener("click", run);

saveBtn.addEventListener("click", () => {
    const link = document.createElement("a");

    link.download = fileName;
    link.href = canvas.toDataURL("image/png");

    link.click();
});


/* ------------------------------
   ページ終了時
------------------------------ */

window.addEventListener("beforeunload", () => {
    worker?.terminate();
});
