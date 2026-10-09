import { CONFIG } from "./config.js?v=91500";
import { normalize, editDistance } from "./utils.js?v=91500";

export function getOcrLanguage(target) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(target) ? "jpn" : "eng";
}

export function makeOcrVariant(baseCanvas, name) {
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
    } else if (name === "色抽出") {
        for (let i = 0; i < d.length; i += 4) {
            const r=d[i],g=d[i+1],b=d[i+2];
            const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
            const sat=mx-mn;
            if(sat < 32){ d[i]=d[i+1]=d[i+2]=255; }
            else {
                const y=Math.round(r*.299+g*.587+b*.114);
                d[i]=d[i+1]=d[i+2]=y;
            }
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

// Tesseractは稀に、単語内の1文字だけbboxの位置を誤検出することがある
// （例：「ネ」の実際の描画位置より1文字分右にずれた座標を報告する等）。
// そのまま使うと黒塗り位置そのものがズレてしまい、paddingを足しても直せない。
// なので「単語内のsymbolが順番通りに並び、単語全体のbboxの端まできちんと
// 埋まっているか」を確認し、怪しい場合だけ単語bboxの均等分割にフォールバックする。
function symbolsLookValid(word, syms) {
    const wb = word?.bbox;
    if (!wb || !syms.length) return false;

    let prevX1 = wb.x0 - 1;
    for (const s of syms) {
        const b=s?.bbox;
        if (!b || b.x1<=b.x0 || b.y1<=b.y0) return false;
        if (b.x0 < prevX1 - 2) return false;
        prevX1 = b.x1;
    }

    const first = syms[0].bbox, last = syms[syms.length - 1].bbox;
    const wordWidth = Math.max(1, wb.x1 - wb.x0);
    const leftGap = first.x0 - wb.x0;
    const rightGap = wb.x1 - last.x1;
    if (leftGap > wordWidth * 0.25 || rightGap > wordWidth * 0.25) return false;

    // 名前用途で特に重要な1〜3文字の日本語を安定させるため、
    // 日本語symbolだけ「1文字なのに異常に横長」「文字幅が1つだけ極端」を軽く検査する。
    // 異常ならここで座標を直接いじらず、呼び出し側のword bbox均等分割に任せる。
    const japanese = syms
        .map(s => ({ s, chars:[...normalize(s.text)] }))
        .filter(e => e.chars.length===1 && /[ぁ-ゖァ-ヺ一-龯々〆ヵヶ]/u.test(e.chars[0]))
        .map(e => {
            const b=e.s.bbox;
            return { w:b.x1-b.x0, h:b.y1-b.y0 };
        });

    if (japanese.length >= 2) {
        if (japanese.some(e => e.w / Math.max(1,e.h) > 1.80)) return false;

        const widths=japanese.map(e=>e.w).sort((a,b)=>a-b);
        const minW=Math.max(1,widths[0]);
        const maxW=widths[widths.length-1];
        if (japanese.length <= 3) {
            if (maxW / minW > 2.20) return false;
        } else {
            const mid=Math.floor(widths.length/2);
            const median=widths.length%2 ? widths[mid] : (widths[mid-1]+widths[mid])/2;
            if (median>0 && maxW > median*2.20) return false;
        }
    }

    return true;
}

function extractLineUnits(line){
  const units=[];
  for(const word of (line?.words||[])){
    const rawSyms=(word?.symbols||[]).filter(s=>s?.bbox);
    const kept=rawSyms.filter(s=>normalize(s.text));
    if(kept.length&&symbolsLookValid(word,kept)){
      for(let idx=0;idx<rawSyms.length;idx++){
        const s=rawSyms[idx];
        const chNorm=normalize(s.text);
        if(!chNorm) continue;
        const chars=[...chNorm];
        let ch;
        if(chars.length>1){
          // 同じ複数文字ラベルが連続symbolへ重複して付くケースでは、
          // bboxは維持したまま連続順に1文字ずつ割り当てる。
          let runStart=idx;
          while(runStart>0&&normalize(rawSyms[runStart-1].text)===chNorm)runStart--;
          const posInRun=idx-runStart;
          ch=chars[Math.min(posInRun,chars.length-1)];
        }else{
          ch=chars[0];
        }
        units.push({ch,bbox:s.bbox,raw:s.text,bboxSource:'symbol'});
      }
    }else if(word?.bbox&&normalize(word.text)){
      // symbolの順序・幅が怪しい時は、word全体を正規化後の文字数で均等分割する。
      // 追加OCRは使わないため速度への影響はほぼない。
      const chars=[...normalize(word.text)],b=word.bbox;
      chars.forEach((ch,i)=>{
        const bbox={x0:b.x0+(b.x1-b.x0)*i/chars.length,y0:b.y0,x1:b.x0+(b.x1-b.x0)*(i+1)/chars.length,y1:b.y1};
        units.push({ch,raw:word.text,bbox,bboxSource:'word-split'});
      });
    }
  }
  return units;
}

function makeTargetHit(selected, kind="exact", skipped=[]) {
  return {
    targetBox:{
      x0:Math.min(...selected.map(u=>u.bbox.x0)),
      y0:Math.min(...selected.map(u=>u.bbox.y0)),
      x1:Math.max(...selected.map(u=>u.bbox.x1)),
      y1:Math.max(...selected.map(u=>u.bbox.y1))
    },
    symbols:selected,
    kind,
    skipped
  };
}

function findTargetInUnits(units,target){
  const targetChars=Array.from(target), hits=[];
  if(!targetChars.length) return hits;
  const textChars=units.map(u=>u.ch);
  for(let i=0;i<=textChars.length-targetChars.length;){
    let matched=true;
    for(let j=0;j<targetChars.length;j++){
      if(textChars[i+j]!==targetChars[j]){ matched=false; break; }
    }
    if(matched){
      const selected=units.slice(i,i+targetChars.length);
      if(selected.length===targetChars.length) hits.push(makeTargetHit(selected,'exact'));
      i+=Math.max(1,targetChars.length);
    }else{
      i++;
    }
  }
  return hits;
}

// 文字密度から横長のテキスト候補領域を推定する。
// OCR本体の追加局所走査と診断の両方で使用する。
export function detectTextLikeRegions(sourceCanvas) {
  const ctx=sourceCanvas.getContext('2d',{willReadFrequently:true});
  const img=ctx.getImageData(0,0,sourceCanvas.width,sourceCanvas.height);
  const d=img.data, w=img.width, h=img.height;
  const sample=2;
  const sw=Math.ceil(w/sample), sh=Math.ceil(h/sample);
  const regions=[];

  // 黒文字・白文字の両方を軽く見る。スクショの吹き出しや背景を
  // 完全には判別せず、「文字候補を拾う」ことを目的にする。
  for(const mode of ['dark','light']){
    const rows=new Uint16Array(sh);
    const rowXs=Array.from({length:sh},()=>[w,h,0,0]);
    for(let sy=0;sy<sh;sy++){
      const y=Math.min(h-1,sy*sample);
      for(let sx=0;sx<sw;sx++){
        const x=Math.min(w-1,sx*sample);
        const i=(y*w+x)*4;
        const g=d[i]*.299+d[i+1]*.587+d[i+2]*.114;
        const hit=mode==='dark'?g<185:g>225;
        if(!hit) continue;
        rows[sy]++;
        const r=rowXs[sy];
        if(x<r[0])r[0]=x; if(y<r[1])r[1]=y;
        if(x>r[2])r[2]=x; if(y>r[3])r[3]=y;
      }
    }
    const minHits=Math.max(3,Math.round(sw*.0015));
    let start=-1,last=-1;
    for(let sy=0;sy<sh;sy++){
      if(rows[sy]>=minHits){
        if(start<0)start=sy;
        last=sy;
      }else if(start>=0 && sy-last>3){
        const y0=Math.max(0,start*sample-10), y1=Math.min(h,(last+1)*sample+10);
        let x0=w,x1=0,total=0;
        for(let q=start;q<=last;q++){
          if(rows[q]){
            x0=Math.min(x0,rowXs[q][0]);
            x1=Math.max(x1,rowXs[q][2]);
            total+=rows[q];
          }
        }
        if(x1>x0){
          x0=Math.max(0,x0-14); x1=Math.min(w,x1+14);
          const rw=x1-x0,rh=y1-y0;
          if(rh>=14&&rh<=110&&rw>=35&&rw<=Math.min(w,1400)){
            regions.push({x:x0,y:y0,w:rw,h:rh,mode,density:total/Math.max(1,rw*rh/(sample*sample))});
          }
        }
        start=-1; last=-1;
      }
    }
    if(start>=0){
      const y0=Math.max(0,start*sample-10), y1=Math.min(h,(last+1)*sample+10);
      let x0=w,x1=0,total=0;
      for(let q=start;q<=last;q++) if(rows[q]){x0=Math.min(x0,rowXs[q][0]);x1=Math.max(x1,rowXs[q][2]);total+=rows[q];}
      if(x1>x0){
        x0=Math.max(0,x0-14);x1=Math.min(w,x1+14);
        const rw=x1-x0,rh=y1-y0;
        if(rh>=14&&rh<=110&&rw>=35&&rw<=Math.min(w,1400)) regions.push({x:x0,y:y0,w:rw,h:rh,mode,density:total/Math.max(1,rw*rh/(sample*sample))});
      }
    }
  }

  // 重なったdark/light候補や同じ行の候補をまとめる。
  regions.sort((a,b)=>b.density-a.density);
  const dedup=[];
  for(const r of regions){
    const overlap=dedup.some(q=>{
      const ix=Math.max(0,Math.min(r.x+r.w,q.x+q.w)-Math.max(r.x,q.x));
      const iy=Math.max(0,Math.min(r.y+r.h,q.y+q.h)-Math.max(r.y,q.y));
      return ix*iy>Math.min(r.w*r.h,q.w*q.h)*.45;
    });
    if(!overlap) dedup.push(r);
    if(dedup.length>=24) break;
  }
  return {sample,regions:dedup};
}

async function recognizeLocalRegionVariant(worker, crop, target, mode) {
  const input = mode === '通常' ? crop : makeOcrVariant(crop, mode);
  let raw = '';
  let hit = false;
  const matches = [];
  const lineData = [];
  try {
    const result = await worker.recognize(input, {tessedit_pageseg_mode:'7'});
    raw = String(result?.data?.text || '').replace(/\s+/g,' ').trim();
    for (const line of (result?.data?.lines || [])) {
      const units = extractLineUnits(line);
      const found = findTargetInUnits(units, target);
      lineData.push({units, text: units.map(u => u.ch).join('')});
      if (found.length) {
        hit = true;
        matches.push(...found);
      }
    }
  } catch (e) {
    raw = `ERROR: ${e?.message || e}`;
  } finally {
    if (input !== crop) { input.width = 1; input.height = 1; }
  }
  return {mode, raw, hit, matches, lineData};
}

// 文字っぽい領域を全走査し、局所OCRのHITと診断用情報を同時に返す。
// 本番と診断で同じ処理を共有し、検出経路の二重実装を避ける。
export async function collectTextRegionMatches(worker, sourceCanvas, target, coordScale=1) {
  const detected = detectTextLikeRegions(sourceCanvas);
  const SCALE = 2;
  const matches = [];
  const tested = [];
  const started = performance.now();

  for (const r of detected.regions) {
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(r.w * SCALE));
    crop.height = Math.max(1, Math.round(r.h * SCALE));
    const cctx = crop.getContext('2d');
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(sourceCanvas, r.x, r.y, r.w, r.h, 0, 0, crop.width, crop.height);

    const normal = await recognizeLocalRegionVariant(worker, crop, target, '通常');
    const regionMatches = [];
    for (const hit of normal.matches || []) {
      const b = hit.targetBox;
      regionMatches.push({
        x0: (r.x + b.x0 / SCALE) / coordScale,
        y0: (r.y + b.y0 / SCALE) / coordScale,
        x1: (r.x + b.x1 / SCALE) / coordScale,
        y1: (r.y + b.y1 / SCALE) / coordScale,
        symbols: (hit.symbols || []).map(u => ({
          ...u,
          bbox: {
            x0: (r.x + u.bbox.x0 / SCALE) / coordScale,
            y0: (r.y + u.bbox.y0 / SCALE) / coordScale,
            x1: (r.x + u.bbox.x1 / SCALE) / coordScale,
            y1: (r.y + u.bbox.y1 / SCALE) / coordScale
          }
        })),
        lineText: normal.raw,
        source: '局所OCR'
      });
    }
    matches.push(...regionMatches);
    tested.push({
      ...r,
      x: r.x / coordScale,
      y: r.y / coordScale,
      w: r.w / coordScale,
      h: r.h / coordScale,
      hit: normal.hit,
      baseHit: normal.hit,
      extraHit: false,
      variants: [normal],
      raw: normal.raw,
      matches: regionMatches,
      lineData: normal.lineData || []
    });
    crop.width = 1;
    crop.height = 1;
  }

  return {
    detected,
    tested,
    matches,
    elapsed: performance.now() - started,
    extraRuns: 0,
    extraModes: []
  };
}

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
  const targetChars = Array.from(target);
  const tlen = targetChars.length;
  if (!tlen) return out;

  for (const line of lines) {
    const u = extractLineUnits(line);
    const textChars = u.map(x => x.ch);
    const t = textChars.join("");
    if (!textChars.length) continue;

    // 完全一致だけでなく「一部の文字だけ別の字として読まれた」ケースも候補にする。
    // 例：ゆーざー → ポーざー / めーざー / ゆーゴー。
    const minLen = Math.max(1, tlen - 2);
    const maxLen = Math.min(textChars.length, tlen + 2);

    for (let i = 0; i < textChars.length; i++) {
      for (let len = minLen; len <= maxLen && i + len <= textChars.length; len++) {
        const c = textChars.slice(i, i + len).join("");
        const editSim = 1 - editDistance(target, c) / Math.max(tlen, [...c].length);
        const seqSim = sequenceSimilarity(target, c);
        const exactChars = [...target].filter(ch => [...c].includes(ch)).length;

        // まず「並びが近い」ことを重視。4文字の対象なら2文字一致でも救出候補にする。
        // 本当に対象かどうかは、この後の局所再OCRで確認する。
        const score = Math.max(editSim, seqSim);
        const minShared = tlen <= 2 ? tlen : Math.max(2, Math.ceil(tlen * 0.5));
        if (score >= CONFIG.near.minSimilarity && exactChars >= minShared) {
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

export function makeCandidateCrop(ocrCanvas, candidate) {
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

function shiftOcrBboxes(value,dx,dy){
  if(Array.isArray(value)) return value.map(v=>shiftOcrBboxes(v,dx,dy));
  if(!value || typeof value!=="object") return value;
  const out={};
  for(const [k,v] of Object.entries(value)){
    if(k==="bbox" && v && typeof v.x0==="number") out[k]={...v,x0:v.x0-dx,y0:v.y0-dy,x1:v.x1-dx,y1:v.y1-dy};
    else out[k]=shiftOcrBboxes(v,dx,dy);
  }
  return out;
}

export async function recognizeVariant(worker,inputCanvas,target,mode,scale,offsetX=0,offsetY=0){const result=await worker.recognize(inputCanvas,{tessedit_pageseg_mode:"11"});const data=result?.data||{},rawLines=data.lines||[],lines=(offsetX||offsetY)?shiftOcrBboxes(rawLines,offsetX,offsetY):rawLines,matches=[];for(const line of lines){const units=extractLineUnits(line),hits=findTargetInUnits(units,target),lineText=units.map(u=>u.ch).join("");for(const hit of hits){
    // symbols[].bbox はOCR用に拡大したcanvas(scale倍)の座標。境界線を追加した場合は
    // その分のoffsetも引いて元画像座標へ戻す。
    const scaleBbox=b=>b?{x0:(b.x0)/scale,y0:(b.y0)/scale,x1:(b.x1)/scale,y1:(b.y1)/scale}:null;
    const symbols=hit.symbols.map(s=>({...s,bbox:scaleBbox(s.bbox)}));
    matches.push({x0:hit.targetBox.x0/scale,y0:hit.targetBox.y0/scale,x1:hit.targetBox.x1/scale,y1:hit.targetBox.y1/scale,mode,lineText,symbols});
}}const words=(offsetX||offsetY)?shiftOcrBboxes(data.words||[],offsetX,offsetY):(data.words||[]);return {mode,lines,words,rawText:String(data.text||""),matches,near:findNearCandidates(lines,target)};}

const OCR_BORDER_PX = 10;

export function makeWhiteBorderCanvas(src,pad){
  const c=document.createElement("canvas");
  c.width=src.width+pad*2;
  c.height=src.height+pad*2;
  const g=c.getContext("2d");
  g.fillStyle="#fff";
  g.fillRect(0,0,c.width,c.height);
  g.drawImage(src,pad,pad);
  return c;
}

const ANALYSIS_CANVAS_MAX_WIDTH = 1000;
const ANALYSIS_CANVAS_MAX_PIXELS = 2500000;

