# 栞 — わたしの本棚

公開HTMLを回収し、Node.jsサーバーを再実装した復旧版です。元サーバーのソースを復元したものではありません。

## 開発と起動

Node.js 24.5以降で `npm start`。追加パッケージは不要です。既定のlocalモードは127.0.0.1:3000だけにバインドし、単一ユーザーのデータを `.data/library.json` に保存します。公開しないでください。テストは `npm test`。

`npm start` は環境に設定されたHTTP(S)プロキシとCA設定を使います。キーやプロキシプレースホルダーをファイルに書き出さないでください。

## 公開環境

RenderのGitHubブランチは `codex/restore-shiori`。Build Commandは `npm install`、Start Commandは `npm start`。

環境変数:

- NODE_VERSION=24.19.0
- STORAGE_MODE=supabase
- SUPABASE_URL=https://uuvdwdrmdzkxclohhihj.supabase.co
- SUPABASE_PUBLIC_KEY: Supabase Publishable key
- SUPABASE_SECRET_KEY: Supabase Secret key（サーバー専用。HTMLに配信しません）
- COOKIE_SECURE=true

`db/schema.sql` は提供されたSQLの保管用コピーです。既に初期化済みのDBには再実行しないでください。既存のshiori_gateway RPCとrootsテーブルで、認証済みユーザーID別に本棚スナップショットを保存します。既存のbooks/notesへの正規化や大規模データのページ分割は未実装です。

## ログイン

Supabaseの標準メールテンプレートをそのまま使用でき、数字のコードのためのテンプレート編集は不要です。ただし標準メール配信は本番向けではありません。公式資料上、現在はプロジェクト全体で1時間に2通が上限で、組織メンバー以外への送信も制限されます。継続利用にはカスタムSMTPなどの配信設定が必要です。アプリの変更ではこの送信枠を増やせません。

SupabaseのAuthentication → URL Configuration:

- Site URL: `https://book-s-marker.onrender.com/`
- Redirect URLs: `https://book-s-marker.onrender.com/**`

1. アプリでメールアドレスを入力し「ログインメールを送る」。
2. 最新メールのリンクを開く。
3. アプリに表示されたメールアドレスを確認し「このアカウントでログイン」。

ログインを始めた端末とメールを開いた端末が異なっても、リンクを開いた側のブラウザで確認・ログインを完了できます。送信元端末のCookieを必要としません。リンクのトークンはURLから消去後、Supabaseで検証し、明示的なアカウント確認後にHttpOnly Cookieを作ります。確認のCookieは受信側ブラウザで発行し、特定のトークンにひも付けます。他のトークン、異なるstate、未確認のログイン要求は拒否します。

Cookieが保存されない場合は再送画面に黙って戻さず、Cookieを許可する必要がある旨を表示します。セッション失効時は再ログインが必要です。

## 検証

`npm test` はローカル永続化、更新競合、認証境界、新しいブラウザでのメールリンク確認、キャンセル、不正トークン、コード検証APIなどを確認します。

Supabase接続と書き込みは `node --use-env-proxy scripts/check-supabase.mjs --write-check` で検証できます。一時所有者の本棚を作成し、読み戻し・更新後に削除します。監査履歴は残ります。キーの値は出力しません。

実Supabaseの管理APIでメール送信なしの一時テストユーザーと標準メールリンクを生成し、検証用リンクを開いたときのリダイレクトから、ブラウザ側ヘルパー、サーバー側の確認処理、認証後のアカウント取得まで成功しました。送信元Cookieなしで検証し、テストユーザーは削除済みです。コード入力によるログインと認証後の本棚保存・読み戻しも検証済みです。利用者の実端末からのメール受信・画面操作は別途確認が必要です。

## 残る制限

書誌自動取得のAPIは未実装で未一致を返します。写真OCRは回収したブラウザ側の外部ライブラリに依存し、未検証です。旧ChatGPTログインはSupabaseメール認証へ変更しています。

DBに意図的に古いversionを送るとSQLSTATE 40001応答がタイムアウトする問題が、この接続経路でNodeとcurlの両方に再現しました。通常保存は書き込み前にrevisionを確認して409を返しますが、複数サーバーから同時更新した際のDB競合応答は未解決です。タイムアウト時は自動再送せず、再読み込みして保存状況を確認してください。

## メール送信制限の診断

公式資料とSupabase Authの実装を確認しました。同じ `over_email_send_rate_limit` コードが、配信枠の上限と同じユーザーへの短時間再送の両方に使われます。エラーコードだけでプロジェクトの時間上限と断定しません。

- 本文が `email rate limit exceeded` の場合は、メール配信枠の制限として表示。
- `after N seconds` の再送間隔エラーは、その待ち秒数を反映。
- Retry-Afterが提供された場合は、整数秒またはHTTP日時から待ち時間を取得。
- 不明な429は不明のまま表示し、60秒で解除されるとは案内しません。
- 429で再試行時刻が分からないときは送信ボタンを停止し、繰り返しの送信を促しません。自動再送は行いません。

過去のAPI応答はエラー種別を破棄していたため、利用者が遭遇した当該429の詳細は遡って確定できません。プロジェクトの実設定・履歴には別途管理画面での確認が必要です。修正検証ではメールを送らず、配信枠・再送間隔・IP制限・詳細不明の429とRetry-Afterをモックで検証しました。

参照: https://supabase.com/docs/guides/auth/rate-limits と https://supabase.com/docs/guides/auth/auth-smtp 。確認時の公式共有設定 https://github.com/supabase/supabase/blob/master/packages/shared-data/config.ts では `auth.rate_limits.email.inbuilt_smtp_per_hour.value` は2です。これは既定値で、プロジェクトの現在値を直接取得したものではありません。
