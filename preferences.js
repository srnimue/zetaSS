export function createPreferences({
    targetText,
    targetHistory,
    redactionMode,
    redactionColor,
    manualDrawMode
}) {
    const SETTINGS_STORAGE_KEY = "zetaSS.settings.v87";
    const TARGET_HISTORY_STORAGE_KEY = "zetaSS.targetHistory.v87";
    const MAX_TARGET_HISTORY = 5;

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

    return {
        updateRedactionStyleUI,
        savePreferences,
        loadPreferences,
        saveTargetHistoryEntry,
        renderTargetHistory
    };
}
