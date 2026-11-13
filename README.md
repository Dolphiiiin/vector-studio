# 刺繍SVG

スマホのブラウザで、写真やイラストから刺繍ミシン用の SVG を作る Web アプリ。
Brother Innovis SE3800D での利用を想定（SVG を取り込める Brother のアプリ経由）。

## できること

- 画像を読み込み、陰影を打ち消して色数を減らし、フラットなベクターイラストにする
- 布地の背景と落ち影を外周から自動で取り除く
- 色ごとに：糸色の変更、縫う／縫わない、塗り／線、余白（太らせる・細らせる）、縫い順、色の統合
- 「内側の色の下も縫う」で、目や口の下まで下地を敷く
- 色どうしの重なり幅（縫い縮みによるすき間対策）
- 刺繍枠（100×100 mm など）に合わせた mm 単位の SVG を書き出し

## 開発

```sh
npm install
npm run dev      # http://localhost:5173 （--host 付きなので同じ Wi-Fi のスマホからも開ける）
npm run build    # dist/ に静的ファイルを出力
```

画像処理はすべてブラウザ内（Web Worker）で行い、画像はどこにも送信しない。

## 構成

- `src/engine/quantize.ts` バイラテラル平滑化 → 背景の抽出 → 明度の重みを下げた Lab 空間での k-means → 多数決フィルタと小領域の吸収
- `src/engine/trace.ts` 画素境界の輪郭追跡 → Douglas–Peucker で単純化 → 角を残した Catmull-Rom 曲線化、距離変換によるオフセット
- `src/engine/build.ts` 色ごとのマスク生成（重なり・余白・下地）と SVG 出力
- UI は Adobe React Spectrum

## 公開

`main` に push すると GitHub Actions で GitHub Pages にデプロイされる（リポジトリ設定の Pages で Source を「GitHub Actions」にする）。
