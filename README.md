# Electric SQL サンプルアプリケーション

Electric SQLを使ったリアルタイム同期Todoアプリのデモです。

## 概要

このアプリケーションは、Electric SQLのQuickstartガイドに基づいて作成されています。
PostgreSQLデータベースとReactアプリがリアルタイムで同期し、データベースの変更が即座にUIに反映されます。

## 技術スタック

- **Electric SQL**: PostgreSQLのリアルタイム同期
- **React**: UIフレームワーク
- **TypeScript**: 型安全な開発
- **Vite**: 高速ビルドツール
- **PostgreSQL**: データベース
- **Docker**: コンテナ化

## セットアップ

### 1. Dockerコンテナの起動

```bash
docker compose up -d
```

これにより以下のサービスが起動します：
- PostgreSQL (ポート: 54321)
- Electric SQL Sync Service (ポート: 3000)

### 2. データベースの状態確認

```bash
# データベースに接続
docker exec -it electric_quickstart-postgres-1 psql -U postgres -d electric

# テーブルを確認
\dt

# データを確認
SELECT * FROM todos;
```

### 3. Reactアプリの起動

```bash
cd todo-app
pnpm run dev
```

ブラウザで `http://localhost:5173` を開きます。

## Electric SQLの主要機能

### useShape フック

`@electric-sql/react` パッケージの `useShape` フックを使用してデータを同期します：

```typescript
const { data } = useShape({
  url: `http://localhost:3000/v1/shape`,
  params: {
    table: `todos`,
  },
})
```

このフックは：
- データベースからデータを取得
- リアルタイムで変更を監視
- 変更があると自動的にUIを更新

## リアルタイム同期のデモ

以下のコマンドでデータベースを直接操作すると、ブラウザのUIがリアルタイムで更新されます：

### 新しいTodoを追加

```bash
docker exec electric_quickstart-postgres-1 psql -U postgres -d electric -c \
  "INSERT INTO todos (task, completed) VALUES ('新しいタスク', false);"
```

### Todoを完了にする

```bash
docker exec electric_quickstart-postgres-1 psql -U postgres -d electric -c \
  "UPDATE todos SET completed = true WHERE id = 1;"
```

### Todoを削除

```bash
docker exec electric_quickstart-postgres-1 psql -U postgres -d electric -c \
  "DELETE FROM todos WHERE id = 1;"
```

## プロジェクト構成

```
electric-react-todo-app/
├── docker-compose.yaml       # Docker設定
├── todo-app/                 # Reactアプリケーション
│   ├── src/
│   │   ├── App.tsx          # メインコンポーネント
│   │   └── App.css          # スタイル
│   └── package.json
└── README.md
```

## 停止方法

```bash
# Dockerコンテナを停止
docker compose down

# Reactアプリを停止
Ctrl + C
```

## 学習ポイント

1. **リアルタイム同期**: データベースの変更が即座にUIに反映
2. **シンプルなAPI**: `useShape`フックだけでリアルタイムデータを扱える
3. **型安全性**: TypeScriptで型定義されたデータ
4. **スケーラビリティ**: PostgreSQLの堅牢性とElectricの効率性

## 参考リンク

- [Electric SQL公式ドキュメント](https://electric-sql.com/docs)
- [Electric SQL Quickstart](https://electric-sql.com/docs/quickstart)
- [Electric SQL GitHub](https://github.com/electric-sql/electric)
