import { ENABLE_DIAGNOSTIC } from "./config.js?v=91800";
import { normalize, editDistance } from "./utils.js?v=91800";
import {
    getOcrLanguage,
    makeOcrVariant,
    collectTextRegionMatches,
    makeCandidateCrop,
    recognizeVariant,
    makeWhiteBorderCanvas,
    OCR_BORDER_PX,
    ANALYSIS_CANVAS_MAX_WIDTH,
    ANALYSIS_CANVAS_MAX_PIXELS
} from "./ocr.js?v=91800";
import { state, manualStamps } from "./state.js?v=91800";
import { createView } from "./view.js?v=91800";
import {
    chooseItalicVariantHeights,
    collectItalicRescueCandidates
} from "./italic.js?v=91800";
import { createRedaction } from "./redaction.js?v=91800";
import { createManual } from "./manual.js?v=91800";
import { createDiagnostic } from "./diagnostic.js?v=91800";


const $ = id => document.getElementById(id);

// 調整値はここに集約。実験時に散在したマジックナンバーを増やさない。
const fileInput = $("fileInput");
const targetText = $("targetText");
const targetHistory = $("targetHistory");
const redactionMode = $("redactionMode");
const redactionColor = $("redactionColor");
const stampMode = $("stampMode");
const stampModeWrap = $("stampModeWrap");
const manualDrawMode = $("manualDrawMode");
const redactBtn = $("redactBtn");
const diagnoseBtn = $("diagnoseBtn");
const manualBtn = $("manualBtn");
const undoBtn = $("undoBtn");
const resetBtn = $("resetBtn");
const manualDoneBtn = $("manualDoneBtn");
const saveBtn = $("saveBtn");
const manualHelpBtn = $("manualHelpBtn");
const manualHelpDialog = $("manualHelpDialog");
const manualHelpCloseBtn = $("manualHelpCloseBtn");
const statusEl = $("status");
const errorEl = $("errorDetails");
const canvasWrap = $("canvasWrap");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const selection = $("selection");
const manualDeleteBtn = $("manualDeleteBtn");
const ocrDebugLayer = $("ocrDebugLayer");
const ocrDiagnostics = $("ocrDiagnostics");
const zoomOutBtn = $("zoomOutBtn");
const zoomInBtn = $("zoomInBtn");
const zoomLabel = $("zoomLabel");

// 手動描画の初期モードは「なぞり式」。
if (manualDrawMode) manualDrawMode.value = "trace";

if (!ENABLE_DIAGNOSTIC) {
    diagnoseBtn.hidden = true;
    ocrDiagnostics.hidden = true;
    ocrDebugLayer.hidden = true;
}

let worker = null;
let workerLang = null;
let ocrBusy = false;
let fileName = "redacted.png";
let ocrBaseCanvas = null;

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const SETTINGS_STORAGE_KEY = "zetaSS.settings.v87";
const TARGET_HISTORY_STORAGE_KEY = "zetaSS.targetHistory.v87";
const MAX_TARGET_HISTORY = 5;

let sourceCanvasRef = null;
let sourceCtxRef = null;

const {
    cloneRedactionStyle,
    getOcrPaintBox,
    getOcrVisualRect,
    paintManual,
    paintStamp
} = createRedaction({
    canvas,
    ctx,
    getSourceCanvas: () => sourceCanvasRef,
    getSourceCtx: () => sourceCtxRef,
    getDefaultColor: () => redactionColor?.value || "#1a1a1a"
});

function getCurrentRedactionStyle() {
    return cloneRedactionStyle({
        mode: redactionMode?.value || "black",
        color: redactionColor?.value || "#1a1a1a"
    });
}

let manualController = null;

const {
    getBaseDisplaySize,
    updateZoomUI,
    setZoom,
    redrawFromBase,
    getCanvasDisplayTransform
} = createView({
    canvas,
    ctx,
    canvasWrap,
    zoomLabel,
    state,
    manualStamps,
    getBaseSource: () => ocrBaseCanvas || state.sourceImage,
    getBaseSize: () => ocrBaseCanvas
        ? { width: ocrBaseCanvas.width, height: ocrBaseCanvas.height }
        : state.sourceImage
            ? { width: state.sourceImage.naturalWidth, height: state.sourceImage.naturalHeight }
            : { width: canvas.width, height: canvas.height },
    paintStamp: stamp => paintStamp(stamp),
    updateUndoButton: () => manualController?.updateUndoButton(),
    renderManualSelection: () => manualController?.renderManualSelection(),
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM
});

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

function setOcrBusy(busy) {
    ocrBusy = !!busy;
    redactBtn.disabled = ocrBusy || !state.sourceImage;
    diagnoseBtn.disabled = ocrBusy || !ENABLE_DIAGNOSTIC || !state.sourceImage;
}

function safeLoadJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function safeSaveJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // private mode等では保存できないことがあるが、アプリ動作は継続する。
    }
}

function updateRedactionStyleUI() {
    if (!redactionColor || !redactionMode) return;
    const showColor = redactionMode.value === "color";
    // カラーピッカーの場所は常に確保して、表示/非表示でUIが動かないようにする。
    redactionColor.classList.toggle("is-placeholder", !showColor);
    redactionColor.disabled = !showColor;
}

function savePreferences() {
    safeSaveJson(SETTINGS_STORAGE_KEY, {
        manualDrawMode: manualDrawMode?.value || "trace",
        redactionMode: redactionMode?.value || "black",
        redactionColor: redactionColor?.value || "#1a1a1a"
    });
}

function loadPreferences() {
    const saved = safeLoadJson(SETTINGS_STORAGE_KEY, {});
    if (typeof saved.manualDrawMode === "string" && manualDrawMode) manualDrawMode.value = saved.manualDrawMode;
    if (typeof saved.redactionMode === "string" && redactionMode) redactionMode.value = saved.redactionMode;
    if (typeof saved.redactionColor === "string" && redactionColor) redactionColor.value = saved.redactionColor;
    updateRedactionStyleUI();
}

function getTargetHistoryList() {
    const list = safeLoadJson(TARGET_HISTORY_STORAGE_KEY, []);
    return Array.isArray(list) ? list.filter(v => typeof v === "string" && v.trim()) : [];
}

function saveTargetHistoryEntry(text) {
    const value = (text || "").trim();
    if (!value) return;
    const list = getTargetHistoryList().filter(v => v !== value);
    list.unshift(value);
    safeSaveJson(TARGET_HISTORY_STORAGE_KEY, list.slice(0, MAX_TARGET_HISTORY));
    renderTargetHistory();
}

function renderTargetHistory() {
    if (!targetHistory) return;
    const list = getTargetHistoryList();
    targetHistory.innerHTML = "";
    targetHistory.hidden = !list.length;
    if (!list.length) return;

    const label = document.createElement("span");
    label.className = "target-history-label";
    label.textContent = "履歴";
    targetHistory.appendChild(label);

    for (const item of list) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "target-history-chip";
        btn.textContent = item;
        btn.addEventListener("click", () => {
            targetText.value = item;
            targetText.focus();
        });
        targetHistory.appendChild(btn);
    }
}

function buildSourceCanvas() {
    if (!state.sourceImage) {
        sourceCanvasRef = null;
        sourceCtxRef = null;
        return;
    }
    sourceCanvasRef = document.createElement("canvas");
    sourceCanvasRef.width = state.sourceImage.naturalWidth;
    sourceCanvasRef.height = state.sourceImage.naturalHeight;
    sourceCtxRef = sourceCanvasRef.getContext("2d", { willReadFrequently: true });
    sourceCtxRef.drawImage(state.sourceImage, 0, 0);
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


manualController = createManual({
    canvas,
    canvasWrap,
    selection,
    manualDeleteBtn,
    stampMode,
    stampModeWrap,
    manualDrawMode,
    manualBtn,
    manualDoneBtn,
    undoBtn,
    saveBtn,
    manualHelpBtn,
    manualHelpDialog,
    manualHelpCloseBtn,
    getBaseDisplaySize,
    getCanvasDisplayTransform,
    setZoom,
    redrawFromBase,
    paintManual,
    getCurrentRedactionStyle,
    savePreferences,
    status
});

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
  cc.drawImage(state.sourceImage, sx0, sy0, c.width, c.height, 0, 0, c.width, c.height);
  return { canvas: c, x0: sx0, y0: sy0 };
}

function buildAnalysisCanvas(source=state.sourceImage){
  const sw=source?.naturalWidth||source?.width||canvas.width;
  const sh=source?.naturalHeight||source?.height||canvas.height;
  if(!sw||!sh) return {canvas:source,scale:1,resized:false,width:sw||0,height:sh||0};

  const byWidth=ANALYSIS_CANVAS_MAX_WIDTH/sw;
  const byPixels=Math.sqrt(ANALYSIS_CANVAS_MAX_PIXELS/Math.max(1,sw*sh));
  const scale=Math.min(1,byWidth,byPixels);
  // 解析系の後段は Canvas API（getContext）を前提にしている。
  // 縮小不要の画像でも HTMLImageElement をそのまま返さず、必ず canvas に統一する。
  // 大きい画像では従来どおり縮小、小さい画像では等倍コピーなので座標系は変わらない。
  const outScale=scale>=0.995?1:scale;
  if(outScale===1 && typeof source?.getContext==='function') {
    return {canvas:source,scale:1,resized:false,width:sw,height:sh};
  }

  const c=document.createElement("canvas");
  c.width=Math.max(1,Math.round(sw*outScale));
  c.height=Math.max(1,Math.round(sh*outScale));
  const g=c.getContext("2d");
  g.imageSmoothingEnabled=true;
  g.imageSmoothingQuality="high";
  g.drawImage(source,0,0,sw,sh,0,0,c.width,c.height);
  return {canvas:c,scale:outScale,resized:outScale!==1,width:c.width,height:c.height};
}

function buildOcrCanvas(baseCanvas=state.sourceImage){
  // 解析用の基準キャンバスからOCRキャンバスを作る。
  // これでOCR・局所OCR・イタリック探索が同じ座標系を共有しつつ、OCRだけは必要な倍率を保てる。
  const srcW=baseCanvas?.width||canvas.width;
  const srcH=baseCanvas?.height||canvas.height;
  const baseScale=2.5;
  const maxOcrPixels=11000000;
  const srcPixels=Math.max(1,srcW*srcH);
  const safeScale=Math.sqrt(maxOcrPixels/srcPixels);
  const scale=Math.max(1.8,Math.min(baseScale,safeScale));
  const oc=document.createElement("canvas");
  oc.width=Math.round(srcW*scale);
  oc.height=Math.round(srcH*scale);
  const c=oc.getContext("2d");
  c.imageSmoothingEnabled=true;
  c.imageSmoothingQuality="high";
  c.drawImage(baseCanvas,0,0,srcW,srcH,0,0,oc.width,oc.height);
  return {canvas:oc,scale};
}

async function collectOcrResults(worker,target,analysisState=null){
  const analysis=analysisState||buildAnalysisCanvas();
  const analysisCanvas=analysis.canvas;
  const analysisScale=analysis.scale||1;
  const {canvas:oc,scale:ocrScale}=buildOcrCanvas(analysisCanvas);
  const totalScale=analysisScale*ocrScale;
  const results=[];
  const stats={primaryMs:0,primaryHitCount:0,primaryName:"グレー＋コントラスト",fallbackSkippedForSpeed:false};

  // 主OCRは「グレー＋コントラスト」を1回だけ実行する。
  // 重い全画面fallbackは使わず、後段の近似候補・局所OCR・補助探索へつなぐ。
  const primaryStarted=performance.now();
  status("実行中…");
  const primaryBase=makeOcrVariant(oc,stats.primaryName);
  const primaryVariant=makeWhiteBorderCanvas(primaryBase,OCR_BORDER_PX*ocrScale);
  try {
    const primary=await recognizeVariant(worker,primaryVariant,target,stats.primaryName,totalScale,OCR_BORDER_PX*ocrScale,OCR_BORDER_PX*ocrScale);
    primary._ocrToOriginalScale=1/totalScale;
    results.push(primary);
    stats.primaryHitCount=primary.matches.length;
  } finally {
    primaryVariant.width=1;primaryVariant.height=1;
    if(primaryBase!==oc){primaryBase.width=1;primaryBase.height=1;}
    stats.primaryMs=performance.now()-primaryStarted;
  }

  // primary HITが0件でも重い全画面OCRは追加せず、近似候補群をそのまま救出へ渡す。
  stats.fallbackSkippedForSpeed = stats.primaryHitCount===0;
  stats.fallbackReason = stats.primaryHitCount===0 ? "近似候補救出を優先して省略" : "不要";

  // 色抽出OCRは主OCRのHIT数に関係なく1回だけ追加実行する。
  const colorStarted=performance.now();
  const colorBase=makeOcrVariant(oc,"色抽出");
  const colorVariant=makeWhiteBorderCanvas(colorBase,OCR_BORDER_PX*ocrScale);
  try {
    const color=await recognizeVariant(worker,colorVariant,target,"色抽出",totalScale,OCR_BORDER_PX*ocrScale,OCR_BORDER_PX*ocrScale);
    color._ocrToOriginalScale=1/totalScale;
    results.push(color);
    stats.colorHitCount=color.matches.length;
  } finally {
    colorVariant.width=1;colorVariant.height=1;
    if(colorBase!==oc){colorBase.width=1;colorBase.height=1;}
  }
  stats.colorMs=performance.now()-colorStarted;

  return {results,scale:totalScale,ocrCanvas:oc,stats,analysisCanvas,analysisScale,ocrScale,analysis};
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

  // 3文字名の近似候補救出:
  // 3文字名は1文字誤認で67%まで落ちるため、「同一地点で2回」だけでなく、
  // 画像内の別地点でも同じ誤認文字列が繰り返された場合を強い根拠として扱う。
  // 同一group内の重複は1票にまとめ、別groupごとに1票だけ数える。
  const threeCharGlobalCounts = new Map();
  if ([...target].length === 3) {
    for (const g of groups) {
      const seenInGroup = new Set();
      for (const c of g.candidates) {
        if ([...c.candidate].length !== 3) continue;
        if (editDistance(target, c.candidate) !== 1) continue;
        if (c.similarity < 0.66) continue;
        seenInGroup.add(c.candidate);
      }
      for (const name of seenInGroup) {
        threeCharGlobalCounts.set(name, (threeCharGlobalCounts.get(name) || 0) + 1);
      }
    }
  }

  // V36: 再OCRより先に「かなり強い近似候補」を救出する。
  // 今回のように Tesseract が「ゆーざー」を「めーざー」と読むケースでは、
  // 4文字中3文字が同じ位置に残るため、局所OCRを何度回しても同じ誤読を
  // 繰り返すことがある。そうした候補は、同じ地点に複数の近似候補が集まり、
  // かつ対象と同じ文字数で、編集類似度が高い場合に先に採用する。
  function getFastRecovery(group) {
    const tlen = [...target].length;
    const sameLength = group.candidates.filter(c => [...c.candidate].length === tlen);
    if (!sameLength.length) return null;

    // 同じ文字数で編集距離1なら「1文字だけの誤認」。
    // 4文字以上は従来どおり72%以上で即救出。
    // 3文字は1文字誤認だけで類似度が67%まで落ちるため、
    // 同じ誤認文字列が同一地点で2回以上出た時だけ安全側に救出する。
    const distanceOne = sameLength
      .map(c => ({...c, recoveryDistance: editDistance(target, c.candidate)}))
      .filter(c => c.recoveryDistance <= 1);

    if (!distanceOne.length || tlen < 3) return null;

    let strong = [];
    if (tlen === 3) {
      const counts = new Map();
      for (const c of distanceOne) {
        if (c.recoveryDistance !== 1 || c.similarity < 0.66) continue;
        counts.set(c.candidate, (counts.get(c.candidate) || 0) + 1);
      }
      strong = distanceOne
        .filter(c => {
          if (c.recoveryDistance !== 1 || c.similarity < 0.66) return false;
          const sameSpotCount = counts.get(c.candidate) || 0;
          const globalSpotCount = threeCharGlobalCounts.get(c.candidate) || 0;
          return sameSpotCount >= 2 || globalSpotCount >= 2;
        })
        .sort((a,b) => b.similarity - a.similarity);
    } else {
      strong = distanceOne
        .filter(c => c.similarity >= 0.72)
        .sort((a,b) => {
          if (a.recoveryDistance !== b.recoveryDistance) return a.recoveryDistance - b.recoveryDistance;
          return b.similarity - a.similarity;
        });
    }

    if (!strong.length) return null;

    const best = strong[0];
    const distinctCandidates = new Set(strong.map(c => c.candidate));

    // 黒塗りには候補地点全体ではなく、採用した近似候補自身のbboxを使う。
    const units = best.units || [];
    const xs = units.flatMap(u => [u.bbox.x0, u.bbox.x1]);
    const ys = units.flatMap(u => [u.bbox.y0, u.bbox.y1]);
    if (!xs.length || !ys.length) return null;

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
      distinctStrongCandidates: distinctCandidates.size,
      threeCharConsensus: tlen === 3,
      threeCharGlobalSpotCount: tlen === 3 ? (threeCharGlobalCounts.get(best.candidate) || 0) : 0
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


// 周囲の文字を手掛かりに、対象文字そのものをOCRできなかった地点を救出する。
// 例：「ねるちゃん」を1件でも認識できたら「ちゃん」を文脈として学習し、
// 別の局所OCRで「ちゃん」だけ認識された場合、その直前に対象文字があると推定する。
// 推定矩形は既知の完全一致HITから得た対象文字の平均サイズと、
// 対象→文脈の実測間隔を使う。診断にも使えるよう候補情報を返す。
function mergeMatches(results){const all=results.flatMap(r=>r.matches),final=[];for(const box of all){const dup=final.some(o=>{const ix0=Math.max(box.x0,o.x0),iy0=Math.max(box.y0,o.y0),ix1=Math.min(box.x1,o.x1),iy1=Math.min(box.y1,o.y1);if(ix1<=ix0||iy1<=iy0)return false;const inter=(ix1-ix0)*(iy1-iy0),area=Math.min((box.x1-box.x0)*(box.y1-box.y0),(o.x1-o.x0)*(o.y1-o.y0));return area>0&&inter/area>.45;});if(!dup)final.push(box);}return final;}

async function run(){
  if (ocrBusy) return;
  setOcrBusy(true);
  errorEl.hidden=true; ocrDiagnostics.hidden=true; ocrDebugLayer.hidden=true; ocrDebugLayer.innerHTML="";
  try{
    if(!state.sourceImage) throw new Error("先に画像を選択してください。");
    const target=normalize(targetText.value);
    if(!target) throw new Error("黒塗りする文字を入力してください。");
    saveTargetHistoryEntry(targetText.value);

    manualController.resetState({ redraw: false }); ocrBaseCanvas=null; redrawFromBase();
    const ocrWorker=await getWorker(getOcrLanguage(target));
    const analysisState=buildAnalysisCanvas();
    status("OCR中…\n基準キャンバスを作成しています。");

    // 高速OCRを主経路にし、通常HITを黒塗り処理へ接続する。
    const {results,scale,ocrCanvas,stats,analysisCanvas,analysisScale}=await collectOcrResults(ocrWorker,target,analysisState);
    const matches=mergeMatches(results);

    // 通常OCRで見つかった対象文字を黒塗り候補として登録。
    // 実際の描画は最後にまとめて行い、OCR結果も手動黒塗りと同じ編集対象にする。
    const paintBoxes=matches.map(b=>({
      x:b.x0, y:b.y0, w:b.x1-b.x0, h:b.y1-b.y0, symbols:b.symbols||[], source:"OCR"
    }));

    // 通常OCRで拾えなかった候補だけ、局所再OCRを実行。
    // 再OCRで対象文字を確認できた地点は、その候補文字のbboxを黒塗り範囲として追加する。
    const refine=await refineNearCandidates(ocrWorker,results,ocrCanvas,target,scale);
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
      if(!duplicate) paintBoxes.push({x:b.x0,y:b.y0,w:b.x1-b.x0,h:b.y1-b.y0,symbols:r.symbols||[],source:r.recovery||"再OCR"});
    }


    // 「文字領域全走査＋局所OCR」を追加検出ルートとして使用。
    // 全体OCRで拾えなかった文字も、文字っぽい領域内のPSM7 OCRで拾えた場合は追加する。
    status("OCR中…\n文字領域を追加走査しています。");
    const regionScan = await collectTextRegionMatches(ocrWorker, analysisCanvas, target, analysisScale);
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


    // 通常OCR/局所OCRで拾えなかった場所だけ、
    // コントラスト補正→イタリックテンプレートを補助候補として追加する。
    status("OCR中…\nイタリック文字の取りこぼしを補助確認しています。");
    const italicHeightChoice = chooseItalicVariantHeights(results, target, analysisScale);
    const italicVariantHeights = italicHeightChoice.heights;
    const italicRescue = collectItalicRescueCandidates(analysisCanvas, target, paintBoxes, italicVariantHeights, regionScan.detected, analysisScale);
    for (const c of italicRescue.accepted) {
      paintBoxes.push({
        x:c.x, y:c.y, w:c.w, h:c.h,
        symbols:[], source:"イタリック救出"
      });
    }


    // OCR黒塗りを編集可能なオブジェクトとして登録する。
    // OCR専用の補正・余白計算はここで一度だけ行い、以後の移動・サイズ変更では
    // その最終黒塗り矩形をそのまま編集する。
    ocrBaseCanvas=document.createElement("canvas");
    ocrBaseCanvas.width=canvas.width; ocrBaseCanvas.height=canvas.height;
    const baseCtx=ocrBaseCanvas.getContext("2d");
    baseCtx.drawImage(state.sourceImage,0,0);

    manualController.pushManualHistory();
    for(const b of paintBoxes){
      const rect=getOcrVisualRect({x:b.x,y:b.y,w:b.w,h:b.h},b.symbols||[],{source:b.source});
      if(rect.w < 1 || rect.h < 1) continue;
      manualStamps.push({
        x:rect.x, y:rect.y, w:rect.w, h:rect.h,
        style:getCurrentRedactionStyle(),
        kind:"ocr"
      });
    }
    redrawFromBase();
    saveBtn.disabled=false; manualBtn.disabled=false;
    const italicAdded = italicRescue?.accepted?.length || 0;
    const localAdded = Math.max(0, paintBoxes.length - matches.length - italicAdded);
    status(`黒塗り完了：${manualStamps.length}箇所\n通常OCR：${matches.length}箇所 / 追加局所OCR：${localAdded}箇所 / イタリック救出：${italicAdded}箇所\nイタリック探索：${italicRescue.searchMode} ${italicRescue.searchRegionCount}領域 / 評価${italicRescue.scoredPositions}地点 / HIT済み省略${italicRescue.skippedExisting}地点${stats.fallbackSkippedForSpeed ? " / 重い全画面fallback省略" : ""}`);
  }catch(error){
    status("OCRでエラーが発生しました。下のエラー詳細を確認してください。",error);
  }finally{
    setOcrBusy(false);
  }
}


// イタリック探索ロジックは italic.js に分離。




redactionMode?.addEventListener("change", () => {
    updateRedactionStyleUI();
    savePreferences();
    const label = redactionMode.selectedOptions?.[0]?.textContent || "黒塗り";
    status(`隠し方を「${label}」にしました。`);
});
redactionColor?.addEventListener("input", savePreferences);
targetText?.addEventListener("keydown", event => {
    if (event.key === "Enter") saveTargetHistoryEntry(targetText.value);
});

zoomOutBtn.addEventListener("click", () => setZoom(state.zoom - 0.25));
zoomInBtn.addEventListener("click", () => setZoom(state.zoom + 0.25));

resetBtn.addEventListener("click", () => {
    if (!state.sourceImage) return;
    // 自動(OCR)・手動を問わず、黒塗りを全て取り消して元画像の状態に戻す。
    manualController.resetState({ redraw: false });
    ocrBaseCanvas = null;
    redrawFromBase();
    status("黒塗りをすべてリセットしました。");
});

// 保存設定/履歴は定数とヘルパー定義が済んでから初期化する。
loadPreferences();
renderTargetHistory();

fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
        manualController.stopManualMode();
        ocrDiagnostics.hidden = true;
        ocrDebugLayer.hidden = true;
        ocrDebugLayer.innerHTML = "";
        state.sourceImage = await loadImage(file);
        buildSourceCanvas();
        fileName = (file.name.replace(/\.[^.]+$/, "") || "redacted") + "_redacted.png";
        manualController.resetState({ redraw: false });
        ocrBaseCanvas = null;
        canvas.width = state.sourceImage.naturalWidth;
        canvas.height = state.sourceImage.naturalHeight;
        state.zoom = 1;
        ctx.drawImage(state.sourceImage, 0, 0);
        updateZoomUI();
        redactBtn.disabled = false;
        diagnoseBtn.disabled = !ENABLE_DIAGNOSTIC;
        manualBtn.disabled = false;
        saveBtn.disabled = false;
        resetBtn.disabled = false;
        manualController.updateUndoButton();
        status(`画像を読み込みました。\n${canvas.width} × ${canvas.height}px`);
    } catch (error) {
        status("画像の読み込みに失敗しました。", error);
    }
});

redactBtn.addEventListener("click", run);
const diagnosticController = createDiagnostic({
    canvas,
    ocrDiagnostics,
    ocrDebugLayer,
    targetText,
    state,
    isOcrBusy: () => ocrBusy,
    setOcrBusy,
    saveTargetHistoryEntry,
    getWorker,
    buildAnalysisCanvas,
    collectOcrResults,
    refineNearCandidates,
    mergeMatches,
    groupTouchesExactHit,
    getOcrPaintBox,
    getOcrVisualRect,
    getCanvasDisplayTransform,
    status
});

if (ENABLE_DIAGNOSTIC) diagnoseBtn.addEventListener("click", diagnosticController.diagnoseOCR);

function canvasToBlob() {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG画像の作成に失敗しました。")), "image/png");
    });
}

function isLikelyMobileSaveEnvironment() {
    const ua = navigator.userAgent || "";
    const touch = navigator.maxTouchPoints || 0;
    return /iPhone|iPad|iPod|Android/i.test(ua) || (touch > 0 && Math.min(window.innerWidth || 0, window.innerHeight || 0) <= 1024);
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveBlobWithPicker(blob, name) {
    if (!window.showSaveFilePicker) return false;
    const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{
            description: "PNG画像",
            accept: { "image/png": [".png"] }
        }]
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
}

async function saveImage() {
    if (!state.sourceImage || !canvas.width || !canvas.height) {
        status("先に画像を処理してください。");
        return;
    }

    saveBtn.disabled = true;
    try {
        const blob = await canvasToBlob();
        const file = new File([blob], fileName, { type: "image/png" });
        const preferNativeSave = !isLikelyMobileSaveEnvironment();

        if (preferNativeSave && window.showSaveFilePicker) {
            await saveBlobWithPicker(blob, fileName);
            status("PNGを保存しました。");
            return;
        }

        if (!preferNativeSave && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
            status("画像を共有シートに渡しました。\n必要な場所へ保存してください。");
            return;
        }

        downloadBlob(blob, fileName);
        status("PNGを保存しました。");
    } catch (error) {
        if (error?.name === "AbortError") {
            status("保存をキャンセルしました。");
        } else {
            status("画像の保存に失敗しました。もう一度お試しください。", error);
        }
    } finally {
        saveBtn.disabled = false;
    }
}

saveBtn.addEventListener("click", saveImage);

window.addEventListener("beforeunload", () => worker?.terminate());

updateStampModeUI();
