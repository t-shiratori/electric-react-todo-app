import { useShape } from '@electric-sql/react'
import './App.css'

interface Todo {
  id: number
  task: string
  completed: boolean
  created_at: string
}

function App() {
  const { data } = useShape({
    url: `http://localhost:3000/v1/shape`,
    params: {
      table: `todos`,
    },
  })

  const todos = (data ?? []) as unknown as Todo[]

  return (
    <div className="app">
      <h1>Electric SQL Todo App</h1>
      <div className="todo-container">
        <h2>タスク一覧</h2>
        {todos.length === 0 ? (
          <p>タスクがありません</p>
        ) : (
          <ul className="todo-list">
            {todos.map((todo) => (
              <li key={todo.id} className={todo.completed ? 'completed' : ''}>
                <span className="task">{todo.task}</span>
                <span className="status">
                  {todo.completed ? '✅ 完了' : '⏳ 未完了'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="info">
        <h3>リアルタイム同期を試す</h3>
        <p>以下のコマンドでデータベースを直接更新すると、画面がリアルタイムで更新されます：</p>
        <pre>
          docker exec electric_quickstart-postgres-1 psql -U postgres -d electric -c
          "INSERT INTO todos (task, completed) VALUES ('新しいタスク', false);"
        </pre>
        <pre>
          docker exec electric_quickstart-postgres-1 psql -U postgres -d electric -c
          "UPDATE todos SET completed = true WHERE id = 1;"
        </pre>
      </div>
    </div>
  )
}

export default App
