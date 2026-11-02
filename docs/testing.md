# Issue #5 継続テスト

## 実行

- npm ci: lockfileの依存関係をインストール。
- npm run test:unit: ブラウザ・DB統合以外のNode試験。実Supabase用の環境変数を子プロセスから除去する。
- npm run test:browser: Playwright-core＋Chromiumで隔離したUIを試験。
- SHIORI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/shiori_test npm run test:db: 専用のローカルPostgreSQLでDDL・トランザクションを試験。変数がなければ成功扱いせず停止。
- npm test: 全テストファイル。DB変数がないとDB試験は明示的にskipされる。ゼロ件やskipをDB検証成功と扱わない。

ChromiumはCHROMIUM_PATH、システムの/usr/bin/chromium、Playwrightのロックされた実行ファイルの順に選ぶ。CIではpackage-lock.jsonに固定したPlaywright-coreのCLIで対応ChromiumとOS依存をインストールする。個別テストやヘルパーのゼロ件実行を避け、runnerが対象ファイルを明示選択し、対象なしは失敗にする。

## カバレッジ

|試験|検証内容|
|---|---|
|photo.browser|写真だけの登録・編集・再表示・画像入りJSON書き出しと復元|
|search.browser|書誌候補選択、API障害、保存前/保存後の写真と入力の保持|
|auth-flow.browser|匿名登録・パスワードログイン・ログアウト・誤パスワード、別ユーザーの本/メモ/写真が見えないこと|
|library-flow.browser|本/メモCRUD、複数書籍タグ表示、競合時の入力保持とバックアップ、DB保存後の応答喪失と再試行|
|evidence.browser|意図的な失敗でスクリーンショット・trace・consoleを保存し、元の例外を維持すること。生成物はこの自己試験内で削除|
|database.integration|空の隔離DBへの基準スキーマ初期化、増分/再適用/復旧、DB並行更新・再送・ロール権限|

外部のAuth・Storage・NDLはモック。テストの読み物・アドレス・パスワードは合成データで、実際の利用者のメモ・認証情報を使わない。既存の手動live接続スクリプトはCIから一切実行しない。実プロバイダの設定、メール到達、実端末や公開サイトの動作は、このCIの成功で保証しない。

## CIと証跡

GitHub Actionsはunit/database/browserを別ジョブにし、PRとdevelop更新で実行する。資格情報を渡さず、本番へのデプロイ処理はない。ジョブのタイムアウトを設定する。

TEST_REPORT_DIRを指定するとJUnit XMLを保存する。ブラウザ失敗時にはbrowser/<case>/failure.png、trace.zip、console.jsonを保存し、元の試験を失敗として終了する。すべてのジョブでalways()により結果を7日保持する。ローカルの生成物は.gitignore対象。スクリーンショットやtraceに入力が含まれるので、合成データの試験専用とする。

node node_modules/playwright-core/cli.js show-trace <trace.zip> で追跡できる。Nodeのテスト結果ファイルを保存しても元の終了コードは維持する。意図的な失敗自己試験が成功したことと、アプリの試験に失敗があったことは区別する。

Issue #6では使い捨てPostgreSQLに接続するブラウザ試験を追加（Auth/Storageはモック）。SHIORI_TEST_DATABASE_URL未指定時はこの試験を明示的にskipする。CIのbrowserジョブは専用PostgreSQLを起動して実行する。DB試験は1,000冊/10,000メモ、移行/復旧、権限、並行更新、容量/時間を確認。ブラウザでは1,000冊、50件のDOM表示、差分保存、応答喪失時の再送、別アカウントへの写真付き復元を確認する。
