# 書籍・メモ単位の保存と安全な移行（Issue #6）

## 状態と互換性

`LIBRARY_STORAGE=records` は Supabase 用の段階導入機能。既定値 `snapshot` は従来の利用方法を維持する。ローカル開発はファイルCASを継続し、records指定時には起動を拒否する。SQL、フラグ変更、公開ブランチへの取り込み、Render再配置は**本番承認待ち**。developへの統合だけでは公開環境は変わらない。

001の原子的スナップショット保存を先に導入する。002は新しい `record_state/books/notes/requests` を追加する増分SQLで、歴史的 `db/schema.sql` や既存 `books/notes` テーブルを再利用・上書きしない。DDLのみでは利用者を移行しない。空の新規本棚だけはrecords APIの初回利用時に初期化する。既存本棚は明示的な利用者単位の移行が必要で、未移行なら503となる。

## モデル・更新・検索

- 書籍は `(owner,id)`、メモは `(owner,book_id,id)`。各data JSONBに既存の任意項目を保持し、書籍dataからnotesだけを分離する。ID、タグの文字列、リンク、写真URL、順序を保持する。
- record_stateの単調増加revisionを変更した行のversionに使用。削除・再作成しても古いversionを再利用しない。メモ変更は親のnotes_versionも進め、読み込んでいないメモを古い書籍削除で消さない。
- ユーザー単位のDBトランザクションロック＋対象行version条件で更新。異なる書籍・メモの更新はそれぞれ成功し、同じ対象の古い版は409。一括差分の途中で競合・検証エラーがあれば全変更を戻す。
- Idempotency-KeyとJSONB正規形のハッシュで成功した要求の再送を検知。記録する結果は対象ID・版等で、メモ本文を要求ログへ重複保存しない。同じキーの内容変更は409。保存結果が不明でも同じキー/同じ差分で再試行する。自動マージや無条件上書きをしない。
- FORCE RLS、認証したUIDをサーバーからのみ指定。anon/authenticatedにはテーブル・RPC権限なし。service_roleは公開RPCのみ、移行/復旧関数には権限なし。新しい記録も既存の所有者別監査履歴へ追加される。
- 自由記述タグは**完全一致・大小文字区別あり**。既存文字列を勝手に正規化しない。1つのタグについて書籍タグまたはそのメモタグの一致を横断表示する。複数タグのAND/OR・別名統合は未追加。
- `/api/notes?q=` は日本語を含む部分一致。タグのGIN索引と将来の全文検索用 `to_tsvector('simple',text)` 索引を用意。現在の部分一致は全文索引を使わない。日本語形態素検索やランキングは今後の設計課題。
- pgvectorは未導入。将来はowner/book_id/note_id/content_versionを持つ別索引テーブルにし、本文の版が変わった埋め込みを検索から除外する。外部AI送信・埋め込み生成・課金・同意UIは追加していない。明示的同意の設計と承認が先に必要。

## API

全て認証必須。ownerをURLや本文から指定できない。一覧はIDカーソルで最大200件。`revision`を指定したページ読み出し中に更新があれば409となる。

| 操作 | エンドポイント | 本文/応答 |
|---|---|---|
| 書籍一覧/単体取得 | GET /api/books、/api/books/:id | itemsにdata/version/notes_version/position、revision、hasMore |
| 書籍作成 | POST /api/books | `{data:{id,title,author,date,summary,tags,...}}`（notesを含めない） |
| 書籍更新/削除 | PUT/DELETE /api/books/:id | `{version,data}` / `{version,notesVersion}` |
| メモ一覧/単体取得 | GET /api/notes、/api/books/:book/notes、/api/books/:book/notes/:id | itemsにbook_id/data/version/position |
| メモ作成 | POST /api/books/:book/notes | `{data:{id,text,tags,...}}` |
| メモ更新/削除 | PUT/DELETE /api/books/:book/notes/:id | `{version,data}` / `{version}` |
| 差分一括保存 | POST /api/changes | `{operations:[{kind:'book'または'note',action:'put'または'delete',id,bookId?,version,data?,notesVersion?}]}` |
| 件数・論理容量 | GET /api/library/usage | books、notes、logicalBytes、revision |

一覧条件は `limit/after/afterBook/revision/tag/q`。書籍のqは書名・著者、メモのqは本文。書籍タグ検索はメモタグも含む。一覧や単体GETは他人の記録を返さず、見つからない単体は404。更新成功200、形式不正400、競合409、移行待ち503。個別POSTの版は0、PUT/DELETEは取得済みの版が必要。差分は最大20,000件・HTTP本文8MBまで。同一対象の二重指定は禁止。

records動作時の旧 `/api/library` GET/PUTは410。さらに移行済み利用者のroots書き込みをDBトリガーで409にするため、旧サーバー/古い画面からの上書きも拒否する。001/旧gatewayの上書きが新データへ混入するフォールバックはない。

## UIの互換アダプターと現時点の制限

`public/records.js` は最初の表示時に書籍・メモをページ取得し、同じrevisionの読み出しであることを最後にも確認する。途中の更新時は最初から最大3回読み直す。現在のUI/検索/携帯バックアップとの互換性のため、**初回は全メモをブラウザメモリに展開する**。本棚・全メモ一覧のDOMは50件ずつ表示する。個別編集では変更した書籍またはメモだけを送信し、本棚全体のPUTを行わない。バックアップ復元も追加対象だけを一括トランザクションで作成する。

これは1,000冊規模を検証した実装であり、無制限のメモや写真付き巨大バックアップの保証ではない。8MB超のバックアップのチャンク復元、検索結果のサーバーページングに合わせたUI、メモの遅延読み込みは次の改善候補。更新のリアルタイム配信はなく、他端末の変更を表示するには再読み込みが必要。古い記録を編集すると409になり、入力とバックアップを保持する。

## 本番導入手順（実行には承認が必要）

1. 承認済みの対象・停止時間・復旧担当を決める。DB/Storage双方をバックアップし、別の隔離環境へ復元して件数・ID・メモ・タグ・写真取得を確認する。対象ごとのroots版・件数を記録する。実在ユーザーの内容をCIやリポジトリに保存しない。
2. 同じスキーマ所有者/管理者で001、次に002を適用する。PostgreSQL16の非スーパーユーザー再適用をテスト済み。根テーブル/新テーブル/公開関数の所有者、ロールADMINとSETの一時付与が可能であることが前提。不足なら権限設計を確認し、迂回しない。SQLはトランザクション・5秒lock_timeoutで失敗時に戻る。失敗したSQL EditorセッションはROLLBACKしてから再開する。
3. 本番同等の隔離コピーで各対象を移行して差分比較する。管理者専用関数 `SELECT shiori_private.records_admin('対象UID','migrate');` を使用。重複ID・不正データは**中止し、その利用者の変更を全部戻す**。無断修正や重複の間引きはしない。source_data/source_revisionを保持する。再実行はalready_activeで追加変更しない。
4. 本番書き込みを止める。承認された利用者を移行し、新サーバーを `LIBRARY_STORAGE=records` で切り替える。未移行利用者は503になるので、全員切り替える公開サービスでは全対象の移行完了を確認する。全画面を再読み込みして書籍/メモ/タグ/写真/復元を確認してから書き込みを再開する。UIDやAuth方針は変更しない。
5. 件数・409/503・応答時間・DB/画像容量を監視する。元rootsとsource_dataは確認期間後も承認なしに削除しない。履歴/要求ログの保持期間と削除承認、定期バックアップと復元訓練を運用で決める。要求IDを消すと応答喪失後の重複検知保証が失われるため、保持期限なしで無断清掃しない。

## 復旧手順（既存記録を優先）

1. 書き込みを停止し、移行元と新テーブル、履歴、Storageを再バックアップする。元rootsをそのまま戻すと移行後の記録が失われるため、それだけで復旧しない。
2. 管理者が各active所有者に `SELECT shiori_private.records_admin('対象UID','rollback');` を実行。DBロック内で現在の書籍とメモを旧JSONへ再構築し、元rootの追加項目と統合する。source_dataと新テーブルは残し、rootsの版を進める。失敗時はその利用者の処理全体を戻す。
3. 全activeが解除されたことを確認後 `db/rollback/002_record_storage.sql` を実行して公開records RPCを停止する。このファイルはデータを削除せず、activeが残れば拒否する。全所有者を確認できるBYPASSRLS管理権限が必要で、FORCE RLSで見えない行を「activeなし」と誤認しないよう権限不足時にも失敗させる。`LIBRARY_STORAGE=snapshot`、`SNAPSHOT_WRITE_MODE=atomic` に戻し、全画面を再読み込みして検証後に再開する。
4. ロールバック後に旧方式で更新した利用者の再移行は自動で許可しない。旧source/新record/現在rootsの三者を比較し、別途承認した再移行計画を作る。保持した記録を無断でDROP/上書きしない。002のDDL再適用だけで利用者が再移行されることはない。

## 検証の範囲

専用PostgreSQL16で移行・再適用・非super管理者・競合10並行・別対象の並行成功・途中失敗の全取消・古いメモを含む削除拒否・ABA防止・応答喪失の別サーバー再送・権限分離・復旧を試験。1,000冊/10,000メモ（合成データ）の容量/時間と、非対象行のxmin/元roots不変を検証する。Chromiumでは実PostgreSQL＋Auth/Storageモックで1,000冊、写真・タグ・別利用者へのバックアップ復元と分離を検証する。実測値はJUnit/実行ログのdiagnosticへ残す。CIのブラウザジョブにも専用DBを用意する。

本番Supabase・実メール・Render・実際の端末間通信・Supabase管理者権限の差は未試験。ローカルとCIの性能測定は本番回線・無料プランの性能保証ではない。
