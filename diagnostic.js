import { normalize, editDistance } from "./utils.js?v=92000";
import {
    getOcrLanguage,
    detectTextLikeRegions,
    collectTextRegionMatches,
    OCR_BORDER_PX
} from "./ocr.js?v=92000";
import {
    ITALIC_VARIANT_SKEWS,
    ITALIC_DIAGNOSTIC_SKEWS,
    ITALIC_RESCUE_SCORE_MIN,
    ITALIC_RESCUE_FG_MIN,
    ITALIC_RESCUE_BG_MIN,
    ITALIC_COARSE_STEP,
    ITALIC_REFINE_STEP,
    chooseItalicVariantHeights,
    italicVariantDiagnosticSearch,
    collectItalicRescueCandidates
} from "./italic.js?v=92000";

// OCR診断専用。通常の自動黒塗り経路から診断UIとログ生成を切り離す。
export function createDiagnostic({
    canvas,
    ocrDiagnostics,
    ocrDebugLayer,
    targetText,
    state,
    isOcrBusy,
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
}) {
    async function diagnoseOCR(){
      if (isOcrBusy()) return;
      setOcrBusy(true);
      ocrDiagnostics.hidden=false;
      ocrDebugLayer.hidden=true;
      ocrDebugLayer.innerHTML="";
      canvas.hidden=false;
      canvas.style.display='block';
      try{
        if(!state.sourceImage)throw new Error("先に画像を選択してください。");
        const target=normalize(targetText.value);
        if(!target)throw new Error("黒塗りする文字を入力してください。");
        saveTargetHistoryEntry(targetText.value);
        const totalStarted=performance.now();
        const ocrWorker=await getWorker(getOcrLanguage(target));
        canvas.hidden=false; canvas.style.display="block";
        status("OCR診断中…\n認識条件を比較しています。画像表示は維持します。");
        const ocrStarted=performance.now();
        const analysisState=buildAnalysisCanvas();
        const {results,scale,ocrCanvas,stats,analysisCanvas,analysisScale}=await collectOcrResults(ocrWorker,target,analysisState);
        const diagnosticTextRegions=detectTextLikeRegions(analysisCanvas);
        const diagnosticItalicHeightChoice=chooseItalicVariantHeights(results,target,analysisScale);
        const diagnosticItalicHeights=diagnosticItalicHeightChoice.heights;
        const italicVariantResult=italicVariantDiagnosticSearch(analysisCanvas,target,diagnosticItalicHeights,{},ITALIC_DIAGNOSTIC_SKEWS);
        italicVariantResult.variants=(italicVariantResult.variants||[]).map(v=>({...v,candidates:(v.candidates||[]).map(c=>({...c,x:Math.round(c.x/analysisScale),y:Math.round(c.y/analysisScale),w:Math.max(1,Math.round(c.w/analysisScale)),h:Math.max(1,Math.round(c.h/analysisScale))}))}));
        italicVariantResult.merged=(italicVariantResult.merged||[]).map(c=>({...c,x:Math.round(c.x/analysisScale),y:Math.round(c.y/analysisScale),w:Math.max(1,Math.round(c.w/analysisScale)),h:Math.max(1,Math.round(c.h/analysisScale))}));
        const ocrElapsed=performance.now()-ocrStarted;
        const refineStarted=performance.now();
        const refine=await refineNearCandidates(ocrWorker,results,ocrCanvas,target,scale);
        const refineElapsed=performance.now()-refineStarted;
        const {groups:candidateGroups,refined,acceptedNear}=refine;
        // 診断側でも文脈救出結果を必ず初期化する。
        // 実処理(run)では局所OCR結果も渡すが、診断ではここまでで局所OCRを
        // 実行していないため、まず全体OCRだけを対象にする。
        const totalElapsed=performance.now()-totalStarted;
        const exactCount=results.reduce((n,r)=>n+r.matches.length,0);
        const candidateCount=results.reduce((n,r)=>n+r.near.length,0);
        const lines=[`対象文字：${targetText.value}`,`正規化後：${target}`,`OCR境界線：${OCR_BORDER_PX}px（白）`,""];
        for(const r of results){
          lines.push(`===== ${r.mode} / PSM 11 =====`,`HIT：${r.matches.length}件`);
          for(const m of r.matches){
            const b={x0:m.x0,y0:m.y0,x1:m.x1,y1:m.y1};
            lines.push(`  HIT行：「${m.lineText}」`,`    target bbox=(${b.x0},${b.y0})-(${b.x1},${b.y1})`);
            m.symbols.forEach((s,i)=>{const q=s.bbox;const src=s.bboxSource==="word-split"?" / word均等分割":"";lines.push(`      symbol[${i}] 「${s.ch}」 raw=「${s.raw}」 bbox=(${q.x0},${q.y0})-(${q.x1},${q.y1})${src}`);});
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
            lines.push(`近似候補救出：「${target}」として採用 / OCR候補「${x.candidate}」 / 編集距離${x.recoveryDistance} / 類似度${Math.round(x.similarity*100)}% / 同地点候補${x.candidateCount}件 / 強候補${x.strongCandidateCount}件${x.threeCharConsensus?` / 3文字救出・同誤認${x.threeCharGlobalSpotCount||0}地点`:""}`);
          }
        }
        if(!refined.length && !acceptedNear.length) lines.push('再OCR・近似候補救出で対象文字を確認できた候補地点はありません。');

        lines.push("",`===== 完全一致の最終黒塗り位置 =====`);
        const exactMatches=mergeMatches(results);
        const verifyStarted=performance.now();
        for(const m of exactMatches){
          const ocrBox={x:m.x0,y:m.y0,w:m.x1-m.x0,h:m.y1-m.y0};
          const bboxNote=(m.symbols||[]).some(s=>s.bboxSource==="word-split")?" / symbol異常→word均等分割":"";
          const paintBox=getOcrPaintBox(ocrBox,m.symbols||[]);
          const widthGuardNote=paintBox.shortNameWidthGuard?` / 短名幅ガード ${Math.round(paintBox.originalWidth)}→${Math.round(paintBox.w)}px（左端固定）`:"";
          const finalRect=getOcrVisualRect(ocrBox, m.symbols||[]);
          const widthNormNote=finalRect.shortNameWidthNormalized ? ` / 短名幅正常化:${finalRect.shortNameWidthNormalized}` : '';
          lines.push(`「${m.lineText}」： OCR bbox=(${Math.round(ocrBox.x)},${Math.round(ocrBox.y)},w${Math.round(ocrBox.w)},h${Math.round(ocrBox.h)})${bboxNote}${widthGuardNote}`);
          lines.push(`　→ 最終黒塗り座標=(${Math.round(finalRect.x)},${Math.round(finalRect.y)},w${Math.round(finalRect.w)},h${Math.round(finalRect.h)})${widthNormNote}${finalRect.w<=4?' ※幅が極端に狭い(縦棒の疑いあり)':''}`);
        }
        const verifyElapsed=performance.now()-verifyStarted;
        lines.push(`検証時間：${(verifyElapsed/1000).toFixed(2)}秒 / 対象：${exactMatches.length}件`);

        // 診断でも本番と同じ文字領域検出を使って局所OCR結果を確認する。
        lines.push("",`===== 文字領域全走査＋局所OCR =====`);
        const regionResult=await collectTextRegionMatches(ocrWorker,analysisCanvas,target,analysisScale);
        lines.push(`検出候補：${regionResult.detected.regions.length}領域 / 局所OCR実行：${regionResult.tested.length}領域 / 走査間隔：${regionResult.detected.sample}px / 通常：2倍・PSM7`);
        lines.push(`追加前処理：なし / 追加OCR実行：0回`);
        const regionHits=regionResult.tested.filter(r=>r.hit);
        const baseHits=regionResult.tested.filter(r=>r.baseHit);
        const extraHits=regionResult.tested.filter(r=>r.extraHit);
        lines.push(`対象文字HIT：${regionHits.length}領域（通常OCR：${baseHits.length} / 前処理追加：${extraHits.length}）`);
        regionResult.tested.forEach((r,i)=>{
          const hitModes=r.variants.filter(v=>v.hit).map(v=>v.mode);
          const display=hitModes.length?`★対象HIT [${hitModes.join('・')}]`:'HITなし';
          const rawPreview=r.variants.map(v=>`${v.mode}「${v.raw.length>55?v.raw.slice(0,55)+'…':v.raw}」`).join(' / ');
          lines.push(`  領域${i+1}: (${r.x},${r.y},w${r.w},h${r.h}) / ${r.mode} / ${display} / ${rawPreview}`);
        });
        lines.push(`局所OCR時間：${(regionResult.elapsed/1000).toFixed(2)}秒`);
        lines.push(`色抽出OCR：${stats.colorHitCount||0}件 / ${(stats.colorMs/1000).toFixed(2)}秒`);
        lines.push(`※ この局所OCRのHITは、自動黒塗り候補にも統合します。`);

        // 診断の色付き枠を本番の黒塗り候補と同じ経路で組み立てる。
        // exact → 再OCR/近似救出 → 局所OCR → イタリック救出 の順に統合し、
        // 重複判定と最終矩形(getOcrVisualRect)も本番と揃える。
        const diagnosticPaintBoxes=exactMatches.map(b=>({
          x:b.x0,y:b.y0,w:b.x1-b.x0,h:b.y1-b.y0,symbols:b.symbols||[],source:'OCR'
        }));
        const addDiagnosticCandidate=(box,symbols,source)=>{
          if(!box) return;
          const candidate={x:box.x0,y:box.y0,w:box.x1-box.x0,h:box.y1-box.y0,symbols:symbols||[],source};
          const duplicate=diagnosticPaintBoxes.some(o=>{
            const ix0=Math.max(o.x,candidate.x), iy0=Math.max(o.y,candidate.y);
            const ix1=Math.min(o.x+o.w,candidate.x+candidate.w), iy1=Math.min(o.y+o.h,candidate.y+candidate.h);
            if(ix1<=ix0||iy1<=iy0) return false;
            const inter=(ix1-ix0)*(iy1-iy0);
            const area=Math.min(o.w*o.h,candidate.w*candidate.h);
            return area>0&&inter/area>.45;
          });
          if(!duplicate) diagnosticPaintBoxes.push(candidate);
        };
        for(const r of [...refined,...acceptedNear]){
          const b=r.refinedBox||r.box;
          addDiagnosticCandidate(b,r.symbols||[],r.recovery||'再OCR');
        }
        for(const b of (regionResult.matches||[])){
          addDiagnosticCandidate(b,b.symbols||[],'局所OCR');
        }
        const italicProductionPreview=collectItalicRescueCandidates(
          analysisCanvas,target,diagnosticPaintBoxes,diagnosticItalicHeights,diagnosticTextRegions,analysisScale
        );

        lines.push("",`===== イタリック救出診断 =====`);
        lines.push(`解析キャンバス：${analysisCanvas.width}x${analysisCanvas.height} / scale ${analysisScale.toFixed(3)}${analysisState.resized ? "（統一縮小）" : "（原寸）"}`);
        lines.push(`方式：コントラスト補正 → イタリックテンプレート / 粗探索${ITALIC_COARSE_STEP}px → 局所再探索${ITALIC_REFINE_STEP}px`);
        lines.push(`探索キャンバス：${italicVariantResult.searchCanvasWidth}x${italicVariantResult.searchCanvasHeight} / scale ${italicVariantResult.searchScale.toFixed(3)}${italicVariantResult.resized ? "（縮小）" : "（原寸）"}`);
        lines.push(`テンプレート高さ推定：${diagnosticItalicHeightChoice.source} ${diagnosticItalicHeightChoice.sampleCount}件${Number.isFinite(diagnosticItalicHeightChoice.basis)?` / 中央値 ${diagnosticItalicHeightChoice.basis.toFixed(1)}px`:''}`);
        lines.push(`テンプレートバリエーション：解析基準 ${diagnosticItalicHeights.join("/")}px → 探索時はscale連動 × 診断傾き ${ITALIC_DIAGNOSTIC_SKEWS.map(v=>v.toFixed(2)).join("/")}（本番は ${ITALIC_VARIANT_SKEWS.map(v=>v.toFixed(2)).join("/")}）`);
        const firstVariant=italicVariantResult.variants?.[0];
        lines.push(`探索範囲：x=${firstVariant?.searchXStart||0}〜${firstVariant?.searchXEnd||0} / y=${firstVariant?.searchYStart||0}〜${firstVariant?.searchYEnd||0}`);
        for(const v of (italicVariantResult.variants||[])){
          lines.push(`【${v.label}】 テンプレート:${v.tpl?.w||0}x${v.tpl?.h||0}px / 粗候補${v.coarsePassCount||0}件 / 最終${v.candidates?.length||0}件`);
          (v.candidates||[]).slice(0,3).forEach((c,i)=>lines.push(`  候補${i+1}: score ${c.score.toFixed(3)} / 形状${c.fgScore.toFixed(3)} / 背景${c.bgScore.toFixed(3)} / (${c.x},${c.y},w${c.w},h${c.h})`));
        }
        lines.push(`最終候補：${italicVariantResult.merged?.length||0}件`);
        (italicVariantResult.merged||[]).slice(0,10).forEach((c,i)=>lines.push(`  統合候補${i+1}: score ${c.score.toFixed(3)} / 形状${c.fgScore.toFixed(3)} / 背景${c.bgScore.toFixed(3)} / ${c.label} / (${c.x},${c.y},w${c.w},h${c.h})`));
        lines.push(`本番採用候補：${italicProductionPreview.accepted.length}件 / 条件 score≥${ITALIC_RESCUE_SCORE_MIN.toFixed(2)}・形状≥${ITALIC_RESCUE_FG_MIN.toFixed(2)}・背景≥${ITALIC_RESCUE_BG_MIN.toFixed(2)}`);
        (italicProductionPreview.accepted||[]).slice(0,10).forEach((c,i)=>lines.push(`  本番候補${i+1}: score ${c.score.toFixed(3)} / 形状${c.fgScore.toFixed(3)} / 背景${c.bgScore.toFixed(3)} / (${c.x},${c.y},w${c.w},h${c.h})`));
        lines.push(`※ 3文字名の1文字誤認（例：コカゲ→コカグ）は、同じ誤認が複数地点で確認できた場合に近似候補救出します。
    ※ 色付き枠は本番の最終黒塗り矩形と同じ計算です（緑=通常OCR / 青=局所OCR / 紫=再OCR・近似救出 / オレンジ=イタリック救出）。`);


        lines.push("",`===== 処理時間 =====`,
          `OCR全体：${(ocrElapsed/1000).toFixed(2)}秒`,
          `  第1段階（グレー＋コントラスト）：${(stats.primaryMs/1000).toFixed(2)}秒 / HIT ${stats.primaryHitCount}件`,
          `  追加全体OCR：${stats.fallbackSkippedForSpeed ? "0.00秒 / "+stats.fallbackReason : "0.00秒 / 不要"}`,
          `候補再OCR：${(refineElapsed/1000).toFixed(2)}秒`,
          `診断全体：${(totalElapsed/1000).toFixed(2)}秒`,
          `候補地点：${candidateGroups.length} / 色抽出HIT：${stats.colorHitCount||0} / 近似候補救出：${refine.fastRecovered} / 再OCR実行：${refine.attempted} / 再OCR追加パス：${refine.extraPasses} / 既存HITで省略：${refine.skippedExact}`,
          "",
          `※ 全画面OCRはグレー＋コントラストを主経路にし、重いfallbackは省略します。`,
          `※ イタリック救出は文字領域を先に確認し、既存HITを除外しながら全画面を補完探索します。`,
          `※ 解析処理は先に基準キャンバスへ揃えてから実行し、最後に元画像座標へ戻しています。`,
          `※ 大画像や強い近似候補がある場合は全画面fallbackを省略し、後段の局所救出へ進みます。`,
          `※ 候補地点は同じ位置付近の候補をまとめています。`,
          `※ 近似候補は、対象文字と同じ文字数で、3文字以上の対象なら「対象の1文字違い」程度を先に救出します。
    ※ 近似候補の黒塗り範囲は、候補地点全体ではなく採用候補自身のbboxを使います。`,
          `※ 近似候補救出は再OCRより先に判定し、時間を増やしにくい構成です。`,
          `※ 再OCRは近似候補救出で確定できなかった地点だけ実行します。`,
          `※ 診断で救出した候補は、自動黒塗りにも使用されます。`
        );
        ocrDiagnostics.textContent=lines.join("\n");
        canvas.hidden=false; canvas.style.display='block';
        const tr=getCanvasDisplayTransform();
        const debugColors={
          'OCR':'#22aa55',
          '局所OCR':'#2f80ed',
          '再OCR':'#8e44ad',
          '近似候補救出':'#8e44ad',
          'イタリック救出':'#f59e0b'
        };
        const drawDiagnosticFinalRect=(candidate,labelText)=>{
          const finalRect=getOcrVisualRect(
            {x:candidate.x,y:candidate.y,w:candidate.w,h:candidate.h},
            candidate.symbols||[],
            {source:candidate.source}
          );
          const box=document.createElement('div');
          box.className='ocr-debug-box';
          box.style.borderColor=debugColors[candidate.source]||'#22aa55';
          box.style.left=`${tr.left+finalRect.x*tr.scaleX}px`;
          box.style.top=`${tr.top+finalRect.y*tr.scaleY}px`;
          box.style.width=`${finalRect.w*tr.scaleX}px`;
          box.style.height=`${finalRect.h*tr.scaleY}px`;
          const label=document.createElement('span');
          label.className='ocr-debug-label';
          label.textContent=labelText||candidate.source;
          box.appendChild(label);
          ocrDebugLayer.appendChild(box);
        };

        // exact / 再OCR・近似救出 / 局所OCR は、本番でイタリック探索へ渡す直前の候補。
        for(const c of diagnosticPaintBoxes){
          drawDiagnosticFinalRect(c,`${c.source}: ${target}`);
        }
        // オレンジ枠も rawテンプレートbbox ではなく、本番と同じ最終黒塗り矩形を表示する。
        for(const c of (italicProductionPreview.accepted||[])){
          drawDiagnosticFinalRect(
            {x:c.x,y:c.y,w:c.w,h:c.h,symbols:[],source:'イタリック救出'},
            `イタリック救出 ${c.score.toFixed(2)}`
          );
        }

        ocrDebugLayer.hidden=ocrDebugLayer.childElementCount===0;
        status(`OCR診断完了。\n検出：${exactCount}件（重複を含む） / 候補地点：${candidateGroups.length}箇所 / 再OCR確認：${refined.length}箇所\n処理時間：${(totalElapsed/1000).toFixed(2)}秒\n下の診断結果を確認してください。`);
      }catch(error){
        canvas.hidden=false;canvas.style.display='block';status("OCR診断でエラーが発生しました。",error);
      }finally{
        setOcrBusy(false);
      }
    }

    return { diagnoseOCR };
}
