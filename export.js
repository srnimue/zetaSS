export function createImageExporter({
    canvas,
    saveBtn,
    getSourceImage,
    getFileName,
    status
}) {
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
        if (!getSourceImage() || !canvas.width || !canvas.height) {
            status("先に画像を処理してください。");
            return;
        }

        saveBtn.disabled = true;
        try {
            const fileName = getFileName();
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

    return { saveImage };
}
