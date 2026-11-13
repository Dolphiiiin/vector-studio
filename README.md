# 刺繍SVG

スマホのブラウザで、写真やイラストから刺繍ミシン用の SVG を作る Web アプリ。
Brother Innovis SE3800D での利用を想定（SVG を取り込める Brother のアプリ経由）。

## できること

- 画像を読み込み、陰影を打ち消して色数を減らし、フラットなベクターイラストにする
- 布地の背景と落ち影を外周から自動で取り除く
- 色ごとに：糸色の変更、縫う／縫わない、塗り／線、余白（太らせる・細らせる）、縫い順、色の統合
- 重ね縫い前提：下の色は上に乗る色の下まで広がり、囲んだ穴も埋まる（見える輪郭は上の色のふちだけ）
- 島ごとに「いちばん単純で十分に合う図形」を自動で当てはめる（長方形→角丸長方形→楕円→頂点の少ない多角形→曲線）。色ごとに「自動／四角／直線／曲線」で固定もできる
- 多角形は辺ごとの直線の交点を角にしてシャープに。同じ大きさの四角（両目など）はサイズと高さをそろえる
- claude.ai の Artifact として開くと「おまかせで整える」：閲覧者自身の Claude で、影の除外・色のまとめ・形・縫い順を判断
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
- `src/engine/trace.ts` 画素境界の輪郭追跡、距離変換によるオフセット
- `src/engine/shapes.ts` 図形候補の当てはめと採点（XOR 面積÷周長、最大のずれ）、四角のそろえ
- `src/engine/fit.ts` 曲線用：角の検出 → 辺ごとの平滑化 → 直線判定／Schneider 法のベジェ当てはめ → 水平・垂直スナップ、四角化
- `src/engine/build.ts` 色ごとのマスク生成（重なり・余白・下地）と SVG 出力
- UI は Adobe React Spectrum

## 公開

`main` に push すると GitHub Actions で GitHub Pages にデプロイされる（リポジトリ設定の Pages で Source を「GitHub Actions」にする）。

## claude.ai Artifact として公開

```sh
npm run build:artifact   # dist/artifact.html と assets/*.js
```
`dist/artifact.html` をページ、`dist/assets/*.js` を同じパスのファイルとして公開し、
capabilities に `{"sample": {"images": true}, "downloads": true}` を宣言する。
