# スクショ黒塗りツール V61

V56をベースに、Tesseract.jsの通常モデル（4.0.0_best_int）ではなく、元の `tessdata_best` を使用して認識精度を比較する実験版です。

- Tesseract.js v5 / OEM 1（LSTM）
- jpn の `4.0.0_best` を langPath から読み込み
- V56のOCR処理、bbox補正、手動黒塗り、ズーム、Undo等は維持
- `app.js?v=61` にして古いJavaScriptキャッシュを避ける

注意：tessdata_bestは通常版より学習データが大きく、速度・メモリ使用量が増える可能性があります。まず「実行中」で止まらずモデル準備が完了するかを確認する実験です。
