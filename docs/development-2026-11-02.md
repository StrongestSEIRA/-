# 2026-11-02 開発・検証記録

## 結果と適用範囲

既存develop c1a0e1bを基準に、#3→#4→#5→#6の順で独立ブランチ/PRを作り、各CI成功・差分レビュー後のdevelopを次の基準にした。最後に#3のverified設定整合性を追加レビューした。公開用codex/restore-shioriへのpush、Renderデプロイ、既存DBへのSQL、実ユーザー変更、実メール、認証設定変更、秘密情報の更新は行っていない。歴史的schemaは使い捨て空テストDBの初期化にだけ使用した。

| Issue | 完了した実装・検証 | 未完了/承認待ち |
|---|---|---|
| #3 | 脅威モデル、登録方針の選択、現パスワード再認証、OTP証明/refresh/CSRF/転送元の対策、ユーザー/写真分離。verifiedはproviderの確認設定が不明/自動確認なら登録を停止 | 所有確認なしの本番方針自体は維持。既存利用者の所有再確認・assuranceワークフローは設計のみで未実装。隔離Supabaseでの実Auth検証と本番方針承認が必要 |
| #4 | ローカル/DBの原子的CAS、要求ID再送、409、入力/退避保持、10並行・別サーバー・応答喪失の試験 | 本番SQL001/atomic切替/配備は承認待ち。legacy本番経路は切り替えるまで制限が残る |
| #5 | Chromium、unit/db/browser CI、CRUD・写真・検索・バックアップ・認証・分離・競合、失敗証跡の自己試験 | 本番・実端末の試験は未実施。外部API/Auth/Storageはモック |
| #6 | 独立書籍/メモAPI、差分UI、タグ横断/メモ検索、移行元保持/旧書き込み拒否/最新データ復旧、1,000冊/10,000メモの容量・性能 | 本番移行/records切替/配備は承認待ち。初回全メモのメモリ読込、差分8MB/20,000件を超えるチャンク復元、運用上の保持方針は改善余地 |

## PRとCI

| PR | 主な変更 | 確認済みCI |
|---|---|---|
| [#7](https://github.com/StrongestSEIRA/-/pull/7) | #3認証対策 | [41375748341](https://github.com/StrongestSEIRA/-/actions/runs/41375748341) 成功、develop e1dc1d6へ統合 |
| [#8](https://github.com/StrongestSEIRA/-/pull/8) | #4原子的保存 | [41377499953](https://github.com/StrongestSEIRA/-/actions/runs/41377499953) unit/database成功、develop 8cf4161へ統合 |
| [#9](https://github.com/StrongestSEIRA/-/pull/9) | #5継続ブラウザ試験 | [41379036923](https://github.com/StrongestSEIRA/-/actions/runs/41379036923) 全3ジョブ成功、develop cca8769へ統合 |
| [#10](https://github.com/StrongestSEIRA/-/pull/10) | #6独立保存/移行/復旧 | [41380921507](https://github.com/StrongestSEIRA/-/actions/runs/41380921507) 全3ジョブ成功、develop 6144c61へ統合 |

#3の追加整合性チェックとこの記録は `issue/3-verified-policy-guard` のPRで追跡する。最新のマージ状況/CIはそのPRのChecksとdevelopのActionsを参照。CIに本番キーやデプロイ処理はない。レビューは実装差分の自己レビューであり、独立した第三者によるセキュリティ監査ではない。

## 実施した試験

ローカルNode v24.19.0、Chromium 154.0.8037.57、使い捨てPostgreSQL16.15。CIはNode24、PostgreSQL16、ロック済みPlaywrightに対応するChromiumをインストールする。

- `npm run test:unit`: 最新38件成功。
- `SHIORI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/shiori_test npm run test:db`: 6件成功。テスト用loopback/専用名ガードあり。
- 同じ専用DBを指定した `npm run test:browser`: 6件成功（うち1件は実PostgreSQL＋Auth/Storageモック）。
- 最終一括: `SHIORI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/shiori_test TEST_REPORT_DIR=test-results/final npm test` は50件成功、fail/skip/cancel 0。約15.4秒。
- `git diff --check`、変更したJSの構文検査、差分の秘密情報/意図しない本番操作の検査。

並行更新は同一版への10要求で1件成功・9件競合、独立記録は両方成功。トランザクション途中の競合で先行変更も戻る。削除・再作成後に古いversionを再利用できない。未読の新メモがある古い書籍削除も拒否。DBコミット後に応答が失われても他サーバーで同じ要求を再送して一度だけ適用。移行とロールバックの再適用/権限不足も検証した。

ブラウザは書籍/メモのCRUD、写真保持・単独登録、候補検索と外部障害、写真付きバックアップ/復元、タグ横断、認証エラー、ログアウト、別アカウントからの書籍/メモ/写真アクセス拒否、競合入力の書き出し、応答喪失後の再試行を確認。意図的なテスト例外でもスクリーンショット/trace/consoleが保存され、元の失敗理由が隠れないことも試験した。

### 容量・時間の一測定

最終一括実行時の合成1,000冊/10,000メモ: 元JSON1,328,011 bytes、レコード本文1,413,000 bytes、試験DBのshiori_privateテーブル総容量9,125,888 bytes（索引・履歴等を含む）。移行1,207ms、書籍全ページ26ms、3種類の検索37ms、一冊更新7ms。非対象行のxminと元rootsが変わらないことを照合した。ブラウザの1,000冊/1,000メモ初回表示486ms、DOM50冊。

これは同時試験実行中のローカル一測定で、本番SLAではない。1,000枚の写真の転送/保存や巨大バックアップのメモリ消費、無料プラン/回線の性能、長期履歴増加は未測定。

## 主要変更ファイル

| 範囲 | ファイルと役割 |
|---|---|
| 認証 | auth-security.mjs、registration.mjs、server.mjs、public/index.html、test/auth-security.test.mjs、test/password.test.mjs |
| 競合/移行 | local-library.mjs、db/migrations/001_atomic_library.sql、db/rollback/001_atomic_library.sql、test/concurrency.test.mjs、test/database.integration.test.mjs |
| 独立保存 | records-api.mjs、public/records.js、db/migrations/002_record_storage.sql、db/rollback/002_record_storage.sql、test/records-client.test.mjs、test/records.integration.test.mjs、test/records.browser.test.mjs |
| ブラウザ | testing/browser.mjs、testing/fake-supabase.mjs、test/auth-flow.browser.test.mjs、test/library-flow.browser.test.mjs、test/evidence.browser.test.mjs、test/photo.browser.test.mjs、test/search.browser.test.mjs |
| 実行基盤 | .github/workflows/node-unit-tests.yml、scripts/run-tests.mjs、testing/database.mjs、package.json、package-lock.json、.gitignore |
| 文書 | AGENTS.md、README.md、SPEC.md、TASKS.md、docs/security-review.md、docs/storage-migration.md、docs/record-storage.md、docs/testing.md、この記録 |

## 本番反映と次の作業

承認が必要な操作を実行せず、次の順序を推奨する。

1. [認証レビュー](security-review.md)の所有確認/未確認アカウント回復方針を決め、隔離SupabaseでAMR/パスワード変更/実メールを検証する。既存UIDや記録を削除・統合しない。所有確認移行ワークフローの実装が先に必要。過去画像で露出した秘密キーは現状未照合、更新には別途承認が必要。
2. DB/Storageの承認済みバックアップと隔離復元を実施し、[001導入手順](storage-migration.md)でatomicへ移行する。
3. [002導入手順](record-storage.md)で対象全員を検証・移行し、recordsへ切り替える。問題時は移行後の記録を旧JSONへ復旧する。旧元JSONだけの復元は行わない。
4. ログ/要求ID/履歴の保持、孤立写真、容量監視、定期バックアップ・復元訓練を運用課題化する。削除処理は勝手に追加しない。
5. メモ遅延読込/サーバー検索ページング/大きい復元の分割を進める。日本語全文検索/pgvectorの評価はその後。外部AIへの個人メモ送信には、明示的同意の設計と承認が必要。

発行済みJWTの即時失効・マルチサーバーの登録試行制限・プロバイダ障害・本番権限差は残る。利用者への本番反映案内や承認は、この記録のCI成功だけでは代替できない。
