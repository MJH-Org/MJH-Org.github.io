# 随机组题复习器

一个按学科管理复习资料、随机组题出题的响应式网站。当前已把《会计信息系统复习题(2026)》HTML 版导入为独立数据层，前端通过 API 读取题库，不把数据库写死在页面里。

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
frontend/                  # 纯前端页面
server/                    # 数据 API 和静态文件服务
server/data/subjects.json  # 学科索引
server/data/questions/     # 每个学科的结构化题库
server/data/raw/           # 每个学科的原文备份
scripts/                   # 数据导入脚本
```

## 本地运行

```bash
npm start
```

如果 PowerShell 拦截 `npm`，可以用：

```powershell
npm.cmd start
```

打开 `http://localhost:8787`。

## 增加新学科

1. 在 `server/data/questions/` 新增一个题库 JSON 文件。
2. 在 `server/data/raw/` 新增该学科的原文文本，可选。
3. 在 `server/data/subjects.json` 增加一条学科记录。

## 从 Org 导出的 HTML 重新导入

```bash
npm run import:org-html -- "会计信息系统复习题（2026）.html"
```

PowerShell 如拦截 `npm`，用：

```powershell
npm.cmd run import:org-html -- "会计信息系统复习题（2026）.html"
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
