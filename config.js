// 共有設定値。機能ファイル側にマジックナンバーを散らさない。
export const ENABLE_DIAGNOSTIC = true;

export const CONFIG = Object.freeze({
  bbox: Object.freeze({
    shortNameHeightWidthRatio: 1.18,
    shortNameMedianWidthRatio: 1.22,
    shortNameExpectedWidthRatio: 1.02,
    shortNameConsistentMedianRatio: 1.05,
    shortNameSymbolConsistencyMaxRatio: 1.35,
    shortNameMinReasonableRatio: 0.88,
    shortNameMaxReasonableRatio: 1.30,
    shortNameGapSkipShrinkRatio: 0.15,
    shortNameExpandLeftShare: 0.70,
    shortNameExpandLeftPadding: 2
  }),
  near: Object.freeze({
    minSimilarity: 0.50
  }),
  italic: Object.freeze({
    minScore: 0.62,
    minForeground: 0.47,
    minBackground: 0.93
  })
});
