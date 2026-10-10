import { CONFIG } from "./config.js?v=91800";
import { getMedian } from "./utils.js?v=91800";

// 黒塗り・ぼかし・背景色塗りと、OCR bbox → 最終描画矩形の変換を担当する。
// OCR判定そのものや手動操作の状態管理はここでは行わない。
export function createRedaction({
    canvas,
    ctx,
    getSourceCanvas,
    getSourceCtx,
    getDefaultColor
}) {
    function cloneRedactionStyle(style = null) {
        return {
            mode: style?.mode || "black",
            color: style?.color || (getDefaultColor?.() || "#1a1a1a")
        };
    }

    function getStampRedactionStyle(stamp) {
        return cloneRedactionStyle(stamp?.style);
    }

    function sampleBackgroundColor(rect) {
        const sourceCtx = getSourceCtx?.();
        const sourceCanvas = getSourceCanvas?.();
        if (!sourceCtx || !sourceCanvas) return "#ffffff";
        const ring = 6;
        const x0 = Math.max(0, Math.floor(rect.x - ring));
        const y0 = Math.max(0, Math.floor(rect.y - ring));
        const x1 = Math.min(sourceCanvas.width, Math.ceil(rect.x + rect.w + ring));
        const y1 = Math.min(sourceCanvas.height, Math.ceil(rect.y + rect.h + ring));
        const sw = Math.max(1, x1 - x0);
        const sh = Math.max(1, y1 - y0);
        const data = sourceCtx.getImageData(x0, y0, sw, sh).data;
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
            // 名前が判読できない強さを優先した強ぼかし。
            // Safariでfilterが弱い/無効でも効くよう、まず大きく縮小して情報量を落とし、
            // 対応ブラウザではその上からガウス系blurを重ねる。描画はrect内にclipする。
            const blurMargin = Math.max(10, Math.min(28, Math.round(rect.h * 0.55)));
            const sx = Math.max(0, Math.floor(rect.x - blurMargin));
            const sy = Math.max(0, Math.floor(rect.y - blurMargin));
            const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil(rect.w + blurMargin * 2)));
            const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil(rect.h + blurMargin * 2)));

            const source = document.createElement("canvas");
            source.width = sw;
            source.height = sh;
            const sctx = source.getContext("2d");
            sctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

            // 旧版の約1/6より強い約1/12縮小。カタカナの線形状も残りにくくする。
            const small = document.createElement("canvas");
            small.width = Math.max(2, Math.round(sw / 12));
            small.height = Math.max(2, Math.round(sh / 12));
            const smctx = small.getContext("2d");
            smctx.imageSmoothingEnabled = true;
            smctx.imageSmoothingQuality = "high";
            smctx.drawImage(source, 0, 0, sw, sh, 0, 0, small.width, small.height);

            const blurred = document.createElement("canvas");
            blurred.width = sw;
            blurred.height = sh;
            const bctx = blurred.getContext("2d");
            bctx.imageSmoothingEnabled = true;
            bctx.imageSmoothingQuality = "high";
            if ("filter" in bctx) {
                const radius = Math.max(10, Math.min(24, Math.round(rect.h * 0.45)));
                bctx.filter = `blur(${radius}px)`;
            }
            bctx.drawImage(small, 0, 0, small.width, small.height, 0, 0, sw, sh);
            bctx.filter = "none";

            ctx.save();
            ctx.beginPath();
            ctx.rect(rect.x, rect.y, rect.w, rect.h);
            ctx.clip();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(blurred, 0, 0, sw, sh, sx, sy, sw, sh);
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
            const maxWidth = out.h * chars.length * CONFIG.bbox.shortNameHeightWidthRatio;
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
                    const maxW = medianW * chars.length * CONFIG.bbox.shortNameMedianWidthRatio;
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

    return {
        cloneRedactionStyle,
        getOcrPaintBox,
        getOcrVisualRect,
        paintManual,
        paintStamp
    };
}
