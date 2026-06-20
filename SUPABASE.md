# Supabase 接入说明

当前接入只保存用户数据，题库仍然从静态 JSON 读取。

## 1. 创建项目

1. 在 Supabase 新建项目。
2. 打开 SQL Editor。
3. 运行 `supabase/schema.sql`。

这个脚本会创建：

- `public.user_question_marks`：保存“简单题”标记。
- Row Level Security：用户只能读写自己的标记。
- `updated_at` 触发器：更新记录时自动刷新时间。

## 2. 配置登录回调

在 Supabase 控制台进入 `Authentication -> URL Configuration`：

- Site URL: `https://mjh-org.github.io`
- Redirect URLs:
  - `https://mjh-org.github.io/**`
  - 本地调试可临时加：`http://localhost:8787/**`

## 3. 填前端配置

在 Supabase 控制台进入 `Project Settings -> API`，复制：

- Project URL
- anon / publishable key

编辑 `frontend/supabase-config.js`：

```js
window.TIKU_SUPABASE = {
  url: 'https://你的项目.supabase.co',
  anonKey: '你的 anon/publishable key',
};
```

只放 anon/publishable key。不要把 `service_role` key 放进前端。

如果这两个字段为空，网站会自动使用本地标记模式，不会连接 Supabase。

## 4. 构建

```powershell
npm.cmd run build:pages
```

构建会把配置复制到 `docs/supabase-config.js` 和根目录 `supabase-config.js`。

## 5. 验证

1. 本地启动：

```powershell
npm.cmd run dev
```

2. 打开 `http://localhost:8787`。
3. 用邮箱发送登录链接。
4. 登录后标记一道题为简单题。
5. 在 Supabase 的 `user_question_marks` 表中检查是否新增记录。
6. 勾选“排除简单题”，确认随机练习不再抽到已标简单题。

## 6. 发布规则

先在本地确认 Supabase 登录和同步都正常，再运行构建并发布到 GitHub Pages。数据库没有验证完成前，不更新线上网站。
