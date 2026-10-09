// キャンバス表示・ズーム・再描画だけを担当する。
// OCRや手動編集のロジックはコールバック経由にして逆依存を作らない。
export function createView({
    canvas, ctx, canvasWrap, zoomLabel, state, manualStamps,
    getBaseSource, getBaseSize, paintStamp, updateUndoButton, renderManualSelection,
    minZoom = 1, maxZoom = 4
}) {
    function getBaseDisplaySize() {
        if (!state.sourceImage) return { width: canvas.width, height: canvas.height };
        const availableWidth = Math.max(1, canvasWrap.clientWidth);
        const scale = Math.min(1, availableWidth / canvas.width);
        return { width: canvas.width * scale, height: canvas.height * scale };
    }

    function updateZoomUI() {
        if (!state.sourceImage) return;
        const oldRect = canvas.getBoundingClientRect();
        const wrapRect = canvasWrap.getBoundingClientRect();
        const centerX = (oldRect.left + oldRect.right) / 2 - wrapRect.left;
        const centerY = (oldRect.top + oldRect.bottom) / 2 - wrapRect.top;
        const base = getBaseDisplaySize();

        canvasWrap.classList.toggle("zoomed", state.zoom > 1.001);
        canvas.style.width = `${base.width * state.zoom}px`;
        canvas.style.height = `${base.height * state.zoom}px`;
        zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;

        if (state.zoom > 1.001) {
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
        if (!state.sourceImage) return;
        state.zoom = Math.max(minZoom, Math.min(maxZoom, nextZoom));
        updateZoomUI();
    }

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

    function redrawFromBase() {
        if (!state.sourceImage) return;

        const keepZoom = state.zoom;
        const keepScrollLeft = canvasWrap.scrollLeft;
        const keepScrollTop = canvasWrap.scrollTop;
        const baseSource = getBaseSource();
        const size = getBaseSize();
        const targetWidth = size.width;
        const targetHeight = size.height;

        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
            canvas.width = targetWidth;
            canvas.height = targetHeight;
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(baseSource, 0, 0);

        for (const stamp of manualStamps) paintStamp(stamp);
        updateUndoButton();

        state.zoom = keepZoom;
        const base = getBaseDisplaySize();
        if (keepZoom > 1.001) {
            canvasWrap.classList.add("zoomed");
            canvas.style.width = `${base.width * keepZoom}px`;
            canvas.style.height = `${base.height * keepZoom}px`;
        } else {
            canvasWrap.classList.remove("zoomed");
            canvas.style.width = `${base.width}px`;
            canvas.style.height = `${base.height}px`;
        }
        zoomLabel.textContent = `${Math.round(keepZoom * 100)}%`;

        requestAnimationFrame(() => {
            canvasWrap.scrollLeft = keepScrollLeft;
            canvasWrap.scrollTop = keepScrollTop;
            renderManualSelection();
        });
    }

    return { getBaseDisplaySize, updateZoomUI, setZoom, redrawFromBase, getCanvasDisplayTransform };
}
