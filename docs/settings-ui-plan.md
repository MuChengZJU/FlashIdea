# 配置界面实现计划

## 目标

让用户在 app 内配置飞书凭据（App ID、App Secret、Wiki Node Token），不依赖 `.env` 文件。Android 和桌面都能用。

## 存储方案

用已有的 SQLite `settings` 表。Android 上 SQLite 在 app 私有目录，其他 app 无法访问。

存储 key：
- `feishu_app_id`
- `feishu_app_secret`
- `feishu_wiki_node_token`

优先级：环境变量 > SQLite 设置。桌面开发时 `.env` 仍然生效，Android 上用 SQLite。

## 后端改动

### 1. AppState 改造（src-tauri/src/commands.rs + lib.rs）

`feishu_client` 需要运行时可替换（用户保存新凭据后重建 client）：

```rust
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub feishu_client: Arc<RwLock<Arc<FeishuClient>>>,  // 改用 RwLock 包裹
    pub doc_id: Arc<RwLock<String>>,                     // doc_id 也可能变
    pub wiki: Arc<RwLock<Option<Arc<WikiConfig>>>>,      // 改用 RwLock
}
```

注意：把 `wiki` 的 `Mutex` 换成 `RwLock`（tokio 的），和 `feishu_client` 保持一致。`db` 保持 `Mutex`（rusqlite 不是 Send+Sync 适合 Mutex）。

### 2. 启动流程修改（src-tauri/src/lib.rs）

```
启动 → 加载 .env → 读 env vars
       ↓
  env vars 有值？ ──是──→ 用 env vars 创建 FeishuClient
       ↓ 否
  SQLite settings 有值？ ──是──→ 用 settings 创建 FeishuClient
       ↓ 否
  创建空 FeishuClient（app_id="" app_secret=""）→ 前端检测到未配置，显示设置页
```

抽一个辅助函数：

```rust
fn load_credentials(conn: &Connection) -> (String, String, Option<String>) {
    let app_id = env::var("FEISHU_APP_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| db::get_setting(conn, "feishu_app_id").ok().flatten())
        .unwrap_or_default();
    let app_secret = env::var("FEISHU_APP_SECRET")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| db::get_setting(conn, "feishu_app_secret").ok().flatten())
        .unwrap_or_default();
    let wiki_token = env::var("FEISHU_WIKI_NODE_TOKEN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| db::get_setting(conn, "feishu_wiki_node_token").ok().flatten());
    (app_id, app_secret, wiki_token)
}
```

### 3. 新增 Tauri 命令（src-tauri/src/commands.rs）

#### `get_config`

返回当前配置状态（不返回完整 secret）：

```rust
#[derive(Serialize)]
pub struct ConfigResponse {
    pub configured: bool,         // app_id 和 app_secret 都非空
    pub app_id: String,           // 完整显示
    pub app_secret_hint: String,  // 只显示 "****xxxx" 最后4位
    pub wiki_node_token: String,  // 完整显示
    pub from_env: bool,           // 是否来自环境变量（如果是，UI 上提示不可编辑）
}
```

```rust
#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<ConfigResponse, String>
```

#### `save_config`

保存凭据到 SQLite，重建 FeishuClient，重新初始化 wiki：

```rust
#[tauri::command]
pub async fn save_config(
    app_id: String,
    app_secret: String,
    wiki_node_token: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<ConfigResponse, String>
```

流程：
1. 校验 app_id 和 app_secret 非空
2. 写入 SQLite settings
3. 创建新的 `FeishuClient`
4. 替换 `state.feishu_client`（通过 RwLock write）
5. 如果 wiki_node_token 非空，调 `init_wiki` 并替换 `state.wiki`
6. 触发 `sync_all_queued`（用新 client 补发之前失败的消息）
7. 返回 ConfigResponse

#### `test_connection`

用当前保存的凭据测试飞书 API 连通性：

```rust
#[derive(Serialize)]
pub struct TestResult {
    pub success: bool,
    pub token_ok: bool,
    pub wiki_ok: bool,   // 只在 wiki_node_token 非空时测试
    pub error: Option<String>,
}

#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>) -> Result<TestResult, String>
```

流程：
1. 用当前 FeishuClient 调 `get_wiki_node`（如果有 token）或者 `append_text` 到一个 dummy doc 来测试 token 是否有效
2. 返回测试结果

### 4. sync.rs 适配

`sync_message` 和 `sync_all_queued` 的 `feishu_client` 参数从 `Arc<FeishuClient>` 改为从 `Arc<RwLock<Arc<FeishuClient>>>` 读取。在调用前 clone 出当前的 Arc<FeishuClient>（快照），不在整个 sync 过程中持有读锁。

### 5. 注册新命令

lib.rs 的 invoke_handler 加上新命令：

```rust
.invoke_handler(tauri::generate_handler![
    commands::send_message,
    commands::get_messages,
    commands::retry_message,
    commands::get_config,
    commands::save_config,
    commands::test_connection,
])
```

## 前端改动

### 1. 设置页面（src/index.html 新增）

在现有 `.app-shell` 旁边加一个 `.settings-page`，通过 CSS class 切换显示。不要用路由，就是两个 div 的显示切换。

```html
<div id="settings-page" class="settings-page" style="display:none">
  <div class="settings-header">
    <button id="settings-back" class="icon-btn">← 返回</button>
    <h2>飞书配置</h2>
  </div>
  <form id="settings-form" class="settings-form">
    <label>
      App ID
      <input type="text" id="cfg-app-id" placeholder="cli_xxxxxxxxxx" autocomplete="off" />
    </label>
    <label>
      App Secret
      <input type="password" id="cfg-app-secret" placeholder="输入 App Secret" autocomplete="off" />
    </label>
    <label>
      知识库节点 Token
      <input type="text" id="cfg-wiki-token" placeholder="从飞书知识库 URL 中提取（可选）" autocomplete="off" />
    </label>
    <div class="settings-actions">
      <button type="button" id="btn-test">测试连接</button>
      <button type="submit" id="btn-save">保存</button>
    </div>
    <div id="settings-status" class="settings-status"></div>
  </form>
</div>
```

### 2. 主页面加入口

在 composer 区域或消息面板顶部加一个齿轮图标按钮，点击跳到设置页。

### 3. 前端逻辑（src/app.js 新增）

```
页面加载 → 调 get_config
  ↓
configured=false → 显示设置页，隐藏聊天页
configured=true  → 显示聊天页，加载消息历史
```

设置页逻辑：
- 加载时调 `get_config`，填充表单（secret 用 hint 占位）
- "测试连接"按钮 → 调 `test_connection` → 显示结果
- "保存"按钮 → 调 `save_config` → 成功后切回聊天页
- `from_env=true` 时，输入框设为 readonly 并提示"由 .env 文件配置"
- secret 字段：如果用户没改（值为空），save_config 不更新 secret（保持原值）

### 4. 样式（src/style.css 新增）

沿用现有的闪电琥珀设计系统：
- 设置页背景同主页（var(--bg)）
- 输入框：圆角、琥珀 focus 边框（同消息输入框风格）
- 按钮：主按钮用 var(--btn)，次按钮用 outline 风格
- 测试结果：成功绿色、失败红色
- 表单宽度 max-width: 400px 居中

## 安全要点

1. **存储安全**：SQLite 在 Android app 私有目录，不可被其他 app 读取
2. **传输安全**：Tauri IPC 是进程内通信，不过网络
3. **不记日志**：`app_secret` 不打印到 eprintln，只打印 `app_id` 的前6位
4. **UI 脱敏**：get_config 返回 secret 的 hint（最后4位），不返回完整值
5. **save_config 中 secret 为空时保持原值**：避免用户编辑其他字段时意外清空 secret

## 文件修改清单

| 文件 | 改动 |
|------|------|
| `src-tauri/src/commands.rs` | AppState 改 RwLock，新增 get_config/save_config/test_connection |
| `src-tauri/src/lib.rs` | 启动流程改为 env → SQLite fallback，AppState 用新字段，注册新命令 |
| `src-tauri/src/sync.rs` | feishu_client 参数适配 RwLock |
| `src/index.html` | 新增设置页 HTML，主页加齿轮入口 |
| `src/app.js` | 新增设置页逻辑，首次检查 configured 状态 |
| `src/style.css` | 新增设置页样式 |

## 不改的

- `src-tauri/src/db.rs` — 已有 get_setting/set_setting，不需要改
- `crates/feishu-client/src/lib.rs` — FeishuClient 接口不变
- `.env` 和 `.env.example` — 保持不变，桌面开发继续用
