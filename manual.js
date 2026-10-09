import { state, manualStamps } from "./state.js?v=91700";

export function createManual({
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
}) {
    let manualMode = false;
    let stampTapStart = null;
    let isDragging = false;
    let dragStart = null;
    const manualHistory = [];
    let selectedManualIndex = -1;
    let editMode = null; // { type: "move" | "resize", handle: string|null, startPoint, original }

    const MIN_MANUAL_SIZE = 4;
    const pointers = new Map();
    let pinchStartDistance = 0;
    let pinchStartZoom = 1;
    let panLastCenter = null;
    let multiTouchGestureActive = false;

    // 新規手動描画の指オフセットは「画面上のCSS px」で管理する。
    // ズーム倍率が変わっても、指から見た描画位置の距離を一定にする。
    const TOUCH_Y_OFFSET_SCREEN_PX = -40;
    const MANUAL_HIT_RADIUS_PX = 30;
    const TRACE_DISPLAY_HEIGHT_PX = 32;

    function getCanvasPoint(event) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * canvas.width / rect.width,
            y: (event.clientY - rect.top) * canvas.height / rect.height
        };
    }

    function getPointerDistance() {
        const values = [...pointers.values()];
        if (values.length < 2) return 0;
        return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
    }

    function getLastManualStamp() {
        for (let i = manualStamps.length - 1; i >= 0; i--) {
            if (manualStamps[i].kind !== "ocr") return manualStamps[i];
        }
        return null;
    }

    function updateStampModeUI() {
        const lastManual = getLastManualStamp();
        if (stampModeWrap) stampModeWrap.hidden = !manualMode;
        if (stampMode) stampMode.disabled = !manualMode || !lastManual;
        if ((!manualMode || !lastManual) && stampMode) stampMode.checked = false;
    }

    function updateUndoButton() {
        undoBtn.disabled = manualHistory.length === 0;
        updateStampModeUI();
    }

    function snapshotManualStamps() {
        return manualStamps.map(stamp => ({ ...stamp }));
    }

    function pushManualHistory() {
        manualHistory.push(snapshotManualStamps());
        if (manualHistory.length > 50) manualHistory.shift();
    }

    function restoreManualSnapshot(snapshot) {
        manualStamps.length = 0;
        for (const stamp of snapshot) manualStamps.push({ ...stamp });
        selectedManualIndex = -1;
        editMode = null;
        selection.hidden = true;
        redrawFromBase();
    }

    function hideManualDeleteButton() {
        if (!manualDeleteBtn) return;
        manualDeleteBtn.hidden = true;
        manualDeleteBtn.style.left = "";
        manualDeleteBtn.style.top = "";
    }

    function renderManualSelection() {
        if (selectedManualIndex < 0 || !manualStamps[selectedManualIndex]) {
            selection.hidden = true;
            selection.innerHTML = "";
            hideManualDeleteButton();
            return;
        }
        const stamp = manualStamps[selectedManualIndex];
        const transform = getCanvasDisplayTransform();
        selection.hidden = false;
        selection.style.left = `${transform.left + stamp.x * transform.scaleX}px`;
        selection.style.top = `${transform.top + stamp.y * transform.scaleY}px`;
        selection.style.width = `${stamp.w * transform.scaleX}px`;
        selection.style.height = `${stamp.h * transform.scaleY}px`;
        selection.innerHTML = "";

        if (manualDeleteBtn && manualMode) {
            manualDeleteBtn.style.left = `${transform.left + stamp.x * transform.scaleX - 18}px`;
            manualDeleteBtn.style.top = `${transform.top + stamp.y * transform.scaleY - 18}px`;
            manualDeleteBtn.hidden = false;
        } else {
            hideManualDeleteButton();
        }
        for (const handle of ["nw", "ne", "sw", "se"]) {
            const el = document.createElement("span");
            el.className = `edit-handle handle-${handle}`;
            el.dataset.handle = handle;
            selection.appendChild(el);
        }
    }

    function getManualHitRadiusCanvas() {
        const transform = getCanvasDisplayTransform();
        const scale = Math.max(0.0001, Math.min(transform.scaleX, transform.scaleY));
        return MANUAL_HIT_RADIUS_PX / scale;
    }

    function getResizeHandle(point, stamp, radius = null) {
        const size = radius ?? getManualHitRadiusCanvas();
        const handles = {
            nw: [stamp.x, stamp.y],
            ne: [stamp.x + stamp.w, stamp.y],
            sw: [stamp.x, stamp.y + stamp.h],
            se: [stamp.x + stamp.w, stamp.y + stamp.h]
        };
        let best = null;
        let bestDistance = Infinity;
        for (const [name, [x, y]] of Object.entries(handles)) {
            const distance = Math.hypot(point.x - x, point.y - y);
            if (distance <= size && distance < bestDistance) {
                best = name;
                bestDistance = distance;
            }
        }
        return best;
    }

    function findManualEditTarget(point) {
        const radius = getManualHitRadiusCanvas();

        let bestHandle = null;
        for (let i = manualStamps.length - 1; i >= 0; i--) {
            const stamp = manualStamps[i];
            const handle = getResizeHandle(point, stamp, radius);
            if (!handle) continue;
            const hx = handle.includes("e") ? stamp.x + stamp.w : stamp.x;
            const hy = handle.includes("s") ? stamp.y + stamp.h : stamp.y;
            const distance = Math.hypot(point.x - hx, point.y - hy);
            if (!bestHandle || distance < bestHandle.distance) {
                bestHandle = { index: i, handle, distance };
            }
        }
        if (bestHandle) return { index: bestHandle.index, type: "resize", handle: bestHandle.handle };

        for (let i = manualStamps.length - 1; i >= 0; i--) {
            const b = manualStamps[i];
            if (point.x >= b.x - radius && point.x <= b.x + b.w + radius &&
                point.y >= b.y - radius && point.y <= b.y + b.h + radius) {
                return { index: i, type: "move", handle: null };
            }
        }
        return null;
    }

    function hitTestManual(point) {
        return findManualEditTarget(point)?.index ?? -1;
    }

    function applyMoveEdit(current) {
        const b = manualStamps[selectedManualIndex];
        const dx = current.x - editMode.startPoint.x;
        const dy = current.y - editMode.startPoint.y;
        b.x = Math.max(0, Math.min(canvas.width - b.w, editMode.original.x + dx));
        b.y = Math.max(0, Math.min(canvas.height - b.h, editMode.original.y + dy));
    }

    function applyResizeEdit(current) {
        const b = manualStamps[selectedManualIndex];
        const o = editMode.original;
        let x = o.x, y = o.y, w = o.w, h = o.h;
        const dx = current.x - editMode.startPoint.x;
        const dy = current.y - editMode.startPoint.y;
        const handle = editMode.handle;
        if (handle.includes("e")) w = o.w + dx;
        if (handle.includes("s")) h = o.h + dy;
        if (handle.includes("w")) { x = o.x + dx; w = o.w - dx; }
        if (handle.includes("n")) { y = o.y + dy; h = o.h - dy; }
        if (w < MIN_MANUAL_SIZE) { if (handle.includes("w")) x = o.x + o.w - MIN_MANUAL_SIZE; w = MIN_MANUAL_SIZE; }
        if (h < MIN_MANUAL_SIZE) { if (handle.includes("n")) y = o.y + o.h - MIN_MANUAL_SIZE; h = MIN_MANUAL_SIZE; }
        x = Math.max(0, Math.min(canvas.width - w, x));
        y = Math.max(0, Math.min(canvas.height - h, y));
        b.x = x; b.y = y; b.w = w; b.h = h;
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

    function getTraceCanvasHeight() {
        if (!canvas.width || !canvas.height) return TRACE_DISPLAY_HEIGHT_PX;
        const base = getBaseDisplaySize();
        const baseScaleY = Math.max(0.0001, base.height / canvas.height);
        return Math.max(32, Math.min(44, TRACE_DISPLAY_HEIGHT_PX / baseScaleY));
    }

    function getTraceRect(start, current) {
        const x = Math.min(start.x, current.x);
        const w = Math.abs(current.x - start.x);
        const h = getTraceCanvasHeight();
        const y = Math.max(0, Math.min(canvas.height - h, start.y - h / 2));
        return { x, y, w, h };
    }

    function updateTraceSelection(start, current) {
        const rect = getTraceRect(start, current);
        const transform = getCanvasDisplayTransform();
        selection.hidden = false;
        selection.style.left = `${transform.left + rect.x * transform.scaleX}px`;
        selection.style.top = `${transform.top + rect.y * transform.scaleY}px`;
        selection.style.width = `${rect.w * transform.scaleX}px`;
        selection.style.height = `${rect.h * transform.scaleY}px`;
    }

    function startManualMode() {
        if (!state.sourceImage) return;
        manualMode = true;
        document.body.classList.add("manual-mode");
        manualDoneBtn.hidden = false;
        manualBtn.disabled = true;
        updateStampModeUI();
        status(`手動黒塗りモードです。\n描画方法：${manualDrawMode?.value === "trace" ? "なぞり式" : "自由矩形"}`);
    }

    function stopManualMode() {
        manualMode = false;
        document.body.classList.remove("manual-mode");
        isDragging = false;
        dragStart = null;
        stampTapStart = null;
        selection.hidden = true;
        hideManualDeleteButton();
        if (stampMode) stampMode.checked = false;
        manualDoneBtn.hidden = true;
        manualBtn.disabled = !state.sourceImage;
        updateStampModeUI();
        if (state.sourceImage) status(`手動黒塗り終了：追加した黒塗り ${manualStamps.length}箇所`);
    }

    function placeStampAt(point) {
        if (!manualStamps.length) return;
        const last = getLastManualStamp();
        if (!last) return;
        const stamp = {
            x: point.x - last.w / 2,
            y: point.y - last.h / 2,
            w: last.w,
            h: last.h,
            style: getCurrentRedactionStyle(),
            kind: "manual"
        };
        stamp.x = Math.max(0, Math.min(canvas.width - stamp.w, stamp.x));
        stamp.y = Math.max(0, Math.min(canvas.height - stamp.h, stamp.y));
        pushManualHistory();
        manualStamps.push(stamp);
        paintManual(stamp, stamp.style);
        updateUndoButton();
        saveBtn.disabled = false;
        status(`スタンプを追加しました。\n追加済み：${manualStamps.length}箇所`);
    }

    function finishStamp(point) {
        if (!dragStart) return;
        let x, y, w, h;
        if (manualDrawMode?.value === "trace") {
            ({ x, y, w, h } = getTraceRect(dragStart, point));
        } else {
            x = Math.min(dragStart.x, point.x);
            y = Math.min(dragStart.y, point.y);
            w = Math.abs(point.x - dragStart.x);
            h = Math.abs(point.y - dragStart.y);
        }
        selection.hidden = true;
        if (w < MIN_MANUAL_SIZE || h < MIN_MANUAL_SIZE) {
            dragStart = null;
            return;
        }
        const stamp = { x, y, w, h, style: getCurrentRedactionStyle(), kind: "manual" };
        pushManualHistory();
        manualStamps.push(stamp);
        paintManual(stamp, stamp.style);
        updateUndoButton();
        saveBtn.disabled = false;
        status(`${manualDrawMode?.value === "trace" ? "なぞり式" : "手動"}黒塗りを追加しました。\n追加済み：${manualStamps.length}箇所`);
        dragStart = null;
    }

    function getRawManualPoint(event) {
        return getCanvasPoint(event);
    }

    function getManualDrawPoint(event) {
        if (event.pointerType !== "touch") return getRawManualPoint(event);
        const raw = getRawManualPoint(event);
        const transform = getCanvasDisplayTransform();
        const scaleY = Math.max(0.0001, transform.scaleY);
        return { x: raw.x, y: raw.y + TOUCH_Y_OFFSET_SCREEN_PX / scaleY };
    }

    function getManualPoint(event, applyOffset = true) {
        return applyOffset ? getManualDrawPoint(event) : getRawManualPoint(event);
    }

    function getTraceManualPoint(event) {
        return getManualDrawPoint(event);
    }

    function getPointerCenter() {
        const values = [...pointers.values()];
        if (!values.length) return null;
        return {
            x: values.reduce((sum, p) => sum + p.x, 0) / values.length,
            y: values.reduce((sum, p) => sum + p.y, 0) / values.length
        };
    }

    function resetManualGestureState() {
        pointers.clear();
        pinchStartDistance = 0;
        pinchStartZoom = state.zoom;
        panLastCenter = null;
        multiTouchGestureActive = false;
        isDragging = false;
        dragStart = null;
        stampTapStart = null;
        editMode = null;
    }

    function resetState({ redraw = true } = {}) {
        manualStamps.length = 0;
        manualHistory.length = 0;
        selectedManualIndex = -1;
        editMode = null;
        resetManualGestureState();
        selection.hidden = true;
        selection.innerHTML = "";
        hideManualDeleteButton();
        updateUndoButton();
        if (redraw) redrawFromBase();
    }

    function deleteSelectedManualStamp() {
        if (selectedManualIndex < 0 || !manualStamps[selectedManualIndex]) return;
        pushManualHistory();
        manualStamps.splice(selectedManualIndex, 1);
        selectedManualIndex = -1;
        resetManualGestureState();
        hideManualDeleteButton();
        redrawFromBase();
        saveBtn.disabled = false;
        status(`選択した黒塗りを削除しました。\n残り：${manualStamps.length}箇所`);
    }

    manualDeleteBtn?.addEventListener("pointerdown", event => {
        event.preventDefault();
        event.stopPropagation();
        resetManualGestureState();
    });

    manualDeleteBtn?.addEventListener("pointerup", event => {
        event.preventDefault();
        event.stopPropagation();
    });

    manualDeleteBtn?.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        deleteSelectedManualStamp();
    });

    canvasWrap.addEventListener("pointerdown", event => {
        if (!state.sourceImage) return;

        if (event.pointerType === "touch" && event.isPrimary) {
            pointers.clear();
            pinchStartDistance = 0;
            pinchStartZoom = state.zoom;
            panLastCenter = null;
            multiTouchGestureActive = false;
            isDragging = false;
            dragStart = null;
            stampTapStart = null;
            editMode = null;
        }

        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        canvasWrap.setPointerCapture?.(event.pointerId);

        if (pointers.size >= 2) {
            multiTouchGestureActive = true;
            isDragging = false;
            dragStart = null;
            stampTapStart = null;
            editMode = null;
            selection.hidden = true;
            hideManualDeleteButton();
            pinchStartDistance = getPointerDistance();
            pinchStartZoom = state.zoom;
            panLastCenter = getPointerCenter();
            event.preventDefault();
            return;
        }

        panLastCenter = null;
        pinchStartDistance = 0;
        if (!manualMode) return;
        event.preventDefault();
        hideManualDeleteButton();

        const rawPoint = getRawManualPoint(event);
        const editTarget = findManualEditTarget(rawPoint);
        if (editTarget) {
            dragStart = rawPoint;
            selectedManualIndex = editTarget.index;
            const hitStamp = manualStamps[editTarget.index];
            editMode = {
                type: editTarget.type,
                handle: editTarget.handle,
                startPoint: { ...dragStart },
                original: { ...hitStamp },
                historyPushed: false
            };
            isDragging = true;
            renderManualSelection();
            status(editTarget.type === "resize"
                ? "黒塗りの角を掴みました。\nドラッグでサイズ変更できます。"
                : "黒塗りを掴みました。\nドラッグで移動できます。");
            return;
        }

        selectedManualIndex = -1;
        editMode = null;
        renderManualSelection();

        const isStampPlacement = stampMode.checked && getLastManualStamp();
        dragStart = isStampPlacement
            ? getRawManualPoint(event)
            : (manualDrawMode?.value === "trace" ? getTraceManualPoint(event) : getManualPoint(event, true));

        if (isStampPlacement) {
            stampTapStart = { x: event.clientX, y: event.clientY };
            isDragging = false;
            const last = getLastManualStamp();
            updateSelection(
                { x: dragStart.x - last.w / 2, y: dragStart.y - last.h / 2 },
                { x: dragStart.x + last.w / 2, y: dragStart.y + last.h / 2 }
            );
            return;
        }

        isDragging = true;
        if (manualDrawMode?.value === "trace") updateTraceSelection(dragStart, dragStart);
        else updateSelection(dragStart, dragStart);
    });

    canvasWrap.addEventListener("pointermove", event => {
        if (event.pointerType === "mouse" && event.buttons === 0 && isDragging && editMode) {
            isDragging = false;
            dragStart = null;
            editMode = null;
            pointers.delete(event.pointerId);
            renderManualSelection();
            return;
        }

        if (pointers.has(event.pointerId)) {
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }

        if (pointers.size >= 2) {
            const distance = getPointerDistance();
            const center = getPointerCenter();
            if (pinchStartDistance > 0 && distance > 0) {
                setZoom(pinchStartZoom * distance / pinchStartDistance);
            }
            if (center && panLastCenter) {
                canvasWrap.scrollLeft -= center.x - panLastCenter.x;
                canvasWrap.scrollTop -= center.y - panLastCenter.y;
            }
            panLastCenter = center;
            event.preventDefault();
            return;
        }

        if (multiTouchGestureActive) {
            event.preventDefault();
            return;
        }

        if (!manualMode) return;
        event.preventDefault();

        if (editMode && selectedManualIndex >= 0 && isDragging) {
            const point = getManualPoint(event, false);
            if (!editMode.historyPushed) {
                pushManualHistory();
                editMode.historyPushed = true;
            }
            if (editMode.type === "move") applyMoveEdit(point);
            else applyResizeEdit(point);
            redrawFromBase();
            return;
        }

        if (stampMode.checked && stampTapStart && getLastManualStamp()) {
            const point = getRawManualPoint(event);
            const last = getLastManualStamp();
            updateSelection(
                { x: point.x - last.w / 2, y: point.y - last.h / 2 },
                { x: point.x + last.w / 2, y: point.y + last.h / 2 }
            );
            return;
        }

        if (!isDragging || !dragStart) return;
        const point = manualDrawMode?.value === "trace" ? getTraceManualPoint(event) : getManualPoint(event, true);
        if (manualDrawMode?.value === "trace") updateTraceSelection(dragStart, point);
        else updateSelection(dragStart, point);
    });

    function endPointer(event) {
        pointers.delete(event.pointerId);

        if (multiTouchGestureActive) {
            isDragging = false;
            dragStart = null;
            stampTapStart = null;
            editMode = null;
            selection.hidden = true;

            if (pointers.size >= 1) {
                panLastCenter = getPointerCenter();
                return;
            }

            multiTouchGestureActive = false;
            pinchStartDistance = 0;
            pinchStartZoom = state.zoom;
            panLastCenter = null;
            return;
        }

        if (pointers.size >= 1) {
            isDragging = false;
            dragStart = null;
            selection.hidden = true;
            panLastCenter = getPointerCenter();
            return;
        }

        pinchStartDistance = 0;
        panLastCenter = null;
        if (!manualMode) return;
        event.preventDefault();

        if (editMode && selectedManualIndex >= 0 && isDragging) {
            const point = getManualPoint(event, false);
            if (!editMode.historyPushed) {
                pushManualHistory();
                editMode.historyPushed = true;
            }
            if (editMode.type === "move") applyMoveEdit(point);
            else applyResizeEdit(point);
            isDragging = false;
            dragStart = null;
            editMode = null;
            redrawFromBase();
            renderManualSelection();
            return;
        }

        if (stampMode.checked && stampTapStart && getLastManualStamp()) {
            const moved = Math.hypot(event.clientX - stampTapStart.x, event.clientY - stampTapStart.y);
            const point = getRawManualPoint(event);
            stampTapStart = null;
            selection.hidden = true;
            dragStart = null;
            isDragging = false;
            if (moved < 12) placeStampAt(point);
            return;
        }

        if (!isDragging || !dragStart) return;
        isDragging = false;
        finishStamp(manualDrawMode?.value === "trace" ? getTraceManualPoint(event) : getManualPoint(event));
    }

    canvasWrap.addEventListener("pointerup", endPointer);
    canvasWrap.addEventListener("lostpointercapture", event => {
        pointers.delete(event.pointerId);

        if (event.pointerType === "touch") {
            if (!pointers.size) {
                multiTouchGestureActive = false;
                pinchStartDistance = 0;
                pinchStartZoom = state.zoom;
                panLastCenter = null;
            } else if (multiTouchGestureActive) {
                panLastCenter = getPointerCenter();
            }
            return;
        }

        if (event.pointerType !== "mouse") return;
        if (isDragging && editMode) {
            isDragging = false;
            dragStart = null;
            editMode = null;
            renderManualSelection();
        }
    });

    canvasWrap.addEventListener("dblclick", event => {
        if (!manualMode || selectedManualIndex < 0 || !manualStamps[selectedManualIndex]) return;
        const point = getRawManualPoint(event);
        if (hitTestManual(point) !== selectedManualIndex) return;
        pushManualHistory();
        manualStamps.splice(selectedManualIndex, 1);
        selectedManualIndex = -1;
        editMode = null;
        redrawFromBase();
        saveBtn.disabled = false;
        status(`選択した黒塗りを削除しました。\n残り：${manualStamps.length}箇所`);
    });

    canvasWrap.addEventListener("pointercancel", event => {
        pointers.delete(event.pointerId);
        panLastCenter = pointers.size ? getPointerCenter() : null;
        isDragging = false;
        dragStart = null;
        stampTapStart = null;
        editMode = null;
        if (!pointers.size) {
            multiTouchGestureActive = false;
            pinchStartDistance = 0;
            pinchStartZoom = state.zoom;
            panLastCenter = null;
        }
        selection.hidden = true;
        hideManualDeleteButton();
    });

    function openManualHelp() {
        if (!manualHelpDialog) return;
        manualHelpDialog.hidden = false;
        document.body.classList.add("help-dialog-open");
        manualHelpCloseBtn?.focus();
    }

    function closeManualHelp() {
        if (!manualHelpDialog || manualHelpDialog.hidden) return;
        manualHelpDialog.hidden = true;
        document.body.classList.remove("help-dialog-open");
        manualHelpBtn?.focus();
    }

    manualHelpBtn?.addEventListener("click", openManualHelp);
    manualHelpCloseBtn?.addEventListener("click", closeManualHelp);
    manualHelpDialog?.addEventListener("click", event => {
        if (event.target.closest("[data-help-close]")) closeManualHelp();
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && manualHelpDialog && !manualHelpDialog.hidden) closeManualHelp();
    });

    manualDrawMode?.addEventListener("change", () => {
        savePreferences();
        selection.hidden = true;
        hideManualDeleteButton();
        dragStart = null;
        isDragging = false;
        const label = manualDrawMode.value === "trace" ? "なぞり式（表示サイズに自動調整）" : "自由矩形";
        status(`手動の描画方法を「${label}」にしました。`);
    });

    stampMode.addEventListener("change", () => {
        if (!stampMode.checked) {
            selection.hidden = true;
            status("スタンプモードをOFFにしました。\n通常の手動黒塗りに戻ります。");
        } else if (manualStamps.length) {
            status("スタンプモードONです。\n画像をタップすると、直前の手動黒塗りと同じサイズで黒塗りします。");
        }
    });

    undoBtn.addEventListener("click", () => {
        if (!manualHistory.length) return;
        const previous = manualHistory.pop();
        restoreManualSnapshot(previous);
        status(`直前の操作を取り消しました。\n残り：${manualStamps.length}箇所`);
    });

    manualBtn.addEventListener("click", startManualMode);
    manualDoneBtn.addEventListener("click", stopManualMode);

    updateUndoButton();

    return {
        startManualMode,
        stopManualMode,
        updateUndoButton,
        renderManualSelection,
        pushManualHistory,
        resetState
    };
}
