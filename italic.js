import { CONFIG } from "./config.js?v=10000";
import { editDistance } from "./utils.js?v=10000";

// ===== イタリック補助探索用テンプレート =====
// 14pxで描画した文字のアルファ領域を切り出し、目標高さへ拡大して検索する。
const TEMPLATE_FONT_STACK='-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", "Yu Gothic", sans-serif';
const TEMPLATE_BASE_FONT_SIZE=14;
const TEMPLATE_TARGET_HEIGHT=32;
const TEMPLATE_FG_WEIGHT=0.72;
const TEMPLATE_BG_WEIGHT=0.28;
const TEMPLATE_SEARCH_LEFT_RATIO=0.10;
const TEMPLATE_SEARCH_RIGHT_RATIO=0.02;
const TEMPLATE_SEARCH_TOP_RATIO=0.12;

// ===== コントラスト補正＋イタリック補助探索 =====
// 文字領域を先に探索し、既存HITを除外しながら全画面を補完する。
const ITALIC_VARIANT_HEIGHTS = [26, 28]; // 1000px統一解析キャンバス基準のテスト値
export const ITALIC_VARIANT_SKEWS = [0.00];
export const ITALIC_DIAGNOSTIC_SKEWS = [-0.10, 0.00, 0.10];
export const ITALIC_COARSE_STEP = 6;
export const ITALIC_REFINE_STEP = 2;
const ITALIC_SECONDARY_OFFSET = 3;
const ITALIC_COARSE_LIMIT = 10;
const ITALIC_FINAL_LIMIT = 6;
export const ITALIC_RESCUE_SCORE_MIN = CONFIG.italic.minScore;
export const ITALIC_RESCUE_FG_MIN = CONFIG.italic.minForeground;
export const ITALIC_RESCUE_BG_MIN = CONFIG.italic.minBackground;
const ITALIC_RESCUE_MAX_NEW = 3;

// イタリック探索専用の縮小キャンバス。
// 元画像が大きい時だけ縮小し、探索画素数とテンプレートの見かけサイズを安定させる。
// OCR用キャンバスとは分離し、OCR精度や既存処理には影響させない。
const ITALIC_SEARCH_MAX_WIDTH = 900;
const ITALIC_SEARCH_MAX_PIXELS = 1800000;

function buildItalicSearchCanvas(source){
  const sw=source.naturalWidth||source.width, sh=source.naturalHeight||source.height;
  if(!sw||!sh) return {source, scale:1, width:sw||0, height:sh||0, resized:false};
  const byWidth=ITALIC_SEARCH_MAX_WIDTH/sw;
  const byPixels=Math.sqrt(ITALIC_SEARCH_MAX_PIXELS/(sw*sh));
  const scale=Math.min(1,byWidth,byPixels);
  if(scale>=0.995) return {source, scale:1, width:sw, height:sh, resized:false};
  const c=document.createElement('canvas');
  c.width=Math.max(1,Math.round(sw*scale));
  c.height=Math.max(1,Math.round(sh*scale));
  const g=c.getContext('2d',{willReadFrequently:true});
  g.imageSmoothingEnabled=true;
  g.imageSmoothingQuality='high';
  g.drawImage(source,0,0,sw,sh,0,0,c.width,c.height);
  return {source:c, scale:c.width/sw, width:c.width, height:c.height, resized:true};
}

function scaleItalicRects(rects, scale){
  if(scale===1) return rects||[];
  return (rects||[]).map(r=>({
    ...r,
    x:(r.x??r.x0??0)*scale,
    y:(r.y??r.y0??0)*scale,
    w:(r.w??((r.x1??0)-(r.x0??0)))*scale,
    h:(r.h??((r.y1??0)-(r.y0??0)))*scale
  }));
}

function mapItalicCandidateToOriginal(c, scale){
  if(scale===1) return c;
  return {
    ...c,
    x:Math.round(c.x/scale),
    y:Math.round(c.y/scale),
    w:Math.max(1,Math.round(c.w/scale)),
    h:Math.max(1,Math.round(c.h/scale)),
    searchX:c.x, searchY:c.y, searchW:c.w, searchH:c.h
  };
}


function medianNumber(values){
  const nums=(values||[]).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!nums.length) return null;
  const mid=Math.floor(nums.length/2);
  return nums.length%2 ? nums[mid] : (nums[mid-1]+nums[mid])/2;
}

export function chooseItalicVariantHeights(results, target, analysisScale=1){
  // 追加の画像解析はせず、すでに取得済みのOCR bboxから
  // 解析キャンバス上の実文字高さを推定する。テンプレート本数は2本のまま。
  // 優先順位: 完全一致 > 強い近似候補 > 既定値。
  const exactHeights=[];
  for(const r of (results||[])){
    for(const m of (r.matches||[])){
      const h=(m.y1??0)-(m.y0??0);
      if(Number.isFinite(h) && h>0) exactHeights.push(h*analysisScale);
    }
  }

  let basis=medianNumber(exactHeights);
  let source='完全一致OCR';
  let sampleCount=exactHeights.length;

  if(!Number.isFinite(basis)){
    const nearHeights=[];
    const tlen=[...target].length;
    for(const r of (results||[])){
      for(const c of (r.near||[])){
        if([...c.candidate].length!==tlen) continue;
        if(editDistance(target,c.candidate)!==1) continue;
        if(c.similarity<0.66) continue;
        const ys=(c.units||[]).flatMap(u=>[u?.bbox?.y0,u?.bbox?.y1]).filter(Number.isFinite);
        if(ys.length<2) continue;
        // near候補のbboxはOCRキャンバス座標。結果の元画像換算scaleは後段で使われるため、
        // ここでは analysisScale/totalScale 相当になるよう r._ocrToOriginalScale を利用する。
        const ocrToOriginalScale=Number.isFinite(r._ocrToOriginalScale) ? r._ocrToOriginalScale : null;
        if(!ocrToOriginalScale) continue;
        const originalH=(Math.max(...ys)-Math.min(...ys))*ocrToOriginalScale;
        if(Number.isFinite(originalH) && originalH>0) nearHeights.push(originalH*analysisScale);
      }
    }
    basis=medianNumber(nearHeights);
    source='強い近似OCR';
    sampleCount=nearHeights.length;
  }

  if(!Number.isFinite(basis)){
    return {heights:[...ITALIC_VARIANT_HEIGHTS], basis:null, source:'既定値', sampleCount:0};
  }

  const center=Math.max(22,Math.min(40,Math.round(basis)));
  let a=Math.max(22,center-1), b=Math.min(40,center+1);
  if(a===b) b=Math.min(40,a+1);
  return {heights:[a,b], basis, source, sampleCount};
}

function buildTextTemplateStyled(text, opts={}){
  const italic = opts.italic !== false;
  const color = opts.color || '#ffffff';
  const fontStyle = italic ? 'italic ' : '';
  const targetH = opts.targetHeight || TEMPLATE_TARGET_HEIGHT;
  const skew = Number.isFinite(opts.skew) ? opts.skew : 0;
  const marginX = 18 + Math.ceil(Math.abs(skew) * TEMPLATE_BASE_FONT_SIZE * 3);
  const rawH = Math.ceil(TEMPLATE_BASE_FONT_SIZE * 2.1);
  const probe=document.createElement('canvas');
  const probeCtx=probe.getContext('2d');
  probeCtx.font=`${fontStyle}400 ${TEMPLATE_BASE_FONT_SIZE}px ${TEMPLATE_FONT_STACK}`;
  const met=probeCtx.measureText(text);
  const rawW=Math.ceil(met.width)+marginX*2;

  const m=document.createElement('canvas');
  m.width=rawW; m.height=rawH;
  const g=m.getContext('2d',{willReadFrequently:true});
  g.clearRect(0,0,rawW,rawH);
  g.save();
  g.setTransform(1, 0, skew, 1, 0, 0);
  g.font=`${fontStyle}400 ${TEMPLATE_BASE_FONT_SIZE}px ${TEMPLATE_FONT_STACK}`;
  g.fillStyle=color;
  g.textBaseline='alphabetic';
  g.fillText(text, marginX, TEMPLATE_BASE_FONT_SIZE+4);
  g.restore();

  const d=g.getImageData(0,0,rawW,rawH).data;
  let minX=rawW,minY=rawH,maxX=-1,maxY=-1;
  for(let y=0;y<rawH;y++) for(let x=0;x<rawW;x++){
    if(d[(y*rawW+x)*4+3]>=70){
      if(x<minX)minX=x; if(x>maxX)maxX=x;
      if(y<minY)minY=y; if(y>maxY)maxY=y;
    }
  }
  if(maxX<minX||maxY<minY) return {w:0,h:0,samples:[],bgSamples:[],fontSize:TEMPLATE_BASE_FONT_SIZE,italic,skew,targetHeight:targetH};

  const cropW=maxX-minX+1, cropH=maxY-minY+1;
  const scale=targetH/cropH;
  const targetW=Math.max(1,Math.round(cropW*scale));

  const resized=document.createElement('canvas');
  resized.width=targetW; resized.height=targetH;
  const rg=resized.getContext('2d',{willReadFrequently:true});
  rg.imageSmoothingEnabled=true;
  rg.clearRect(0,0,targetW,targetH);
  rg.drawImage(m,minX,minY,cropW,cropH,0,0,targetW,targetH);

  const rd=rg.getImageData(0,0,targetW,targetH).data;
  const fg=[], bg=[];
  for(let y=0;y<targetH;y++) for(let x=0;x<targetW;x++){
    const a=rd[(y*targetW+x)*4+3];
    if(a>=95) fg.push({x,y});
    else if(a<=12) bg.push({x,y});
  }

  const fgStride=Math.max(1,Math.ceil(fg.length/165));
  const bgStride=Math.max(1,Math.ceil(bg.length/145));
  const fgSamples=[], bgSamples=[];
  for(let i=0;i<fg.length;i+=fgStride) fgSamples.push(fg[i]);
  for(let i=0;i<bg.length;i+=bgStride) bgSamples.push(bg[i]);

  return {
    canvas:resized,w:targetW,h:targetH,
    samples:fgSamples,bgSamples,
    rawW:cropW,rawH:cropH,
    fontSize:TEMPLATE_BASE_FONT_SIZE,
    targetHeight:targetH,
    italic, skew
  };
}

function createGrayFromSource(source, contrastBoost=false){
  const sw=source.naturalWidth||source.width, sh=source.naturalHeight||source.height;
  const c=document.createElement('canvas'); c.width=sw; c.height=sh;
  const g=c.getContext('2d',{willReadFrequently:true});
  g.drawImage(source,0,0,sw,sh);
  const img=g.getImageData(0,0,sw,sh), d=img.data;
  const gray=new Uint8Array(sw*sh);
  for(let i=0,p=0;i<d.length;i+=4,p++){
    let v=Math.round(d[i]*.299+d[i+1]*.587+d[i+2]*.114);
    if(contrastBoost){
      v=Math.max(0,Math.min(255,Math.round((v-128)*1.52+128)));
    }
    gray[p]=v;
  }
  return {gray, sw, sh};
}

function dedupeTemplateCandidates(list, limit=ITALIC_FINAL_LIMIT){
  list.sort((a,b)=>b.score-a.score);
  const out=[];
  for(const c of list){
    const dup=out.some(k=>{
      const ix=Math.max(0, Math.min(c.x+c.w,k.x+k.w)-Math.max(c.x,k.x));
      const iy=Math.max(0, Math.min(c.y+c.h,k.y+k.h)-Math.max(c.y,k.y));
      return ix*iy > Math.min(c.w*c.h, k.w*k.h) * 0.35;
    });
    if(!dup) out.push(c);
    if(out.length>=limit) break;
  }
  return out;
}

function scoreItalicCandidate(gray, sw, x, y, tpl, config){
  let fgHit=0, fgTotal=0, bgHit=0, bgTotal=0;
  const grayTextMin=config.grayTextMin ?? 95;
  const grayTextMax=config.grayTextMax ?? 235;
  const grayBgMax=config.grayBgMax ?? 82;
  for(const p of tpl.samples){
    const lum=gray[(y+p.y)*sw+(x+p.x)];
    if(lum>=grayTextMin && lum<=grayTextMax) fgHit++;
    fgTotal++;
  }
  for(const p of tpl.bgSamples){
    const lum=gray[(y+p.y)*sw+(x+p.x)];
    if(lum<=grayBgMax) bgHit++;
    bgTotal++;
  }
  const fgScore=fgTotal?fgHit/fgTotal:0;
  const bgScore=bgTotal?bgHit/bgTotal:0;
  const score=fgScore*TEMPLATE_FG_WEIGHT+bgScore*TEMPLATE_BG_WEIGHT;
  return {score, fgScore, bgScore};
}


function buildScanPositions(start, end, step, offset=0){
  const arr=[];
  for(let v=start+offset; v<=end; v+=step) arr.push(v);
  if(!arr.length || arr[arr.length-1]!==end) arr.push(end);
  const uniq=[...new Set(arr.filter(v=>v>=start && v<=end))];
  uniq.sort((a,b)=>a-b);
  return uniq;
}


function templateBoxOverlapsExisting(x, y, w, h, existingBoxes=[]) {
  return existingBoxes.some(o => {
    const ox=o.x ?? o.x0 ?? 0;
    const oy=o.y ?? o.y0 ?? 0;
    const ow=o.w ?? ((o.x1??0)-(o.x0??0));
    const oh=o.h ?? ((o.y1??0)-(o.y0??0));
    if(ow<=0 || oh<=0) return false;
    const ix0=Math.max(ox,x), iy0=Math.max(oy,y);
    const ix1=Math.min(ox+ow,x+w), iy1=Math.min(oy+oh,y+h);
    if(ix1<=ix0 || iy1<=iy0) return false;
    const inter=(ix1-ix0)*(iy1-iy0);
    const minArea=Math.min(Math.max(1,ow*oh), Math.max(1,w*h));
    return inter/minArea>=0.35;
  });
}

function buildRegionLimitedPositions(regions, tpl, sw, sh) {
  const margin = 18;
  const xs = new Set();
  const ys = new Set();

  for (const r of (regions || [])) {
    const x0 = Math.max(0, Math.floor(r.x - margin));
    const y0 = Math.max(0, Math.floor(r.y - margin));
    const x1 = Math.min(sw - tpl.w, Math.ceil(r.x + r.w + margin - tpl.w));
    const y1 = Math.min(sh - tpl.h, Math.ceil(r.y + r.h + margin - tpl.h));
    if (x1 < x0 || y1 < y0) continue;

    for (const x of buildScanPositions(x0, x1, ITALIC_COARSE_STEP, 0)) xs.add(x);
    for (const x of buildScanPositions(x0, x1, ITALIC_COARSE_STEP, ITALIC_SECONDARY_OFFSET)) xs.add(x);
    for (const y of buildScanPositions(y0, y1, ITALIC_COARSE_STEP, 0)) ys.add(y);
    for (const y of buildScanPositions(y0, y1, ITALIC_COARSE_STEP, ITALIC_SECONDARY_OFFSET)) ys.add(y);
  }

  return {
    xPositions:[...xs].sort((a,b)=>a-b),
    yPositions:[...ys].sort((a,b)=>a-b)
  };
}

function candidateTouchesSearchRegion(x, y, w, h, regions=[]) {
  if (!regions.length) return true;
  const cx=x+w/2, cy=y+h/2;
  const margin=18;
  return regions.some(r =>
    cx >= r.x-margin &&
    cx <= r.x+r.w+margin &&
    cy >= r.y-margin &&
    cy <= r.y+r.h+margin
  );
}

function searchContrastItalicVariant(gray, sw, sh, tpl, config={}){
  if(!tpl?.w || tpl.w>=sw || tpl.h>=sh){
    return {tpl, coarsePassCount:0, candidates:[], searchXStart:0, searchXEnd:sw, searchYStart:0, searchYEnd:sh};
  }
  const searchYStart=Math.floor(sh*TEMPLATE_SEARCH_TOP_RATIO);
  const searchYEnd=Math.max(searchYStart, sh - tpl.h);
  const searchXStart=Math.floor(sw*TEMPLATE_SEARCH_LEFT_RATIO);
  const searchXEnd=Math.max(searchXStart, sw - tpl.w - Math.floor(sw*TEMPLATE_SEARCH_RIGHT_RATIO));
  const grayTextMin=config.grayTextMin ?? 95;
  const grayTextMax=config.grayTextMax ?? 235;
  const coarseThreshold=config.coarseThreshold ?? 0.60;
  const coarseBgMin=config.coarseBgMin ?? 0.44;
  const finalThreshold=config.finalThreshold ?? 0.63;
  const finalBgMin=config.finalBgMin ?? 0.46;

  const rowHasGray=new Uint8Array(sh);
  for(let y=searchYStart;y<=Math.min(sh-1, searchYEnd+tpl.h);y++){
    let count=0;
    for(let x=searchXStart;x<=searchXEnd;x+=5){
      const v=gray[y*sw+x];
      if(v>=grayTextMin && v<=grayTextMax){
        if(++count>=4) break;
      }
    }
    if(count>=4) rowHasGray[y]=1;
  }

  const coarse=[];
  let coarsePassCount=0;
  let scoredPositionCount=0;
  let skippedExistingCount=0;
  const searchRegions = Array.isArray(config.searchRegions) ? config.searchRegions : [];
  const existingBoxes = Array.isArray(config.existingBoxes) ? config.existingBoxes : [];
  const regionLimited = searchRegions.length > 0;

  let yPositions, xPositions;
  if(regionLimited){
    const regionPositions=buildRegionLimitedPositions(searchRegions,tpl,sw,sh);
    yPositions=regionPositions.yPositions;
    xPositions=regionPositions.xPositions;
  }else{
    yPositions=[...new Set([
      ...buildScanPositions(searchYStart, searchYEnd, ITALIC_COARSE_STEP, 0),
      ...buildScanPositions(searchYStart, searchYEnd, ITALIC_COARSE_STEP, ITALIC_SECONDARY_OFFSET)
    ])].sort((a,b)=>a-b);
    xPositions=[...new Set([
      ...buildScanPositions(searchXStart, searchXEnd, ITALIC_COARSE_STEP, 0),
      ...buildScanPositions(searchXStart, searchXEnd, ITALIC_COARSE_STEP, ITALIC_SECONDARY_OFFSET)
    ])].sort((a,b)=>a-b);
  }

  for(const y of yPositions){
    let rowOk=false;
    for(let yy=0;yy<tpl.h;yy+=Math.max(2,ITALIC_COARSE_STEP)){
      if(rowHasGray[y+yy]){ rowOk=true; break; }
    }
    if(!rowOk) continue;

    for(const x of xPositions){
      if(regionLimited && !candidateTouchesSearchRegion(x,y,tpl.w,tpl.h,searchRegions)) continue;
      if(existingBoxes.length && templateBoxOverlapsExisting(x,y,tpl.w,tpl.h,existingBoxes)){
        skippedExistingCount++;
        continue;
      }
      scoredPositionCount++;
      const s=scoreItalicCandidate(gray, sw, x, y, tpl, config);
      if(s.score>=coarseThreshold && s.bgScore>=coarseBgMin){
        coarsePassCount++;
        coarse.push({x,y,w:tpl.w,h:tpl.h,...s});
      }
    }
  }

  const coarseKept=dedupeTemplateCandidates(coarse, ITALIC_COARSE_LIMIT);
  const refined=[];
  for(const seed of coarseKept){
    const x0=Math.max(searchXStart, seed.x-10), x1=Math.min(searchXEnd, seed.x+10);
    const y0=Math.max(searchYStart, seed.y-10), y1=Math.min(searchYEnd, seed.y+10);
    for(let y=y0;y<=y1;y+=ITALIC_REFINE_STEP){
      for(let x=x0;x<=x1;x+=ITALIC_REFINE_STEP){
        if(regionLimited && !candidateTouchesSearchRegion(x,y,tpl.w,tpl.h,searchRegions)) continue;
        if(existingBoxes.length && templateBoxOverlapsExisting(x,y,tpl.w,tpl.h,existingBoxes)) continue;
        const s=scoreItalicCandidate(gray, sw, x, y, tpl, config);
        if(s.score>=finalThreshold && s.bgScore>=finalBgMin){
          refined.push({x,y,w:tpl.w,h:tpl.h,...s});
        }
      }
    }
  }

  const finalCandidates=dedupeTemplateCandidates(refined, ITALIC_FINAL_LIMIT);
  return {
    tpl, coarsePassCount, candidates:finalCandidates,
    searchXStart, searchXEnd, searchYStart, searchYEnd,
    regionLimited, searchRegionCount:searchRegions.length,
    scoredPositionCount, skippedExistingCount
  };
}

export function italicVariantDiagnosticSearch(source, text, variantHeights=ITALIC_VARIANT_HEIGHTS, searchConfig={}, variantSkews=ITALIC_VARIANT_SKEWS){
  const searchBase=buildItalicSearchCanvas(source);
  const searchScale=searchBase.scale||1;
  const contrast=createGrayFromSource(searchBase.source,true);
  const searchRegions=scaleItalicRects(searchConfig.searchRegions||[],searchScale);
  const existingBoxes=scaleItalicRects(searchConfig.existingBoxes||[],searchScale);
  const variants=[];
  for(const h of variantHeights){
    const scaledH=Math.max(18,Math.round(h*searchScale));
    for(const skew of variantSkews){
      const tpl=buildTextTemplateStyled(text,{italic:true,targetHeight:scaledH,skew});
      const searched=searchContrastItalicVariant(contrast.gray, contrast.sw, contrast.sh, tpl, {
        grayTextMin:95, grayTextMax:235, grayBgMax:84,
        coarseThreshold:0.57, coarseBgMin:0.42,
        finalThreshold:0.60, finalBgMin:0.44,
        searchRegions,
        existingBoxes
      });
      const mapped=(searched.candidates||[]).map(c=>mapItalicCandidateToOriginal(c,searchScale));
      searched.candidates=mapped;
      searched.label=`H${h}→${scaledH} / skew ${skew.toFixed(2)}`;
      searched.key=`h${h}_s${Math.round(skew*100)}`;
      searched.color='#f59e0b';
      searched.italic=true;
      searched.contrast=true;
      searched.targetHeight=h;
      searched.searchTargetHeight=scaledH;
      searched.skew=skew;
      searched.searchScale=searchScale;
      searched.searchCanvasWidth=contrast.sw;
      searched.searchCanvasHeight=contrast.sh;
      variants.push(searched);
    }
  }

  const mergedRaw=[];
  for(const v of variants){
    for(const c of (v.candidates||[])){
      mergedRaw.push({...c, label:v.label, key:v.key, color:v.color, targetHeight:v.targetHeight, searchTargetHeight:v.searchTargetHeight, skew:v.skew});
    }
  }
  const merged=dedupeTemplateCandidates(mergedRaw, 12);
  return {
    variants, merged,
    searchScale,
    searchCanvasWidth:contrast.sw,
    searchCanvasHeight:contrast.sh,
    resized:searchBase.resized
  };
}

export function collectItalicRescueCandidates(source, text, existingBoxes=[], variantHeights=ITALIC_VARIANT_HEIGHTS, detected=null, coordScale=1){
  const regions=(detected?.regions||[]).filter(r=>r && r.w>0 && r.h>0);
  const scaleBoxToSource = o => ({
    ...o,
    x:(o.x ?? o.x0 ?? 0)*coordScale,
    y:(o.y ?? o.y0 ?? 0)*coordScale,
    w:(o.w ?? ((o.x1??0)-(o.x0??0)))*coordScale,
    h:(o.h ?? ((o.y1??0)-(o.y0??0)))*coordScale
  });
  const mapCandidateToOriginal = c => ({
    ...c,
    x:Math.round(c.x/coordScale),
    y:Math.round(c.y/coordScale),
    w:Math.max(1,Math.round(c.w/coordScale)),
    h:Math.max(1,Math.round(c.h/coordScale))
  });
  const accepted=[];
  const acceptedBoxes=[...existingBoxes];
  const existingBoxesSource=(existingBoxes||[]).map(scaleBoxToSource);
  const acceptedBoxesSource=[...existingBoxesSource];
  const passes=[];
  let scoredPositions=0;
  let skippedExisting=0;

  function overlapsExisting(c, boxes=acceptedBoxes){
    return boxes.some(o=>{
      const ox=o.x ?? o.x0 ?? 0;
      const oy=o.y ?? o.y0 ?? 0;
      const ow=o.w ?? ((o.x1??0)-(o.x0??0));
      const oh=o.h ?? ((o.y1??0)-(o.y0??0));
      const ix0=Math.max(ox,c.x), iy0=Math.max(oy,c.y);
      const ix1=Math.min(ox+ow,c.x+c.w), iy1=Math.min(oy+oh,c.y+c.h);
      if(ix1<=ix0||iy1<=iy0) return false;
      const inter=(ix1-ix0)*(iy1-iy0);
      const minArea=Math.min(Math.max(1,ow*oh),c.w*c.h);
      return inter/minArea>=0.35;
    });
  }

  function runPass(label, searchConfig={}){
    const sourceResult=italicVariantDiagnosticSearch(source,text,variantHeights,searchConfig);
    const result={
      ...sourceResult,
      variants:(sourceResult.variants||[]).map(v=>({
        ...v,
        candidates:(v.candidates||[]).map(mapCandidateToOriginal)
      })),
      merged:(sourceResult.merged||[]).map(mapCandidateToOriginal)
    };
    passes.push({label, result});
    const variants=sourceResult.variants||[];
    scoredPositions+=variants.reduce((n,v)=>n+(v.scoredPositionCount||0),0);
    skippedExisting+=variants.reduce((n,v)=>n+(v.skippedExistingCount||0),0);
    for(const c of (sourceResult.merged||[])){
      if(c.score<ITALIC_RESCUE_SCORE_MIN) continue;
      if(c.fgScore<ITALIC_RESCUE_FG_MIN) continue;
      if(c.bgScore<ITALIC_RESCUE_BG_MIN) continue;
      if(overlapsExisting(c, acceptedBoxesSource)) continue;
      const mapped=mapCandidateToOriginal(c);
      accepted.push({...mapped, source:"イタリック救出", passLabel:label});
      acceptedBoxes.push({x:mapped.x,y:mapped.y,w:mapped.w,h:mapped.h});
      acceptedBoxesSource.push({x:c.x,y:c.y,w:c.w,h:c.h});
      if(accepted.length>=ITALIC_RESCUE_MAX_NEW) break;
    }
  }

  if(regions.length){
    // 先に文字領域を優先探索し、その後は未検出部分だけ全画面で補完する。
    runPass("文字領域優先", {searchRegions:regions, existingBoxes:acceptedBoxesSource});
    if(accepted.length<ITALIC_RESCUE_MAX_NEW){
      runPass("全画面補完", {existingBoxes:acceptedBoxesSource});
    }
  }else{
    runPass("全画面", {existingBoxes:acceptedBoxesSource});
  }

  return {
    result: passes[0]?.result || {variants:[], merged:[]},
    passes,
    accepted,
    searchMode: regions.length ? "文字領域優先＋全画面補完" : "全画面",
    searchRegionCount: regions.length,
    scoredPositions,
    skippedExisting
  };
}

// ===== /イタリック補助探索 =====

