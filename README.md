# V91.14 文字間ギャップ保護テスト

V91.13 をベースに、短名の shrink-right 誤発動だけを抑える最小変更テストです。

- V91.13 の黒塗り幅安定化ロジックは維持
- word-split ではない実symbolを左から並べ、隣接symbol間の最大gapを確認
- 最大gapが paintBox.h × 0.15 を超える場合は shrink-right をスキップ
- expand-left、通常padding、OCR検出、局所OCR、イタリック探索、手動編集は変更なし
- 診断ではスキップ時に `短名幅正常化:shrink-skip-gap` と表示できます

確認ポイント：ネルの先頭が隠れるか、真緒・伊織の右食い込み修正が維持されるか。
