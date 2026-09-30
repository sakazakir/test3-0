# FaBrary Draft Deck Analyzer

Flesh and Blood のドラフトデッキを分析するための静的 Web ページです。

## ファイル構成

- `index.html` — アナライザー本体（ブラウザで開くだけで動作）
- `fabary-decks.json` — 分析対象のデッキデータ
- `IAR_Draft_V1.1.txt` — ドラフト設定・カードリスト

## 使い方

`index.html` をブラウザで開いてください。

## FaBrary デッキの取り込み

Discord などに貼られたテキストから FaBrary のデッキリンクを取り出し、デッキページをスクレイピングしてメインデッキのカードを `fabary-decks.json` 形式で抽出します（サイドボードは除外）。

```
Levia, LMV
https://fabrary.net/decks/01M3QEJ4RXXNZCA5DQRSAT0W98
```

```sh
npm install                                        # Playwright (Chromium) を導入
npx playwright install chromium                    # 初回のみ
node scripts/fabrary-scrape.mjs links.txt          # 抽出結果を標準出力へ
node scripts/fabrary-scrape.mjs links.txt --merge  # fabary-decks.json に追記（同じURLはスキップ）
node scripts/fabrary-scrape.mjs links.txt --links-only  # リンク抽出だけ確認
```

- リンク直前の行（例: `Levia, LMV`）をラベルとして記録し、ヒーロー名が取れない場合の手がかりにします。
- カード名と色は `IAR_Draft_V1.1.txt` のカードプールに合わせて正規化します。プールにないカードは警告を出します。
- `npm test` でテストを実行できます。
