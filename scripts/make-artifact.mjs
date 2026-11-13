// dist/ のビルド結果から claude.ai Artifact 用のページ（dist/artifact.html）を作る。
// CSS はページに埋め込み、JS は同じ場所に公開する assets/*.js を読む。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const js = html.match(/<script[^>]*src="\.\/(assets\/[^"]+\.js)"/)?.[1];
const css = html.match(/<link[^>]*href="\.\/(assets\/[^"]+\.css)"/)?.[1];
if (!js || !css) throw new Error('entry not found in dist/index.html');

const page = `<title>刺繍SVG</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${readFileSync(`dist/${css}`, 'utf8')}
</style>
<div id="root"></div>
<script type="module" src="./${js}"></script>
`;
writeFileSync('dist/artifact.html', page);
const files = readdirSync('dist/assets').filter((f) => f.endsWith('.js')).map((f) => `assets/${f}`);
console.log(JSON.stringify({ page: 'dist/artifact.html', files }, null, 2));
