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

        ctx.fillText(
            text,
            left + width / 2,
            top + height / 2
        );
    }
}


/* ------------------------------
   OpenCV.jsの読み込み待ち
------------------------------ */

function waitForOpenCV(timeout = 15000) {
    return new Promise((resolve, reject) => {
        if (window.cv && cv.Mat) {
            resolve();
            return;
        }

        const start = Date.now();
        const timer = setInterval(() => {
            if (window.cv && cv.Mat) {
                clearInterval(timer);
                resolve();
                return;
            }

            if (Date.now() - start >= timeout) {
                clearInterval(timer);
                reject(new Error(
                    "OpenCV.jsの読み込みに時間がかかりすぎています。" +
                    "ページを再読み込みしてもう一度試してください。"
                ));
            }
        }, 100);
    });
}


/* ------------------------------
   アイコン自動検出
------------------------------ */

/*
 * Zetaの丸い顔アイコンを、固定座標ではなく
 * 画像内の「円形のエッジ」として探します。
 *
 * OpenCV.jsのHoughCirclesを使うため、
 * 画像サイズが変わっても基本的には追従します。
 */
async function detectIcons() {
    await waitForOpenCV();

    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const circles = new cv.Mat();

    try {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
        cv.medianBlur(gray, blurred, 7);

        cv.HoughCircles(
            blurred,
            circles,
            cv.HOUGH_GRADIENT,
            1.2,
            Math.max(60, Math.round(canvas.width * 0.065)),
            100,
            28,
            Math.max(28, Math.round(canvas.width * 0.025)),
            Math.max(70, Math.round(canvas.width * 0.065))
        );

        const candidates = [];

        for (let i = 0; i < circles.cols; i++) {
            const x = circles.data32F[i * 3];
            const y = circles.data32F[i * 3 + 1];
            const r = circles.data32F[i * 3 + 2];

            /*
             * 今回隠したいのは「右側の顔アイコン」だけ。
             * 左側のアイコンや中央の円形UIは対象外にします。
             */
            const nearRight = x > canvas.width * 0.82;

            if (!nearRight) {
                continue;
            }

            candidates.push({ x, y, r });
        }

        /* 重複候補をまとめる */
        const unique = [];

        for (const candidate of candidates) {
            const duplicate = unique.some((other) => {
                const dx = candidate.x - other.x;
                const dy = candidate.y - other.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                return distance < Math.min(candidate.r, other.r) * 0.8;
            });

            if (!duplicate) {
                unique.push(candidate);
            }
        }

        return unique;

    } finally {
        src.delete();
        gray.delete();
        blurred.delete();
        circles.delete();
    }
}


/* ------------------------------
   アイコン付近の小さい名前を探す
------------------------------ */

function findIconNameWords(words, icon) {
    const radius = icon.r;
    const iconLeft = icon.x - radius;
    const iconRight = icon.x + radius;
    const iconTop = icon.y - radius;

    /* 名前はアイコンの上端付近にあることが多いので、
       アイコン中央より下の本文は対象外にします。 */
    const top = iconTop - radius * 0.15;
    const bottom = iconTop + radius * 0.65;

    /* 今回は右側アイコンだけを対象にする */
    if (icon.x < canvas.width / 2) {
        return [];
    }

    return words.filter((word) => {
        const box = word.bbox;
        const cx = (box.x0 + box.x1) / 2;
        const cy = (box.y0 + box.y1) / 2;
        const w = box.x1 - box.x0;
        const h = box.y1 - box.y0;

        if (!normalize(word.text)) {
            return false;
        }

        if (cy < top || cy > bottom) {
            return false;
        }

        /* アイコン本体の中にある文字は除外 */
        if (cx >= iconLeft && cx <= iconRight) {
            return false;
        }

        /* 小さい名前らしい文字サイズに限定 */
        if (h > radius * 0.65 || w > radius * 4) {
            return false;
        }

        return cx < iconLeft + radius * 0.1 &&
            cx > iconLeft - radius * 4;
    });
}


/* ------------------------------
   アイコンを黒塗り
------------------------------ */

function paintIcon(icon, text = "") {
    const box = {
        x: icon.x - icon.r,
        y: icon.y - icon.r,
        w: icon.r * 2,
        h: icon.r * 2
    };

    /* 円形アイコンを少し余裕を持って四角く黒塗り */
    paint(box, text, {
        padding: Math.max(4, Math.round(icon.r * 0.08)),
        extraLeft: 0,
        extraRight: Math.max(4, Math.round(icon.r * 0.08))
    });
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

        let iconCount = 0;
        let iconNameCount = 0;

        if (redactIcon.checked) {
            status("顔アイコンを自動検出中…");

            const icons = await detectIcons();
            iconCount = icons.length;

            /*
             * アイコン付近の名前は、アイコンを黒塗りする前に
             * OCR結果から拾います。
             */
            for (const icon of icons) {
                const nameWords = findIconNameWords(words, icon);

                for (const word of nameWords) {
                    const box = word.bbox;

                    paint(
                        {
                            x: box.x0,
                            y: box.y0,
                            w: box.x1 - box.x0,
                            h: box.y1 - box.y0
                        },
                        "",
                        {
                            extraLeft: 2,
                            padding: Math.max(2, Math.round((box.y1 - box.y0) * 0.12))
                        }
                    );

                    iconNameCount++;
                }
            }

            for (const icon of icons) {
                paintIcon(
                    icon,
                    overlayIcon.checked
                        ? overlayText.value
                        : ""
                );
            }
        }

        const messages = [`黒塗り完了：${matches.length}箇所`];

        if (redactIcon.checked) {
            messages.push(`顔アイコン：${iconCount}個検出`);
            messages.push(`アイコン付近の名前：${iconNameCount}箇所`);
        }

        status(messages.join("\n"));
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
