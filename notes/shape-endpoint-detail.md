# Electric SQL `/v1/shape` エンドポイント詳細解説

## 概要

`http://localhost:3000/v1/shape` は、Electric SQL Sync Serviceが提供するHTTP APIエンドポイントで、PostgreSQLデータベースからリアルタイムでデータを同期するための主要なインターフェースです。

## エンドポイントの提供元

このエンドポイントは、Docker Composeで起動した**Electric Sync Service**コンテナが提供しています。

```yaml
# docker-compose.yaml
electric:
  image: electricsql/electric:latest
  environment:
    DATABASE_URL: postgresql://postgres:password@postgres:5432/electric
  ports:
    - '3000:3000'  # このポートでHTTP APIを公開
```

Electric Sync Serviceは以下の役割を持つ専用サーバーです：
- PostgreSQLのWAL (Write-Ahead Log)を監視
- 変更を「Shape Log」という形式で管理
- HTTP APIでクライアントに変更を配信

## Shapeとは？

**Shape**は、Electric SQLにおける「同期するデータの定義」です。データベース全体ではなく、特定のテーブルや条件に合致するデータだけを同期します。

Shape定義の要素：
1. **テーブル**: 同期対象のPostgreSQLテーブル（例: `todos`）
2. **Where句** (オプション): 行をフィルタリングする条件
3. **Columns** (オプション): 同期する列の指定

## API リクエストパラメータ

### 初期同期リクエスト

```bash
GET http://localhost:3000/v1/shape?table=todos&offset=-1
```

**パラメータ:**
- `table=todos`: 同期するテーブル名
- `offset=-1`: 履歴全体を最初から取得（初回リクエスト用）
- `offset=now`: 履歴をスキップして現在時点から開始

### ライブモード（リアルタイム更新）リクエスト

```bash
GET http://localhost:3000/v1/shape?table=todos&offset=0_0&live=true&handle=121961818-1763863444724882
```

**パラメータ:**
- `table=todos`: テーブル名
- `offset=0_0`: 現在のログ位置
- `live=true`: ライブモードを有効化（長時間ポーリング）
- `handle=121961818-1763863444724882`: Shape識別子（サーバーが発行）

**その他のパラメータ:**
- `where`: SQLフィルタ条件（例: `where=completed=true`）
- `columns`: 取得する列を限定（例: `columns=id,task`）
- `live_sse=true`: Server-Sent Events (SSE) を使用（長時間ポーリングより効率的）

## レスポンス形式

### レスポンスヘッダー

実際のレスポンスヘッダー例：

```http
HTTP/1.1 200 OK
electric-handle: 121961818-1763863444724882
electric-schema: {"completed":{"type":"bool"},"created_at":{"type":"timestamp"},...}
electric-offset: 0_0
electric-server: ElectricSQL/1.2.6
content-type: application/json; charset=utf-8
cache-control: public, max-age=604800
```

**重要なヘッダー:**
- `electric-handle`: このShapeの一意識別子（次のリクエストで使用）
- `electric-offset`: 現在のログ位置（次のリクエストで使用）
- `electric-schema`: テーブルスキーマ情報（型情報を含む）
- `electric-server`: Electric SQLのバージョン情報

### レスポンスボディ (Shape Log)

```json
[
  {
    "key": "\"public\".\"todos\"/\"1\"",
    "value": {
      "completed": "false",
      "created_at": "2025-11-23 01:15:20.405262",
      "id": "1",
      "task": "Learn Electric SQL"
    },
    "headers": {
      "relation": ["public", "todos"],
      "operation": "insert"
    }
  },
  {
    "key": "\"public\".\"todos\"/\"2\"",
    "value": {
      "completed": "false",
      "created_at": "2025-11-23 01:15:20.405262",
      "id": "2",
      "task": "Build a todo app"
    },
    "headers": {
      "relation": ["public", "todos"],
      "operation": "insert"
    }
  },
  {
    "headers": {
      "control": "snapshot-end",
      "xmin": "749",
      "xmax": "749",
      "xip_list": []
    }
  }
]
```

### Shape Logエントリーの構造

#### 1. データ操作メッセージ

```json
{
  "key": "\"public\".\"todos\"/\"1\"",     // 行の一意識別子
  "value": {                                // 行のデータ
    "id": "1",
    "task": "Learn Electric SQL",
    "completed": "false"
  },
  "headers": {
    "relation": ["public", "todos"],       // スキーマとテーブル名
    "operation": "insert"                   // 操作タイプ: insert, update, delete
  }
}
```

**operation の種類:**
- `insert`: 新しい行が挿入された
- `update`: 既存の行が更新された
- `delete`: 行が削除された（valueは空またはnull）

#### 2. 制御メッセージ

```json
{
  "headers": {
    "control": "snapshot-end",  // 制御メッセージタイプ
    "xmin": "749",               // PostgreSQLトランザクションID
    "xmax": "749",
    "xip_list": []
  }
}
```

**controlの種類:**
- `snapshot-end`: 初期スナップショットの終了
- `up-to-date`: 現在のデータに追いついた（ライブモードへ移行可能）
- `must-refetch`: クライアントは再同期が必要

## リアルタイム同期の仕組み（2フェーズプロトコル）

### Phase 1: 初期同期 (Initial Sync)

```
クライアント                Electric Service              PostgreSQL
    |                             |                            |
    |-- GET /v1/shape?offset=-1 ->|                            |
    |                             |-- データベーススナップショット -->|
    |                             |<-- 現在のデータ全件 ---------|
    |<-- Shape Log (全データ) ----|                            |
    |    + electric-handle        |                            |
    |    + electric-offset        |                            |
```

1. クライアントが `offset=-1` でリクエスト
2. Electric Serviceがデータベースから現在のデータを取得
3. Shape Log形式（insert操作の配列）で返却
4. レスポンスヘッダーに `handle` と `offset` が含まれる
5. 最後に `snapshot-end` 制御メッセージ

### Phase 2: ライブモード (Live Mode)

```
クライアント                Electric Service              PostgreSQL
    |                             |                            |
    |-- GET /v1/shape?live=true ->|                            |
    |    + offset=0_0             |                            |
    |    + handle=xxx             |                            |
    |                             |                            |
    |         (接続を保持)         |<-- WALストリーム監視 ------|
    |                             |                            |
    |                             |      [データ変更発生]      |
    |                             |<-- WALイベント ------------|
    |<-- 変更データ返却 -----------|                            |
    |    + 新しいoffset           |                            |
    |                             |                            |
    |-- 次のliveリクエスト ------->|                            |
```

**長時間ポーリング (Long Polling) の動作:**

1. クライアントが `live=true` でリクエスト
2. **サーバーは接続を保持したまま待機**
3. 新しいデータが到着するまで応答しない
4. 以下のいずれかで応答：
   - **新データ到着**: 変更をShape Log形式で返却
   - **タイムアウト**: `up-to-date` 制御メッセージで返却
5. クライアントは即座に次のliveリクエストを送信（ループ）

**実際の例:**

```bash
# このコマンドは新しいデータが来るまで待機し続ける
curl "http://localhost:3000/v1/shape?table=todos&live=true&offset=0_0&handle=xxx"

# 別のターミナルでデータを追加すると...
docker exec postgres psql -c "INSERT INTO todos (task) VALUES ('新タスク');"

# ...上のcurlが即座にレスポンスを返す
[{"key":"\"public\".\"todos\"/\"4\"","value":{...},"headers":{"operation":"insert"}}]
```

### Server-Sent Events (SSE) モード

長時間ポーリングの代替として、より効率的なSSEも利用可能：

```bash
GET http://localhost:3000/v1/shape?table=todos&live_sse=true&offset=0_0&handle=xxx
```

**SSEの利点:**
- HTTPリクエスト数が少ない（1つの接続で複数のイベント）
- レイテンシが低い
- ブラウザのEventSource APIで簡単に実装可能

## offsetとhandleの役割

### offset (ログ位置)

Shape Logは「論理データベース操作のログ」として管理されています。offsetはこのログ内の位置を示します。

```
offset=-1    : ログの最初から（全履歴取得）
offset=0_0   : 特定のログ位置
offset=5_3   : 5番目のトランザクションの3番目の操作
offset=now   : 現在時点から（履歴スキップ）
```

**フォーマット:** `<transaction_id>_<operation_index>`

クライアントは前回のレスポンスで受け取った `electric-offset` ヘッダーの値を次のリクエストで使用します。

### handle (Shape識別子)

`handle` は特定のShapeインスタンスを識別する一意のIDです。

```
handle: 121961818-1763863444724882
         ^^^^^^^^^ ^^^^^^^^^^^^^^^
         Shape ID  タイムスタンプ
```

**役割:**
- サーバー側でShapeの状態を管理
- 複数のクライアントが同じShapeを共有可能
- キャッシュとして機能（同じhandleなら再計算不要）

## useShapeフックの内部動作

[App.tsx:12-17](todo-app/src/App.tsx#L12-L17) の `useShape` は、上記のHTTP APIを使用しています：

```typescript
const { data } = useShape({
  url: `http://localhost:3000/v1/shape`,
  params: {
    table: `todos`,
  },
})
```

**内部的な処理フロー:**

1. **初期化時:**
   ```
   GET /v1/shape?table=todos&offset=-1
   ```
   - データベースの現在のスナップショットを取得
   - handleとoffsetを保存

2. **データ受信時:**
   - Shape Logエントリーを解析
   - insert/update/delete操作をローカルデータに適用
   - Reactの状態を更新（再レンダリング発生）

3. **ライブモード移行:**
   ```
   GET /v1/shape?table=todos&live=true&offset=<前回のoffset>&handle=<前回のhandle>
   ```
   - 長時間ポーリングで接続を維持
   - 新しいデータが来たら即座に反映

4. **ループ:**
   - レスポンス受信後、即座に次のliveリクエスト
   - 常に最新データを監視

## 実際の動作確認

### 1. 初期データ取得

```bash
curl "http://localhost:3000/v1/shape?table=todos&offset=-1"
```

**レスポンス:**
- 全todosのinsert操作配列
- `electric-handle` と `electric-offset` ヘッダー
- 最後に `snapshot-end` 制御メッセージ

### 2. ライブモード（別ターミナルで実行）

```bash
curl "http://localhost:3000/v1/shape?table=todos&offset=0_0&live=true&handle=<上で取得したhandle>"
```

このコマンドは待機状態になります。

### 3. データ変更（さらに別のターミナル）

```bash
docker exec electric_quickstart-postgres-1 psql -U postgres -d electric -c \
  "INSERT INTO todos (task, completed) VALUES ('リアルタイムテスト', false);"
```

### 4. 結果

ステップ2のcurlが即座にレスポンスを返します：

```json
[
  {
    "key": "\"public\".\"todos\"/\"4\"",
    "value": {
      "id": "4",
      "task": "リアルタイムテスト",
      "completed": "false"
    },
    "headers": {
      "relation": ["public", "todos"],
      "operation": "insert"
    }
  }
]
```

## セキュリティとキャッシング

### キャッシュ制御

レスポンスヘッダーに含まれるキャッシュ設定：

```http
cache-control: public, max-age=604800, s-maxage=3600, stale-while-revalidate=2629746
etag: "121961818-1763863444724882:-1:0_0"
```

- CDNやプロキシでキャッシュ可能
- 同じoffsetへのリクエストは高速に応答
- stale-while-revalidateで古いデータも利用可能

### 認証・認可

本番環境では `ELECTRIC_INSECURE: true` を削除し、適切な認証を設定：

```yaml
environment:
  DATABASE_URL: postgresql://...
  AUTH_MODE: secure  # JWTトークンなど
```

公式ドキュメント: [Auth Guide](https://electric-sql.com/docs/guides/auth)

## アーキテクチャ全体図

```
┌─────────────────────────────────────────────────────────────┐
│                    React App (Browser)                      │
│                                                              │
│  useShape フック                                             │
│    ↓                                                         │
│  1. GET /v1/shape?offset=-1        (初期同期)               │
│  2. GET /v1/shape?live=true        (ライブモード)           │
│    ↓                                                         │
│  データ自動更新 → 再レンダリング                             │
└─────────────────────────────────────────────────────────────┘
                            ↓ HTTP/WebSocket
┌─────────────────────────────────────────────────────────────┐
│          Electric Sync Service (Port 3000)                  │
│                                                              │
│  /v1/shape API エンドポイント                                │
│    ↓                                                         │
│  - Shape定義の管理                                           │
│  - Shape Log の生成・配信                                    │
│  - WALイベントの変換                                         │
│  - 長時間ポーリング/SSE                                      │
│  - キャッシュ管理                                            │
└─────────────────────────────────────────────────────────────┘
                            ↓ PostgreSQL Protocol
┌─────────────────────────────────────────────────────────────┐
│          PostgreSQL (Port 54321)                            │
│                                                              │
│  wal_level=logical                                           │
│    ↓                                                         │
│  WAL (Write-Ahead Log)                                       │
│    ↓                                                         │
│  論理レプリケーションストリーム                               │
│    ↓                                                         │
│  INSERT/UPDATE/DELETE イベント                               │
└─────────────────────────────────────────────────────────────┘
```

## まとめ

`/v1/shape` エンドポイントは：

1. **Electric Sync Serviceが提供**: Dockerコンテナで起動したサーバー
2. **Shape Log形式でデータを配信**: 論理データベース操作のログ
3. **2フェーズプロトコル**: 初期同期 → ライブモード
4. **長時間ポーリング**: 接続を保持して変更を待機
5. **offsetとhandle**: ログ位置とShape識別に使用
6. **PostgreSQL WAL連携**: 変更を確実にキャプチャ

このシンプルなHTTP APIにより、複雑なリアルタイム同期ロジックがクライアント側から抽象化され、`useShape`フック1つで利用できるようになっています。

## 参考リンク

- [Electric SQL HTTP API](https://electric-sql.com/docs/api/http)
- [Shapes Guide](https://electric-sql.com/docs/guides/shapes)
- [React Integration](https://electric-sql.com/docs/integrations/react)
- [Electric SQL GitHub](https://github.com/electric-sql/electric)
