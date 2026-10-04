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


## 食材タブ（需要予測・POS実売連携）

食材14品目（ヨーグルト・甘味ベース・果物・チーズ・カップ・スプーン等）は、`gojiemon/woodberrys-demand-forecast` の朝バッチが**POSの実売から消費を引いて**在庫と「今夜発注」を計算している。このタブはその結果を見て、棚卸し・入荷・発注をボタンで記録する画面（LINE返信「在庫 いちご 8」の代わり）。

```
朝6:15 予測バッチ ──判定結果──▶ GAS(/food/snapshot) ──▶ アプリ「食材」タブ
アプリのボタン ──▶ GAS(/food/event, 合言葉) ──▶ woodberrys-ec POST /api/ordering/stock ──▶ 翌朝の計算へ
```

### 設定（1回だけ）
1. GAS「プロジェクトの設定」→ スクリプトプロパティに追加
   - `FOOD_PIN` … 記録用の合言葉（アプリで最初に1回だけ聞かれる）
   - `ZAIKO_SNAPSHOT_SECRET` … 適当な長い文字列（2.と同じ値）
   - `ORDERING_API_URL` … `https://<ECのドメイン>/api/ordering/stock`
   - `ORDERING_API_TOKEN` … 予測バッチと同じ読み取り用トークン
   - `ORDERING_WRITE_TOKEN` … 新しく作る書き込み用トークン（EC側 Vercel env と同じ値）
2. woodberrys-demand-forecast の Actions secrets に `ZAIKO_GAS_URL`（GASのexec URL）/ `ZAIKO_SNAPSHOT_SECRET` / `ZAIKO_APP_URL`（このアプリのURL）
3. woodberrys-ec の Vercel env に `ORDERING_WRITE_TOKEN`
4. GASを「新しいバージョン」で再デプロイ

## 消耗品の減り方をアスクルの実績から出す

消耗品は「買った量 ≒ 使った量」なので、直近1年の**マルシェ宛て**アスクル発送メール（本店宛ては数えない。届け先の住所 吉祥寺本町1-20-14 で判定）（【アスクル】商品発送のお知らせ）の数量 ÷ 日数を、その品目の1日あたりの減り方にする。紐付けた品目は毎朝の自動減算でこれを使い（季節・土日の係数は掛けない）、紐付けていない品目は従来どおり「基本日次量×季節×土日」。

1. GASエディタで `refreshAskulRates` を実行（初回はGmailの読み取り許可を求められる）→ シート「AskulHistory」ができる
2. AskulHistory の「在庫管理の商品名」をプルダウンで選び、「換算」に *アスクル1個＝在庫の単位でいくつ* を入れる（例: エンボス手袋100枚入×在庫が枚 → 100）
3. もう一度 `refreshAskulRates` → Items に「アスクル日次量」列が入る
4. `installAskulWeekly` を1回実行 → 以後は毎週月曜7時に自動更新

注意: アスクル以外（Amazon・シモジマ・eカップ・まいばすけっと等）で買った分は入らない。その品目は紐付けずに従来の基本日次量のままにする。

## ⚠ GASを差し替える前に
本番のスプレッドシートのログ（StockLog の種別が「自動減算(mid)」）を見ると、今動いているGASはこのリポジトリの `Code.gs` と少し違う。貼り替える前に、今のコードを別ファイルに控えておくこと。

## カップはPOSの実売で減らす（マルシェ）

フロヨの S・M は全部ロゴカップ、ダブル(W)は大きいカップを使う（田川さん 2026-10-04）。そこで毎朝の自動減算で、前日までのマルシェのPOS実売の個数をそのまま在庫から引く。

- 対象: Items の「POS連動」列に `S・M` か `W` を入れた品目。列が無ければ商品名 `Sカップ`（または `ロゴカップ`）→ S・M、`Wカップ` → W
- 実売は woodberrys-ec の在庫API（`?store=marche`）から。GASのスクリプトプロパティ `ORDERING_API_URL` / `ORDERING_API_TOKEN` が必要（食材タブと同じ）
- どの営業日まで引いたかを `POS_CUPS_LAST_DAY` に記録。トリガーが止まった日があっても、次の実行でまとめて引く
- 実売が取れない日はカップだけ減らさず（基本量で減らすと翌日と二重になる）、アラートメールの先頭で知らせる
