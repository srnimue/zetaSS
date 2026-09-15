const $=id=>document.getElementById(id);
const fileInput=$("fileInput"),targetText=$("targetText"),overlayText=$("overlayText");
const putTextOnName=$("putTextOnName"),redactIcon=$("redactIcon"),putTextOnIcon=$("putTextOnIcon");
const processBtn=$("processBtn"),downloadBtn=$("downloadBtn"),statusEl=$("status");
const errorDetails=$("errorDetails"),canvas=$("canvas"),ctx=canvas.getContext("2d");
let sourceImage=null,lastResult=null;

function status(message,error=null){
 statusEl.textContent=message;
 if(error){
  errorDetails.textContent=[
   "message: "+(error.message||String(error)),
   "name: "+(error.name||"unknown"),"",
   "詳細:",error.stack||String(error)
  ].join("\n");
  errorDetails.hidden=false;
 }else{errorDetails.textContent="";errorDetails.hidden=true;}
}

fileInput.addEventListener("change",()=>{
 const file=fileInput.files?.[0]; if(!file)return;
 status("画像を読み込んでいます……");
 const url=URL.createObjectURL(file),img=new Image();
 img.onload=()=>{
  sourceImage=img;canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
  ctx.drawImage(img,0,0);processBtn.disabled=false;downloadBtn.disabled=true;lastResult=null;
  status(`画像を読み込みました。${canvas.width} × ${canvas.height}px`);URL.revokeObjectURL(url);
 };
 img.onerror=()=>{status("画像の読み込みに失敗しました。",new Error("ブラウザがこの画像を読み込めませんでした。"));URL.revokeObjectURL(url)};
 img.src=url;
});

function normalized(s){return String(s||"").replace(/\s+/g,"").replace(/　/g,"")}
function expandBox(b,padX,padY,w,h){
 const x=Math.max(0,Math.floor(b.x-padX)),y=Math.max(0,Math.floor(b.y-padY));
 const right=Math.min(w,Math.ceil(b.x+b.w+padX)),bottom=Math.min(h,Math.ceil(b.y+b.h+padY));
 return{x,y,w:Math.max(1,right-x),h:Math.max(1,bottom-y)};
}
function drawRedaction(box,text,addText){
 ctx.fillStyle="#000";ctx.fillRect(box.x,box.y,box.w,box.h);
 if(!addText||!text)return;
 ctx.fillStyle="#fff";ctx.textAlign="center";ctx.textBaseline="middle";
 const fontSize=Math.max(12,Math.min(box.h*.72,box.w/Math.max(text.length*.65,1)));
 ctx.font=`700 ${Math.floor(fontSize)}px system-ui,sans-serif`;
 ctx.fillText(text,box.x+box.w/2,box.y+box.h/2);
}
function estimateRightIconBox(){
 const size=Math.round(Math.min(canvas.width,canvas.height)*.12),margin=Math.round(size*.35);
 return{x:Math.max(0,canvas.width-size-margin),y:margin,w:size,h:size};
}

async function runOCR(){
 if(window.tesseractLoadError||typeof Tesseract==="undefined")
  throw new Error("Tesseract.jsを読み込めませんでした。インターネット接続、CDNへのアクセス、またはブラウザの通信制限を確認してください。");
 status("OCRエンジンを起動しています……");
 let worker;
 try{
  worker=await Tesseract.createWorker("jpn+eng",1,{logger:m=>{
   if(m.status){const p=m.progress?` ${Math.round(m.progress*100)}%`:"";status(`OCR: ${m.status}${p}`)}
  }});
  status("画像から文字を読み取っています……");
  return await worker.recognize(sourceImage);
 }finally{if(worker)try{await worker.terminate()}catch(_){}}
}

processBtn.addEventListener("click",async()=>{
 if(!sourceImage)return;
 const target=targetText.value.trim();
 if(!target&&!redactIcon.checked){status("隠したい名前を入力するか、アイコン処理をオンにしてください。");return}
 processBtn.disabled=true;downloadBtn.disabled=true;status("処理を開始します……");
 canvas.width=sourceImage.naturalWidth;canvas.height=sourceImage.naturalHeight;ctx.drawImage(sourceImage,0,0);
 try{
  let matches=0;
  if(target){
   const result=await runOCR(),words=result?.data?.words||[],wanted=normalized(target);
   for(const word of words){
    const got=normalized(word.text);if(!got)continue;
    if(got===wanted||got.includes(wanted)||wanted.includes(got)){
     drawRedaction(expandBox(word.bbox,6,5,canvas.width,canvas.height),overlayText.value,putTextOnName.checked);matches++;
    }
   }
  }
  if(redactIcon.checked)drawRedaction(estimateRightIconBox(),overlayText.value,putTextOnIcon.checked);
  lastResult=canvas.toDataURL("image/png");downloadBtn.disabled=false;
  status(target&&matches===0?"OCRは完了しましたが、指定した名前は見つかりませんでした。":`完了。名前 ${matches} 件を黒塗りしました${redactIcon.checked?"。右端アイコンも処理済みです。":""}`);
 }catch(err){console.error("OCR error:",err);status("OCRでエラーが発生しました。下のエラー詳細を確認してください。",err)}
 finally{processBtn.disabled=false}
});

downloadBtn.addEventListener("click",()=>{
 if(!lastResult)return;
 const a=document.createElement("a");a.href=lastResult;a.download="zeta_redacted.png";
 document.body.appendChild(a);a.click();a.remove();
});