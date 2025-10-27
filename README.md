# 在庫管理PWA（GitHub Pages + GAS + Sheets）

GitHub Pages で公開するプレーンHTML/CSS/JSの在庫管理PWAです。データはGoogleスプレッドシート（Items / Settings / StockLog）に置き、Google Apps Script(GAS)をWeb APIとして利用します。

## セットアップ（3手順）

1) Google Apps Script をデプロイ
- `Code.gs` を新しいGASプロジェクトに貼り付け（または置換）し、スプレッドシートを紐付けて保存。
- メニュー「デプロイ」→「新しいデプロイ」→「種類：ウェブアプリ」→ 実行者を自分、アクセスを全員（匿名含む or 自分のGoogleアカウント）で公開。
- 公開後のURL（`https://script.google.com/macros/s/…/exec`）を控える。
- 必要なら「installDaily」を実行して、毎朝8:00のトリガーを作成（すでに作成済みなら不要）。

2) フロントの環境URL設定
- リポジトリ直下の `env.js` を開き、`GAS_API_BASE` に上記のWebアプリURLを設定。

3) GitHub Pages で公開
- リポジトリのSettings → Pages でブランチ（`main` など）とルート(`/`)を指定して有効化。
- 公開URLにアクセスして、`/items` 取得や在庫更新（±/直入力）を確認。

## 動作確認チェックリスト
- GET `/items` がJSONで返る（ブラウザのNetworkで確認）。
- 在庫の ± / 直入力が保存され、一覧が再描画される。
- 不足タブに `在庫 < 下限` のみ出る。件数がバッジに反映。
- 「今すぐ自動減算（テスト）」で在庫が減り、`ALERT_EMAIL_TO` が設定されていればメールが届く。
- 夏シーズンは `夏は自動減算オフ=TRUE` のアイテムが減算されない。
- ソロエルURL未設定なら検索リンクが開く。
- Android/Chromeはアイコンバッジ（対応環境）。

## 構成
- `index.html` / `style.css` / `app.js` / `env.js` / `manifest.webmanifest` / `sw.js`
- GAS: `Code.gs`

PWAは簡易なオフライン（Cache First）に対応。Apps ScriptのAPIはWebアプリとして `doGet` / `doPost` を公開し、JSONを返します。

