# ElectricSQLの内部アーキテクチャと動作原理

## 概要

ElectricSQLの内部的な動作と技術的なアーキテクチャについての専門的な解説です。

## 1. 全体アーキテクチャ

ElectricSQLは3層のアーキテクチャで構成されています：

```
┌─────────────────────────────────────────┐
│    Client Layer (React App)            │
│  - @electric-sql/react (useShape)      │
│  - @electric-sql/client (ShapeStream)  │
└────────────┬────────────────────────────┘
             │ HTTP/SSE
             │ (Server-Sent Events)
┌────────────▼────────────────────────────┐
│  Electric Sync Service                  │
│  - WAL Reader                           │
│  - Shape Manager                        │
│  - HTTP API (/v1/shape)                 │
└────────────┬────────────────────────────┘
             │ Logical Replication
             │ Protocol
┌────────────▼────────────────────────────┐
│  PostgreSQL Database                    │
│  - wal_level=logical                    │
│  - Replication Slot                     │
│  - Publication/Subscription             │
└─────────────────────────────────────────┘
```

## 2. PostgreSQLのWAL (Write-Ahead Logging) 活用

### WALの設定

docker-compose.yaml:19では`wal_level=logical`が設定されています：

```yaml
command:
  - -c
  - wal_level=logical
```

### `wal_level=logical`の意味

- **通常のWAL**: 物理的なデータブロックの変更を記録（クラッシュリカバリ用）
- **論理WAL**: テーブルレベルの論理的な変更（INSERT/UPDATE/DELETE）を記録
- 論理レプリケーションにより、「どのテーブルのどの行がどう変更されたか」が取得可能

### 内部メカニズム

1. トランザクションがコミットされる前に、WALバッファに変更が書き込まれる
2. WALには各変更の**LSN (Log Sequence Number)** が付与される
3. レプリケーションスロットを通じて、外部システム（Electric）がWALストリームを購読
4. PostgreSQLは購読者がまだ読んでいないWALを自動的に保持

## 3. Electric Sync Serviceの内部動作

### Shape概念

**Shape**は「特定のテーブルまたはクエリ結果のスナップショット + リアルタイム更新ストリーム」を表す抽象概念です。

内部的には：
- **Shape Handle**: 各Shapeに一意のIDを割り当て
- **Offset**: ストリーム内の位置を示すカーソル（LSN相当）
- **Snapshot Metadata**: トランザクションの可視性情報（PostgreSQL Snapshot）

### HTTP API仕様

todo-app/src/App.tsx:12-17で使用されている`/v1/shape`エンドポイント：

```typescript
const { data } = useShape({
  url: `http://localhost:3000/v1/shape`,
  params: {
    table: `todos`,
  },
})
```

### APIプロトコル

#### 1. 初回リクエスト（スナップショット取得）

```http
GET /v1/shape?table=todos&live=true
```

レスポンスヘッダー：
- `electric-handle`: Shape固有のID
- `electric-offset`: 現在のストリーム位置
- `electric-schema`: テーブルスキーマ情報（カラム型など）
- `electric-up-to-date`: 初期データ送信完了フラグ

レスポンスボディ（NDJSON形式）：
```json
{"headers":{"operation":"insert"},"offset":"0","key":"1","value":{"id":1,"task":"タスク1","completed":false}}
{"headers":{"operation":"insert"},"offset":"1","key":"2","value":{"id":2,"task":"タスク2","completed":true}}
{"headers":{"control":"up-to-date"}}
```

#### 2. ライブアップデート（SSE）

接続を維持して、変更を継続的に受信：
```json
{"headers":{"operation":"update"},"offset":"2","key":"1","value":{"id":1,"completed":true}}
{"headers":{"operation":"delete"},"offset":"3","key":"2"}
```

#### 3. 再接続時（offset指定）

```http
GET /v1/shape?table=todos&offset=2&handle=abc123
```
オフセット以降の変更のみを取得（帯域幅節約）

## 4. クライアント側の実装詳細

### @electric-sql/clientの内部構造

主要なコンポーネント：

#### ShapeStream クラス

**役割**: HTTP/SSEコネクションの管理、メッセージパース

**主要メソッド**:
- `subscribe(callback)`: メッセージ受信時のコールバック登録
- `isLoading()`: 初期スナップショット取得中かチェック
- `lastSyncedAt()`: 最終同期時刻（Unixタイムスタンプ）
- `forceDisconnectAndRefresh()`: 強制再接続

**内部実装のポイント**：
```typescript
// ストリームキャッシング（同じURLへの複数購読を効率化）
const getShapeStream = (options) => {
  const canonicalUrl = computeCanonicalUrl(options)
  if (streamCache.has(canonicalUrl)) {
    return streamCache.get(canonicalUrl)
  }
  const stream = new ShapeStream(options)
  streamCache.set(canonicalUrl, stream)
  return stream
}
```

#### Shape クラス

**役割**: データのマテリアライズドビュー（メモリ上のテーブルコピー）

**主要プロパティ**:
- `currentRows`: Map<主キー, Row> - 現在のデータ
- `rows`: Promise<Row[]> - 初期データ取得完了時に解決
- `isUpToDate`: 同期完了フラグ
- `lastOffset`: 最終処理済みオフセット

**データマテリアライゼーション**：
```typescript
class Shape<T> {
  private currentRows = new Map<string, T>()

  // ShapeStreamからのメッセージ処理
  private handleMessage(message: Message<T>) {
    if (message.headers.operation === 'insert') {
      this.currentRows.set(message.key, message.value)
    } else if (message.headers.operation === 'update') {
      this.currentRows.set(message.key, message.value)
    } else if (message.headers.operation === 'delete') {
      this.currentRows.delete(message.key)
    }
    this.notifySubscribers()
  }
}
```

### useShapeフックの実装

**Reactとの統合**：
```typescript
// @electric-sql/react内部
export function useShape<T>(options: UseShapeOptions) {
  // useSyncExternalStoreWithSelectorでReactの状態同期
  const data = useSyncExternalStoreWithSelector(
    // subscribe: Shapeの変更を購読
    (callback) => {
      const shape = getShape(options)
      return shape.subscribe(callback)
    },
    // getSnapshot: 現在のデータを取得
    () => {
      const shape = getShape(options)
      return shape.currentRows
    },
    // selector: データを配列に変換
    (rows) => Array.from(rows.values())
  )

  return { data, isLoading, error, ... }
}
```

**`useSyncExternalStoreWithSelector`の利点**：
- Reactの並行レンダリング（Concurrent Rendering）に対応
- 外部ストア（Shape）の変更を検知して自動再レンダリング
- tearing（画面の一部だけ古いデータが表示される問題）を防止

## 5. メッセージフォーマットと型システム

### ChangeMessage

```typescript
type ChangeMessage<T> = {
  headers: {
    operation: 'insert' | 'update' | 'delete'
  }
  offset: Offset  // ストリーム位置
  key: string     // 主キー
  value: T        // 行データ（deleteの場合はnull）
}
```

### ControlMessage

```typescript
type ControlMessage = {
  headers: {
    control: 'up-to-date' | 'must-refetch'
  }
}
```

- `up-to-date`: 初期スナップショット完了 / ストリームが最新に追いついた
- `must-refetch`: Shapeが無効化され、再フェッチが必要（スキーマ変更など）

## 6. トランザクションの一貫性保証

### PostgreSQL Snapshot

ElectricはPostgreSQLの**スナップショット分離**を活用：

```typescript
type PostgresSnapshot = {
  xmin: string  // 最小トランザクションID
  xmax: string  // 最大トランザクションID
  xip: string[] // 進行中のトランザクションID
}
```

### 動作原理

1. クライアントが接続時、Electric Serviceは現在のPostgreSQLスナップショットを取得
2. 初期データはこのスナップショット時点で一貫したデータ
3. その後のWAL変更は順序通りに配信される
4. クライアント側では変更を順次適用して一貫性を維持

## 7. エラーハンドリングとリトライ戦略

### バックオフアルゴリズム

`fetch.ts`にバックオフロジックが実装されています：

```typescript
// 擬似コード
async function fetchWithBackoff(url, options, attempt = 0) {
  try {
    return await fetch(url, options)
  } catch (error) {
    if (isRetriable(error) && attempt < MAX_RETRIES) {
      const delay = Math.min(
        INITIAL_BACKOFF * Math.pow(2, attempt),
        MAX_BACKOFF
      )
      await sleep(delay)
      return fetchWithBackoff(url, options, attempt + 1)
    }
    throw error
  }
}
```

### カスタムエラータイプ

```typescript
class FetchError extends Error {
  status?: number
  url: string
}

class MissingShapeUrlError extends Error {}
```

## 8. パフォーマンス最適化

### 多層キャッシング戦略

#### 1. ShapeStreamキャッシュ
- 同じURL（table + where条件など）への複数のuseShapeフック呼び出しで、ShapeStream接続を共有
- ネットワーク帯域幅とサーバー負荷を削減

#### 2. Shapeインスタンスキャッシュ
- 各ShapeStreamに対して、複数のShapeインスタンスが異なるセレクタで購読可能
- メモリ効率化

#### 3. オプションハッシング

```typescript
// オプションの正規化とハッシュ化
function computeCanonicalUrl(options: ShapeOptions): string {
  const { table, where, columns, limit, offset, orderBy } = options
  const params = new URLSearchParams()
  if (table) params.set('table', table)
  if (where) params.set('where', where)
  // ... 他のパラメータ
  return `${baseUrl}?${params.toString()}`
}
```

### 差分更新（Delta Updates）

- 全テーブルデータを再送信せず、変更分（INSERT/UPDATE/DELETE）のみ送信
- 初回スナップショット後は、数バイト〜数KB程度のメッセージで同期

## 9. 高度な機能

### サブセットクエリ

以下のクエリパラメータをサポート：

```typescript
// WHERE句でフィルタリング
useShape({
  url: 'http://localhost:3000/v1/shape',
  params: {
    table: 'todos',
    where: 'completed = true',  // 完了済みタスクのみ
  }
})

// リミットとオフセット
params: {
  table: 'todos',
  subset__limit: '10',
  subset__offset: '0',
  subset__order_by: 'created_at DESC'
}
```

### リクエストスナップショット

```typescript
// 特定条件のデータを一時的に取得
const snapshot = await shape.fetchSnapshot({
  where: 'id = 123'
})
```

## 10. セキュリティ考慮事項

docker-compose.yaml:32で`ELECTRIC_INSECURE: true`が設定されていますが、これは**開発専用**です：

```yaml
ELECTRIC_INSECURE: true
# Not suitable for production. Only use insecure mode in development
```

### 本番環境では

- 認証トークンの実装（JWT等）
- TLS/SSL暗号化
- Rate limiting
- WHERE句インジェクション対策

## 11. スケーラビリティ設計

### 水平スケーリング

- Electric Sync Serviceはステートレス（状態はPostgreSQLにのみ保持）
- 複数のElectricインスタンスを負荷分散可能
- 各インスタンスがPostgreSQLから独立してWALを読み取る

### PostgreSQLレプリケーションスロット管理

- Electric ServiceはPostgreSQLにレプリケーションスロットを作成
- WALの自動保持により、一時的なネットワーク切断でもデータ損失なし
- スロット管理により、不要なWALの自動クリーンアップ

## 12. 主要なファイルとコンポーネント

### @electric-sql/client パッケージ構成

- `client.ts` (45KB) - Core ShapeStream and client logic
- `shape.ts` - Shape class and data materialization
- `types.ts` - Type definitions and schemas
- `parser.ts` - Message parsing from stream
- `fetch.ts` - HTTP fetching with backoff
- `helpers.ts` - Utility functions for message inspection
- `error.ts` - Custom error types
- `constants.ts` - Protocol constants and headers
- `snapshot-tracker.ts` - Snapshot metadata tracking

### プロトコル定数

**ヘッダー**:
- `electric-cursor`
- `electric-handle`
- `electric-offset`
- `electric-schema`
- `electric-up-to-date`

**クエリパラメータ**:
- `table`, `live`, `offset`, `handle`
- `where`, `params`
- `subset__where`, `subset__limit`, `subset__offset`, `subset__order_by`

## まとめ

### ElectricSQLの技術的な強み

1. **PostgreSQLネイティブ**: 既存のPostgreSQLインフラをそのまま活用
2. **論理レプリケーション**: 確実な変更キャプチャとトランザクション一貫性
3. **効率的なプロトコル**: HTTP/SSEベースで差分更新
4. **React統合**: `useSyncExternalStore`による最適なReact統合
5. **型安全**: TypeScriptファーストの設計
6. **シンプルなAPI**: 複雑な実装を隠蔽したuseShapeフック

このアーキテクチャにより、開発者はリアルタイム同期の複雑さを意識せず、通常のReactコンポーネントを書く感覚でリアルタイムアプリケーションを構築できます。

## 参考リンク

- [Electric SQL公式ドキュメント](https://electric-sql.com/docs)
- [Electric SQL Quickstart](https://electric-sql.com/docs/quickstart)
- [Electric SQL GitHub](https://github.com/electric-sql/electric)
