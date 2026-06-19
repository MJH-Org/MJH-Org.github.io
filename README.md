# 随机组题复习器

一个按学科管理复习资料、随机组题出题的响应式网站。当前题库来自《会计信息系统复习题(2026)》HTML 版，数据与前端分离。

线上页面通过 GitHub Pages 托管，静态页面读取 `docs/data/` 下的 JSON 数据；本地开发时也可以启动 Node API。

## 功能

- 按学科选择题库
- 按章节/知识范围筛选
- 支持混合出题、只出选择题、只出简答题
- 选择题提交后自动判分
- 简答题用遮罩自查背诵
- 完整知识库搜索
- 原始复习资料文本备份
- 手机、平板、桌面端自适应

## 目录结构

```text
frontend/                  # 前端源文件
server/                    # 本地 API 和数据文件
server/data/subjects.json  # 学科索引
server/data/questions/     # 结构化题库
server/data/raw/           # 原文备份
docs/                      # GitHub Pages 静态发布目录
scripts/                   # 导入和构建脚本
```

## 本地运行

```bash
npm start
```

PowerShell 如拦截 `npm`，用：

```powershell
npm.cmd start
```

打开 `http://localhost:8787`。

## 发布到 GitHub Pages

生成静态页面：

```bash
npm run build:pages
```

PowerShell 可用：

```powershell
npm.cmd run build:pages
```

提交并推送后，在仓库设置中启用 GitHub Pages，来源选择 `main` 分支的 `/docs` 目录。

## 从 Org 导出的 HTML 重新导入

```bash
npm run import:org-html -- "会计信息系统复习题（2026）.html"
npm run build:pages
```

PowerShell 可用：

```powershell
npm.cmd run import:org-html -- "会计信息系统复习题（2026）.html"
npm.cmd run build:pages
```

题目格式：

```json
{
  "id": "unique-id",
  "type": "choice",
  "section": "章节名称",
  "prompt": "题干",
  "answer": "答案",
  "source": "来源",
  "knowledge": "完整知识点"
}
```

`type` 可用 `choice` 或 `short`。
