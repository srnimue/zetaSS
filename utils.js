export function normalize(text) {
    return String(text || "")
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu, "")
        .toLowerCase();
}

export function getMedian(values) {
    const a = (values || []).filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function editDistance(a, b) {
    const A = [...a], B = [...b];
    const d = Array.from({ length: A.length + 1 }, () => Array(B.length + 1).fill(0));
    for (let i = 0; i <= A.length; i++) d[i][0] = i;
    for (let j = 0; j <= B.length; j++) d[0][j] = j;
    for (let i = 1; i <= A.length; i++) {
        for (let j = 1; j <= B.length; j++) {
            d[i][j] = Math.min(
                d[i - 1][j] + 1,
                d[i][j - 1] + 1,
                d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)
            );
        }
    }
    return d[A.length][B.length];
}
