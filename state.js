// 複数機能から共有する最小限の可変状態。
// ES modules の import binding を再代入せず、state のプロパティを更新する。
export const state = {
    sourceImage: null,
    zoom: 1
};

// 配列そのものは再代入せず、push/splice で更新するため直接共有できる。
export const manualStamps = [];
