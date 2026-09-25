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
const OCR_FIRST_SYMBOL_MIN_HEIGHT_RATIO = 0.25; // 1文字目bboxが極端に薄い時だけ補正
const OCR_FIRST_SYMBOL_LEFT_EXTRA = 28; // 異常な1文字目だけ左へ追加する余白(px)
const OCR_RESCUE_LEFT_EXTRA = 18; // 近似候補救出だけ左端を追加する余白(px)

function getOcrPaintBox(box, symbols = []) {
    const out = { ...box };
    if (symbols.length && box.h > 0) {
        const first = symbols[0]?.bbox;
        if (first) {
            const firstHeight = Math.max(0, first.y1 - first.y0);
            const ratio = firstHeight / box.h;
            // 正常な「ゆ」は触らず、今回のような極端に薄いbboxだけを補正する。
            if (ratio < OCR_FIRST_SYMBOL_MIN_HEIGHT_RATIO) {
                out.x = Math.max(0, out.x - OCR_FIRST_SYMBOL_LEFT_EXTRA);
                out.w += OCR_FIRST_SYMBOL_LEFT_EXTRA;
            }
        }
    }
    return out;
}

function paintOcr(box, text = "", symbols = [], rescue = false) {
    box = getOcrPaintBox(box, symbols);
    // 近似候補救出（例：「めーざー」→「ゆーざー」）だけ、
    // 1文字目の誤認で左端が右へ寄るケースを補正する。通常HITには適用しない。
    if (rescue) {
        box.x = Math.max(0, box.x - OCR_RESCUE_LEFT_EXTRA);
        box.w += OCR_RESCUE_LEFT_EXTRA;
    }
    const padding = Math.max(3, Math.round(Math.min(box.w, box.h) * 0.08));
    const left = Math.max(0, box.x - OCR_EDGE_PAD - padding + OCR_LEFT_TRIM);
    const right = Math.min(canvas.width, box.x + box.w);
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


function getOcrPaintRectForDiagnostic(box, symbols = [], rescue = false) {
    const paintBox = getOcrPaintBox({ ...box }, symbols);
    if (rescue) {
        paintBox.x = Math.max(0, paintBox.x - OCR_RESCUE_LEFT_EXTRA);
        paintBox.w += OCR_RESCUE_LEFT_EXTRA;
    }
    const padding = Math.max(3, Math.round(Math.min(paintBox.w, paintBox.h) * 0.08));
    const left = Math.max(0, paintBox.x - OCR_EDGE_PAD - padding + OCR_LEFT_TRIM);
    const right = Math.min(canvas.width, paintBox.x + paintBox.w + OCR_EDGE_PAD + padding);
    const width = Math.max(1, right - left);
    const top = Math.max(0, paintBox.y - padding);
    const height = paintBox.h + padding * 2;
    return { paintBox, left, right, top, height, width, padding };
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

function extractLineUnits(line){const units=[];for(const word of (line?.words||[])){const syms=(word?.symbols||[]).filter(s=>s?.bbox&&normalize(s.text));if(syms.length){for(const s of syms){for(const ch of [...normalize(s.text)]) units.push({ch,bbox:s.bbox,raw:s.text});}}else if(word?.bbox&&normalize(word.text)){const chars=[...normalize(word.text)],b=word.bbox;chars.forEach((ch,i)=>units.push({ch,raw:word.text,bbox:{x0:b.x0+(b.x1-b.x0)*i/chars.length,y0:b.y0,x1:b.x0+(b.x1-b.x0)*(i+1)/chars.length,y1:b.y1}}));}}return units;}

function findTargetInUnits(units,target){const text=units.map(u=>u.ch).join(""),hits=[];let from=0;while(from<=text.length-target.length){const i=text.indexOf(target,from);if(i<0)break;const selected=units.slice(i,i+target.length);if(selected.length===target.length)hits.push({targetBox:{x0:Math.min(...selected.map(u=>u.bbox.x0)),y0:Math.min(...selected.map(u=>u.bbox.y0)),x1:Math.max(...selected.map(u=>u.bbox.x1)),y1:Math.max(...selected.map(u=>u.bbox.y1))},symbols:selected});from=i+Math.max(1,target.length);}return hits;}

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

async function recognizeVariant(worker,inputCanvas,target,mode,scale){const result=await worker.recognize(inputCanvas,{tessedit_pageseg_mode:"11"});const data=result?.data||{},lines=data.lines||[],matches=[];for(const line of lines){const units=extractLineUnits(line),hits=findTargetInUnits(units,target),lineText=units.map(u=>u.ch).join("");for(const hit of hits)matches.push({x0:hit.targetBox.x0/scale,y0:hit.targetBox.y0/scale,x1:hit.targetBox.x1/scale,y1:hit.targetBox.y1/scale,mode,lineText,symbols:hit.symbols});}return {mode,lines,words:data.words||[],rawText:String(data.text||""),matches,near:findNearCandidates(lines,target)};}

function buildOcrCanvas(){
  // OCR用キャンバスだけを作る。表示用canvasはここでは絶対に変更しない。
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
  status(`OCR中…\n前処理：${stats.primaryName}`);
  const primaryVariant=makeOcrVariant(oc,stats.primaryName);
  try {
    const primary=await recognizeVariant(worker,primaryVariant,target,stats.primaryName,scale);
    results.push(primary);
    stats.primaryHitCount=primary.matches.length;
  } finally {
    if(primaryVariant!==oc){primaryVariant.width=1;primaryVariant.height=1;}
    stats.primaryMs=performance.now()-primaryStarted;
  }

  // グレー＋コントラストで1件も見つからなかった場合だけ、
  // 補助的な全体OCRを追加する。通常・グレースケールは今回の実験では外す。
  if(stats.primaryHitCount===0){
    stats.fallbackUsed=true;
    const fallbackStarted=performance.now();
    for(const name of stats.fallbackNames){
      status(`OCR中…\n追加前処理：${name}`);
      const variant=makeOcrVariant(oc,name);
      try {
        results.push(await recognizeVariant(worker,variant,target,name,scale));
      } finally {
        if(variant!==oc){variant.width=1;variant.height=1;}
      }
    }
    stats.fallbackMs=performance.now()-fallbackStarted;
  }

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

function mergeMatches(results){const all=results.flatMap(r=>r.matches),final=[];for(const box of all){const dup=final.some(o=>{const ix0=Math.max(box.x0,o.x0),iy0=Math.max(box.y0,o.y0),ix1=Math.min(box.x1,o.x1),iy1=Math.min(box.y1,o.y1);if(ix1<=ix0||iy1<=iy0)return false;const inter=(ix1-ix0)*(iy1-iy0),area=Math.min((box.x1-box.x0)*(box.y1-box.y0),(o.x1-o.x0)*(o.y1-o.y0));return area>0&&inter/area>.45;});if(!dup)final.push(box);}return final;}

async function run(){
  errorEl.hidden=true; ocrDiagnostics.hidden=true; ocrDebugLayer.hidden=true; ocrDebugLayer.innerHTML="";
  try{
    if(!sourceImage) throw new Error("先に画像を選択してください。");
    const target=normalize(targetText.value);
    if(!target) throw new Error("黒塗りする文字を入力してください。");

    manualStamps.length=0; ocrBaseCanvas=null; redrawFromBase();
    const worker=await getWorker(getOcrLanguage(target));
    status("OCR中…\n対象文字を探しています。");

    // V33の高速OCRをそのまま使用。通常HITはV19の黒塗り処理へ接続する。
    const {results,scale,ocrCanvas}=await collectOcrResults(worker,target);
    const matches=mergeMatches(results);

    // 通常OCRで見つかった対象文字を黒塗り。
    const paintBoxes=matches.map(b=>({
      x:b.x0, y:b.y0, w:b.x1-b.x0, h:b.y1-b.y0, symbols:b.symbols||[], source:"OCR"
    }));

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

    for(const b of paintBoxes){
      paintOcr({x:b.x,y:b.y,w:b.w,h:b.h},overlayName.checked?overlayText.value:"",b.symbols||[],b.rescue===true);
    }

    ocrBaseCanvas=document.createElement("canvas");
    ocrBaseCanvas.width=canvas.width; ocrBaseCanvas.height=canvas.height;
    ocrBaseCanvas.getContext("2d").drawImage(canvas,0,0);
    saveBtn.disabled=false; manualBtn.disabled=false;
    status(`黒塗り完了：${paintBoxes.length}箇所\n通常OCR：${matches.length}箇所 / 再OCR：${paintBoxes.length-matches.length}箇所`);
  }catch(error){status("OCRでエラーが発生しました。下のエラー詳細を確認してください。",error);}
}

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
    const ocrElapsed=performance.now()-ocrStarted;
    const refineStarted=performance.now();
    const refine=await refineNearCandidates(worker,results,ocrCanvas,target,scale);
    const refineElapsed=performance.now()-refineStarted;
    const {groups:candidateGroups,refined,acceptedNear}=refine;
    const totalElapsed=performance.now()-totalStarted;
    const exactCount=results.reduce((n,r)=>n+r.matches.length,0);
    const candidateCount=results.reduce((n,r)=>n+r.near.length,0);

    // 実際の自動黒塗りと同じ順序・重複判定で、黒塗り前の座標だけを診断表示する。
    // ここでは画像を変更しない。
    const diagnosticPaintBoxes = results.flatMap(r => r.matches.map(b => ({
      x:b.x0, y:b.y0, w:b.x1-b.x0, h:b.y1-b.y0,
      symbols:b.symbols||[], source:"OCR", rescue:false
    })));
    for(const r of [...refine.refined, ...refine.acceptedNear]){
      const b=r.refinedBox || r.box;
      if(!b) continue;
      const duplicate=diagnosticPaintBoxes.some(o=>{
        const ix0=Math.max(o.x,b.x0), iy0=Math.max(o.y,b.y0);
        const ix1=Math.min(o.x+o.w,b.x1), iy1=Math.min(o.y+o.h,b.y1);
        if(ix1<=ix0 || iy1<=iy0) return false;
        const inter=(ix1-ix0)*(iy1-iy0);
        const area=Math.min(o.w*o.h,(b.x1-b.x0)*(b.y1-b.y0));
        return area>0 && inter/area>.45;
      });
      if(!duplicate) diagnosticPaintBoxes.push({
        x:b.x0,y:b.y0,w:b.x1-b.x0,h:b.y1-b.y0,
        symbols:r.symbols||[],source:r.recovery||"再OCR",
        rescue:r.recovery==="近似候補救出"
      });
    }

    const lines=[`対象文字：${targetText.value}`,`正規化後：${target}`,""];
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
    lines.push("",
      `===== 実際の黒塗り座標診断 =====`,
      `黒塗り候補：${diagnosticPaintBoxes.length}箇所`,
      `※ 下記は実際の paintOcr() と同じ計算式で求めた最終黒塗り矩形。画像は変更していません。`);
    diagnosticPaintBoxes.forEach((b,i)=>{
      const r=getOcrPaintRectForDiagnostic(
        {x:b.x,y:b.y,w:b.w,h:b.h},
        b.symbols||[],
        b.rescue===true
      );
      lines.push(
        `  #${i+1} [${b.source}${b.rescue?' / 近似救出':''}]`,
        `    元bbox=(${b.x},${b.y})-(${b.x+b.w},${b.y+b.h})`,
        `    paintBox=(${r.paintBox.x},${r.paintBox.y})-(${r.paintBox.x+r.paintBox.w},${r.paintBox.y+r.paintBox.h})`,
        `    最終黒塗り=(${r.left},${r.top})-(${r.right},${r.top+r.height}) / ${r.width}x${r.height}`,
        `    padding=${r.padding} / symbols=${(b.symbols||[]).map(s=>`${s.ch}:${s.bbox.x0},${s.bbox.y0}-${s.bbox.x1},${s.bbox.y1}`).join(" | ") || "なし"}`
      );
    });
    lines.push("",
      `===== 処理時間 =====`,
      `OCR全体：${(ocrElapsed/1000).toFixed(2)}秒`,
      `  第1段階（グレー＋コントラスト）：${(stats.primaryMs/1000).toFixed(2)}秒 / HIT ${stats.primaryHitCount}件`,
      `  追加全体OCR：${stats.fallbackUsed ? (stats.fallbackMs/1000).toFixed(2)+"秒 / 実行" : "0.00秒 / 省略"}`,
      `候補再OCR：${(refineElapsed/1000).toFixed(2)}秒`,
      `診断全体：${(totalElapsed/1000).toFixed(2)}秒`,
      `候補地点：${candidateGroups.length} / 近似候補救出：${refine.fastRecovered} / 再OCR実行：${refine.attempted} / 再OCR追加パス：${refine.extraPasses} / 既存HITで省略：${refine.skippedExact}`,
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
