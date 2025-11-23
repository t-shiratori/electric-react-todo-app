# Electric SQLの仕組み

## 📋 アーキテクチャ概要

Electric SQLは、PostgreSQLデータベースとクライアントアプリケーション間でリアルタイムデータ同期を実現するシステムです。主に3つのコンポーネントで構成されています：

### 1. **PostgreSQL (データベース層)**
- WAL (Write-Ahead Logging)が`logical`モードで設定(docker-compose.yaml:19)
- データベースの変更履歴をキャプチャできるようになっています
- ポート54321で稼働

### 2. **Electric Sync Service (同期サーバー)**
- PostgreSQLの変更を監視し、クライアントに配信
- ポート3000でHTTP APIを提供
- データベースのWALを読み取り、変更イベントをストリーミング
- docker-compose.yaml:26-37で設定

### 3. **Reactアプリケーション (クライアント層)**
- `useShape`フックでデータを購読(todo-app/src/App.tsx:12-17)
- 変更を自動的に受信してUIを更新

## 🔄 データフローの仕組み

```
PostgreSQL → WAL → Electric Sync Service → HTTP/WebSocket → React App
   (DB)              (変更検知)      (配信)              (自動更新)
```

### ステップバイステップ:

1. **データベース変更の検知**
   - PostgreSQLでINSERT/UPDATE/DELETEが発生
   - WAL(Write-Ahead Log)に変更が記録される
   - `wal_level=logical`により論理レプリケーション情報が含まれる

2. **Electric Sync Serviceによる変更の配信**
   - Electric ServiceがPostgreSQLのWALストリームを購読
   - テーブルごとの変更を「Shape」として管理
   - HTTP APIエンドポイント(`/v1/shape`)で変更を配信

3. **クライアントでの受信と反映**
   - `useShape`フックがElectric Serviceに接続
   - 初期データの取得とリアルタイム更新の購読を同時に実行
   - データが変更されると自動的にReactコンポーネントが再レンダリング

## 🎯 useShapeフックの動作

todo-app/src/App.tsx:12-17のコードを見てみましょう：

```typescript
const { data } = useShape({
  url: `http://localhost:3000/v1/shape`,
  params: {
    table: `todos`,
  },
})
```

このフックは内部的に以下を行います：

1. **初期データの取得** - HTTP GETで現在のテーブルデータを取得
2. **変更の購読** - WebSocketまたはロングポーリングで変更を監視
3. **自動マージ** - 変更イベントを受信すると、ローカルの`data`を自動更新
4. **再レンダリング** - Reactの状態管理により、UIが自動的に更新

## 🔑 主要な特徴

### 1. **Shapeベースの同期**
- テーブル全体や特定のクエリ結果を「Shape」として定義
- クライアントは必要なShapeだけを購読
- 効率的なデータ転送が可能

### 2. **PostgreSQLの論理レプリケーション活用**
- WAL(Write-Ahead Log)を使用した変更検知
- データベースレベルでの確実な変更キャプチャ
- トランザクションの一貫性を保証

### 3. **シンプルなAPI**
- `useShape`フック1つでリアルタイム同期が可能
- 複雑なWebSocket管理やキャッシュ戦略が不要
- TypeScriptで型安全に利用可能

### 4. **オフライン対応の可能性**
- 変更イベントのストリーミングにより、オフライン時の変更を後で同期可能
- (このサンプルでは実装されていませんが、Electric SQLの機能として提供)

## 🚀 実際の動作確認

データベースを直接更新すると、Reactアプリが即座に反映されます：

```bash
# 新しいタスクを追加
docker exec electric_quickstart-postgres-1 psql -U postgres -d electric -c \
  "INSERT INTO todos (task, completed) VALUES ('新しいタスク', false);"
```

この時、以下が起こります：
1. PostgreSQLにデータが挿入される
2. WALに変更が記録される
3. Electric Serviceが変更を検知
4. 購読中のクライアント（ブラウザ）に通知
5. `useShape`が`data`を更新
6. Reactが自動的に再レンダリング
7. UIに新しいタスクが表示される

## 💡 従来のアプローチとの違い

| 従来の方法 | Electric SQL |
|----------|-------------|
| 定期的なポーリング | リアルタイムプッシュ |
| 手動でのキャッシュ管理 | 自動同期 |
| REST APIの繰り返し呼び出し | 効率的なストリーミング |
| クライアント側での状態管理が複雑 | `useShape`だけでシンプルに |

## 🏗️ プロジェクト構成

### Docker環境 (docker-compose.yaml)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: electric
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - '54321:5432'
    command:
      - -c
      - wal_level=logical  # 重要: 論理レプリケーションを有効化

  electric:
    image: electricsql/electric:latest
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres:5432/electric
      ELECTRIC_INSECURE: true  # 開発環境用
    ports:
      - '3000:3000'
```

### Reactアプリケーション構成

```
todo-app/
├── src/
│   ├── App.tsx          # useShapeを使用したメインコンポーネント
│   ├── main.tsx         # エントリーポイント
│   └── index.css        # スタイル
└── package.json         # @electric-sql/reactが依存関係に含まれる
```

## 📦 必要なパッケージ

```json
{
  "dependencies": {
    "@electric-sql/react": "^1.0.20",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  }
}
```

## 🔧 セットアップと起動

### 1. Dockerコンテナの起動

```bash
docker compose up -d
```

これにより以下が起動します：
- PostgreSQL (ポート: 54321)
- Electric SQL Sync Service (ポート: 3000)

### 2. Reactアプリの起動

```bash
cd todo-app
pnpm install
pnpm run dev
```

ブラウザで `http://localhost:5173` を開きます。

### 3. データベースの確認

```bash
# データベースに接続
docker exec -it electric_quickstart-postgres-1 psql -U postgres -d electric

# テーブルを確認
\dt

# データを確認
SELECT * FROM todos;
```

## 🎓 学習ポイント

1. **リアルタイム同期**: データベースの変更が即座にUIに反映される
2. **シンプルなAPI**: `useShape`フックだけでリアルタイムデータを扱える
3. **型安全性**: TypeScriptで型定義されたデータを扱える
4. **スケーラビリティ**: PostgreSQLの堅牢性とElectricの効率性を両立
5. **PostgreSQLネイティブ**: 既存のPostgreSQLインフラを活用できる

## 🔗 参考リンク

- [Electric SQL公式ドキュメント](https://electric-sql.com/docs)
- [Electric SQL Quickstart](https://electric-sql.com/docs/quickstart)
- [Electric SQL GitHub](https://github.com/electric-sql/electric)

---

Electric SQLは、PostgreSQLの強力な機能を活用しながら、リアルタイムアプリケーションを簡単に構築できる仕組みを提供しています。
