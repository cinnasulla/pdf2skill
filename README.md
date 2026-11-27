# pdf2skill

将 PDF 教材、文档和书籍自动转换为结构化知识索引与可复用技能库。

## 功能特性

- **PDF 解析**：基于 MinerU 引擎，支持 remote API 和 local Gradio 双模式，保留公式、表格与图片
- **语义切分**：LLM 驱动的策略性分块，保护不可分割的逻辑单元（习题集、定理证明、代码块）
- **树状合并**：递归剥离大块内容，Levenshtein 模糊匹配定位子标题，直至每块在 token 阈值内
- **技能生成**：为每个 chunk 提取关键词标签，生成 SKILL.md 主索引和独立参考文件
- **OpenAI 兼容**：所有 LLM 请求走 OpenAI Chat Completions 格式，支持任意兼容供应商
- **断点续传**：Stage 2/3 独立 checkpoint；Peeling 按 chunk 缓存已完成子树，`--from-stage` 选择性重跑、`--restart` 全部重来
- **纯前端模式**：TypeScript SDK（`@pdf2skill/sdk`）在浏览器内完成全部流水线（OPFS 存储、断点续传、zip 导出），后端只做 LLM / MinerU 代理
- **Web 界面**：Vite + TS 演示界面，配置/运行/输出一站式操作；`python frontend/server.py` 单入口托管构建后的界面与代理 API

## Pipeline 概览

```
PDF ──► MinerU ──► Chunking ──► Peeling ──► Skill Engine
  Stage 1      Stage 2       Stage 3      Stage 4
 (MinerU)     (LLM)         (LLM)        (LLM)
              ✓ checkpoint  ✓ checkpoint
```

- Stage 1 (MinerU)：调用 MinerU（remote API 或 local Gradio）将 PDF 转为 Markdown
- Stage 2 (Chunking)：LLM 分析全文目录结构，生成语义分块策略
- Stage 3 (Peeling)：递归剥离超过阈值的大块（TOC 剥离），生成最终 chunk 树
- Stage 4 (Skill Engine)：生成 SKILL.md 索引和参考文件；入口每次都执行，内部按 chunk 细粒度续跑

> PDF 如何一步步变成 Skill 包、每一阶段产出什么，见下文「PDF 如何变成 Skill」。

## 快速启动

第一次使用建议选 **Web 工作台**：配置、运行、断点续跑和下载都在浏览器里完成，不用记命令行参数。只想用命令行、或服务器上没有 Node.js，用下面的 **CLI**。两种方式共用同一套 Python 依赖。以下命令均在项目根目录执行。

### 0. 安装 Python 依赖（通用）

需要 Python 3.10+。

```bash
python -m venv venv

# Windows
venv\Scripts\activate
# Linux / macOS
source venv/bin/activate

python -m pip install -r requirements.txt
```

### 方式 A：Web 工作台（推荐第一次使用）

额外需要 Node.js 18+。工作台包含教程、配置、运行、输出四个页面。

```bash
npm install
npm run build            # 构建 SDK + 工作台；首次和改前端代码后需要
python frontend/server.py
```

打开 **http://localhost:8501**，完成首次配置：

1. **配置 → Provider 管理**：确认或新增 Provider，填写 `base_url` 和三个阶段模型。
2. **配置 → API Keys**：填 LLM Key 后点该行的「设置」；MinerU remote 模式再填 `MINERU_API_KEY`。设置后 Key 会写入服务端 `.env`，重启后保留，不保存在浏览器。
3. **保存配置**：把 Provider、模型、PDF 与 MinerU 参数同步到 `config/settings.yaml`。
4. **运行**：上传 PDF 或 Markdown，点「开始运行」；完成后在「输出」页下载整包 zip 或 Skill zip。

> 使用自部署 MinerU 时，在配置页切换到「本地模式」并填写 Gradio 地址，不需要 `MINERU_API_KEY`。
> 如果页面提示「代理后端未连接」，请确认是用 `python frontend/server.py` 启动的（它同时提供界面与 `/api/*`），而不是普通静态文件服务器。

### 方式 B：CLI（只要 Python，适合批处理）

```bash
python main.py "path/to/book.pdf"
```

首次运行会自动启动引导向导，按提示填写 Provider、模型、MinerU 和 Key（写入 `.env`）。也可以手动创建：

```bash
cp .env.example .env
# 编辑 .env，至少填一个 LLM Provider Key；remote MinerU 还需 MINERU_API_KEY
```

输出在 `--output` 指定的目录（默认 `outputs/`；交互式入口 `run_test.py` 默认 `outputs/<文件名>/`）。常用续跑命令：

```bash
python main.py "path/to/book.pdf" --from-stage llm_chunking  # 保留 Stage 1，只重跑分块
python main.py "path/to/book.pdf" --restart                  # 清空断点，全部重来
```

更多参数见「CLI 使用」。

### 第一次启动检查

- **打不开 8501**：确认 `python frontend/server.py` 还在运行，端口没有被其他程序占用。
- **提示未连接代理后端**：正式使用请用 `frontend/server.py`（同时提供界面与 `/api/*`）；只有开发模式才分开启动 `proxy_server.py` + Vite。
- **报 `NO_API_KEY`**：到「配置 → API Keys」设置对应 Provider 的 Key；远程 MinerU 还需要 `MINERU_API_KEY`。
- **通过反向代理或换端口访问**：启动前用 `PDF2SKILL_ALLOWED_HOSTS` 追加实际 Host，否则会被 DNS rebinding 防护拒绝。

## Web 工作台说明

`server.py` 同时托管构建后的工作台与 `/api/*` 代理（LLM / MinerU 转发）。API Key 只保存在服务端：在「配置」面板设置后会写入项目根目录 `.env` 并立即生效，重启后仍保留；运行时的 LLM 请求只携带 Provider 名称，浏览器不会拿到 Key。前端开发时改用下文的 Vite 开发模式。

「配置」面板的 Provider、模型、思考强度、PDF 与 MinerU 参数会先保存到浏览器 localStorage，点「保存配置」时再同步写入 `config/settings.yaml`；新浏览器或换 origin 打开时会自动从服务端恢复配置，「从服务端导入」也可手动恢复。

「运行」页可以直接选择当前浏览器 OPFS 中已完成 Stage 1 的任务继续，无需重新上传原文件；「输出」页也提供「继续任务」入口。浏览器任务按 origin 隔离（`127.0.0.1:8501`、`localhost:8501`、`5173` 各自独立）。

CLI 写在项目根目录 `outputs/` 的任务不会自动出现在浏览器列表里，但可以在「运行」页点「从磁盘导入任务」：服务端 `GET /api/jobs` 列出可续跑的磁盘任务，`GET /api/jobs/{id}/bundle` 打包 checkpoint、`full.md`、图片、分块与技能文件，浏览器解压写入 OPFS 后即可按原有阶段数继续。打包会排除 `splits/`、MinerU 分段目录与原始 zip。同名任务不会被覆盖，需先在「输出」页删除旧任务。

「运行」页日志默认只显示阶段与关键状态，带时间戳和级别；勾选「详细」可展开逐 chunk、锚点与缓存日志，日志最多保留 500 行。

开发模式（前端热更新）：

```bash
# 终端 1：代理后端（8502）
python frontend/proxy_server.py
# 终端 2：Vite 开发服务器
npm run dev:app
# 浏览器访问 http://localhost:5173
```

## CLI 使用

```bash
# 交互式选择文件与参数
python run_test.py

# 直接处理
python main.py "path/to/book.pdf"
python main.py "path/to/book.pdf" --output outputs

# 只配置，不运行
python main.py --setup
```

断点续传：

```bash
# 从 Stage 2 重新开始（保留 Stage 1 结果）
python main.py "path/to/book.pdf" --from-stage llm_chunking

# 清除所有 checkpoint，从头运行
python main.py "path/to/book.pdf" --restart
```

`--from-stage` 可选值：`pdf_conversion`、`llm_chunking`、`tree_merging`

- `llm_chunking`：保留 Stage 1，重跑分块；内容未变化的 chunk 会复用 `peeling_cache/`，不会重做 Peeling
- `tree_merging`：保留分块，只补齐尚未完成的 Peeling 子树
- `pdf_conversion` / `--restart`：同时清空 `peeling_cache/`，避免旧 markdown 的剥离结果混入

Stage 2 本身是一次 LLM 规划调用（失败重试一次），没有可切的中间进度；Stage 3 的 Peeling 才按子树缓存。

## PDF 如何变成 Skill

一句话概括：**PDF 先被 MinerU 转成带标题层级的 Markdown，再由 LLM 按章节切成 base chunks，然后递归剥离成叶子 chunk 树，最后为每个叶子生成标签和引用文件，汇总成 `SKILL.md`。**

```text
book.pdf
  │  Stage 1  MinerU：PDF → Markdown（公式/表格/图片保留）
  ▼
full.md + images/
  │  Stage 2  LLM 只看标题树，决定章级切分行号
  ▼
full_chunks_original/           # 3~6 个 base chunks（按行号切）
  │  Stage 3  超限的 base chunk 用 LLM 找子标题锚点，递归切分
  ▼
full_chunks/
  ├── chunks/chunk_0001.md …    # 最终叶子 chunk
  ├── chunks_index.json         # 文件、标题、token 估算
  └── tree.json                 # 完整父子层级
  │  Stage 4  为每个叶子打标签，生成引用文件与主索引
  ▼
generated_skills/
  ├── SKILL.md                  # name + description + Overview + Reference Guide
  └── references/chunk_0001.md …# 每个叶子一份，可被 Skill 直接引用
```

### Stage 1：PDF → Markdown

MinerU 负责把版式复杂的 PDF 还原成 Markdown，尽量保留：

- 章节标题（Markdown `#` 层级，供 Stage 2 识别结构）
- 公式、表格、代码块
- 图片（落到 `images/`，并在 Markdown 中保留引用）

两种模式：

- **remote**：先检查页数；超过 `page_limit` 时按 `min(page_limit, 200)` 页拆成 `splits/*_partNN.pdf`，逐份请求签名上传地址、上传、轮询结果（约 10 秒一次，最长 30 分钟），下载结果 ZIP，解压后优先取 `full.md`，再把各分段的 Markdown 用 `---` 和 `# Part N` 拼回一个 `full.md`。
- **local**：直接调用自部署的 MinerU Gradio 服务，不分页拆分；结果 ZIP 同样解压为 `full.md + images/`。

Markdown 输入（Web/SDK 支持）会跳过 MinerU，直接写入 `input.md` 并标记 Stage 1 完成。Stage 1 结束后 checkpoint 只记一个 `md_file`；只要 `full.md` 还在，下次运行不会重新解析。

### Stage 2：Markdown → base chunks

这一阶段**不把全文塞给 LLM**，而是先在本地提取 Markdown 标题树：

```text
[Line 1] # 深入理解计算机系统
[Line 18] ## 第 1 章 计算机系统漫游
[Line 240] ## 第 2 章 信息的表示和处理
[Line 610] ### 2.1 信息存储
...
```

把标题树、总行数、总字符数交给 LLM，让它返回关键字段：

```json
{
  "chapter_splits": [1, 18, 240, 610, 980],
  "toc_range": [2, 17]
}
```

本地随后按这些行号切出若干 **base chunks**（通常 3~6 个），保存到 `full_chunks_original/`，同时写入 checkpoint 的 `base_chunks`。TOC 范围内的 chunk 会被标记为 `is_atomic`，避免后续被切碎。

关键点：

- 切分单位是**章节/逻辑段**，不是固定字数窗口。
- LLM 失败会重试一次；仍失败则退化为“每约 2000 行切一块”的均匀切分。
- 退化切分**不会写 Stage 2 checkpoint**，下次运行会重新尝试 LLM 规划。
- 每个 base chunk 记录 `start_line`、`end_line`、`content`；正文不会丢行。

### Stage 3：base chunk → 叶子 chunk 树（Peeling）

Stage 2 的块可能仍然很大（一整章、附录、习题集），Stage 3 负责递归“剥”到可管理的大小。

对每个 chunk：

1. 用加权估算 token：CJK 字符约 1 token/字，其他字符约 4 字符/token。
2. 不超过 `chunk_max_tokens`（默认 10,000）→ 直接作为叶子。
3. 已标记 atomic（TOC 由 Stage 2 强制保护；习题、证明、代码块等由 Stage 3 的 LLM 判断）→ 不再切分。
4. 超过上限 → 把 chunk 前 40,000 字符交给 LLM，要求给出 2~5 个切分锚点（每段约 30 个字符）或声明 `is_atomic`。
5. 在原文中定位锚点：先精确匹配；失败则用 Levenshtein 模糊匹配（允许少量标点/空格差异）。
6. 按锚点位置切分；小于 `chunk_min_threshold`（默认 1,000 字符）的碎片与相邻块合并。
7. 对每个子块递归执行 1~6，直到成为叶子；最多 `chunk_max_iterations`（默认 5）层。
8. 把叶子内容写成 `full_chunks/chunks/chunk_XXXX.md`，完整层级写入 `tree.json`，文件与 token 估算写入 `chunks_index.json`。

最终结构类似：

```text
Document
├── 第 1 章 计算机系统漫游
│   ├── chunk_0001.md
│   └── chunk_0002.md
├── 第 2 章 信息的表示和处理
│   ├── 2.1 信息存储
│   │   ├── chunk_0003.md
│   │   └── chunk_0004.md
│   └── 2.2 整数表示
│       └── chunk_0005.md
└── 习题集（atomic）
    └── chunk_0006.md
```

Peeling 是成本最高、也最值得缓存的阶段：

- 每个成功剥离的子树按 `content + title + parent_path + 行号 + iteration + 配置` 计算 SHA-256，缓存到 `peeling_cache/<hash>.json`。
- 再次运行（例如只改 Stage 2 切分）时，内容未变的子树直接复用缓存，不再调用 LLM。
- 只有“本次没有新增 LLM 错误”的子树才会写缓存；出错的块保持原样并记入 `peel_errors`，下次重试。
- 只要 `peel_errors > 0`，Stage 3 就**不写 checkpoint**；下次运行会继续补齐，而不是把有错误的树当成完成。

### Stage 4：叶子 chunk → Skill 包

Stage 4 把“一棵 chunk 树”变成 Claude Agent Skill 可用的目录结构：

1. **书级概览**：根据标题树生成 `Overview`，并提取一段可放进 frontmatter 的描述。
2. **逐 chunk 打标签**：对每个叶子取前 2,000 字符，让 LLM 输出关键词/主题标签，例如 `进程 | 虚拟内存 | 地址翻译`。
3. **写引用文件**：每个叶子生成 `references/chunk_XXXX.md`，带 frontmatter：

```md
---
id: chunk_0003
title: 2.1 信息存储
parent_path: 深入理解计算机系统 > 第 2 章 信息的表示和处理
start_line: 610
end_line: 980
---

<该 chunk 的 Markdown 原文>
```

> Stage 3 的叶子沿用所属 base chunk 的行号范围，所以这里的 `start_line` / `end_line` 表示章节范围，不是叶子的精确起止行。

4. **生成技能名**：Web/SDK 优先使用用户指定的输出名；否则让 LLM 生成 kebab-case 名称，再校验（小写字母/数字/中划线、≤64 字符、不能首尾或连续 `-`），失败则从书名转换，最后回退到时间戳。
5. **汇总 SKILL.md**：

```md
---
name: csapp-notes
description: 深入理解计算机系统的结构化知识索引。Use this skill when...
---

# 深入理解计算机系统

## Overview
（书级概览）

## Reference Guide
- [深入理解计算机系统 > 第 1 章 计算机系统漫游 > chunk_0001](references/chunk_0001.md): 进程 | 编译系统 | 存储层次
- [深入理解计算机系统 > 第 2 章 信息的表示和处理 > 2.1 信息存储](references/chunk_0003.md): 补码 | 字节序 | 位运算
```

同时会把 `images/` 复制到 `references/images/`，保证引用文件里的图片仍然可用。

Stage 4 有独立的 `generated_skills/.checkpoint.json`：书级概览、每个 chunk 的标签、技能名分别记录。中途中断后重跑只会补齐缺失的 chunk；但如果 Stage 2/3 重跑导致树结构变化，这个子 checkpoint 会被清空，避免旧标签描述新内容。

### 各阶段数据形态

| 阶段 | 数据形态 | 谁在计算 | 断点粒度 |
|------|----------|----------|----------|
| 输入 | PDF 或 Markdown | 用户 | — |
| Stage 1 | `full.md` + `images/` | MinerU | 整段 Markdown |
| Stage 2 | 若干按行号切分的 base chunks（通常 3~6 个） | LLM（只看标题树） | 一次 LLM 规划 |
| Stage 3 | 叶子 chunk 树 + `tree.json` | LLM（按超限块逐个剥离） | 按子树缓存，可逐块补齐 |
| Stage 4 | `SKILL.md` + `references/*.md` | LLM（概览/标签/命名） | 按 chunk 的 summary + 引用文件 |

### 续跑时到底重跑哪一段

| 命令 | 保留 | 重跑/补齐 |
|------|------|-----------|
| `--from-stage llm_chunking` | Stage 1 的 `full.md`、`peeling_cache/` | Stage 2 规划；内容未变的子树复用缓存 |
| `--from-stage tree_merging` | Stage 2 的 base chunks、缓存 | 只补齐尚未完成的 Peeling 子树 |
| `--from-stage pdf_conversion` / `--restart` | 无（会清 Stage 1 产物与缓存） | 从 PDF 解析开始全部重跑 |

浏览器端的 `resume()` 语义相同：任务存在 OPFS `jobs/<jobId>/` 中；如果 Stage 1 未完成或 `full.md` / `input.md` 已丢失，`resume()` 会拒绝执行，需要重新上传原文件；Markdown 存在时可直接从 Stage 2 之后继续。CLI 任务可先通过「从磁盘导入任务」复制到浏览器再续跑。

## 纯前端模式（SDK + 演示界面）

除 Python CLI 外，项目提供 TypeScript SDK：流水线四阶段（分块 / 树剥离 / 技能生成）、PDF 校验、checkpoint 断点续传、文件存储（OPFS）、zip 导出**全部在浏览器内完成**。后端瘦身为纯代理，只做两件事：

1. **LLM 转发**（`POST /api/llm/chat`）——持有 API Key，Key 不进入浏览器
2. **MinerU 转发**（`/api/mineru/*`）——官方 API 与自部署 Gradio 全部经代理访问

SDK 不是纯静态即可用：需要部署一个持有 Key 的服务端代理（本仓库的 `frontend/proxy_server.py`，或按相同接口实现的服务），并通过 `backendBaseUrl` 指向它；同源部署时保持空字符串即可。浏览器需要 HTTPS 或 localhost（OPFS / Web Crypto 依赖 secure context）。

### 在自己的前端项目中使用 SDK

SDK 目前是 workspace 包（尚未发布到 npm）。先在本仓库构建，再从目标项目安装：

```bash
# 1. 在本仓库构建
npm run build

# 2. 在目标项目安装（本地路径，或发布到私有 registry 后用包名）
npm install /path/to/pdf2skill/packages/sdk jszip pdf-lib
```

```ts
import { Pdf2Skill } from '@pdf2skill/sdk';

const pdf2skill = new Pdf2Skill({
  config: {
    providers: { 'my-provider': { base_url: 'https://api.example.com/v1', api_key_env: 'MY_PROVIDER_API_KEY' } },
    routers: { chunking: 'my-provider', peeling: 'my-provider', skillEngine: 'my-provider' },
  },
});

pdf2skill.on('stage', (e) => console.log(e.stage, e.status, e.percent));
pdf2skill.on('log', (msg) => console.log(msg));

// 运行（PDF 或 Markdown 直接导入）
const result = await pdf2skill.run({
  kind: 'markdown',
  file: new File([text], 'book.md', { type: 'text/markdown' }),
  name: 'book.md',
}, {
  // 可选：指定输出名称（kebab-case），同时用作输出目录名与 SKILL.md 的 name 字段。
  // 不传则从文件名自动派生；校验规则见 validateSkillName()。
  outputName: 'my-book-notes',
});

// 任务管理 / 输出浏览 / 导出
const jobs = await pdf2skill.listJobs(); // completedStages + resumable
const tree = await pdf2skill.listOutputTree(jobs[0].jobId);
const zip = await pdf2skill.exportZip(jobs[0].jobId); // 整包输出 zip（保留 outputs/ 布局）
const skill = await pdf2skill.exportSkillZip(jobs[0].jobId); // { blob, skillName }
// skill.blob 下载文件名使用 SKILL.md 的 name；压缩包根目录直接是 SKILL.md + references/

// 不重新上传原文件，直接从已有任务的 checkpoint 继续
if (jobs[0].resumable) {
  await pdf2skill.resume(jobs[0].jobId, { fromStage: 'tree_merging' });
}

// 把服务端 outputs/ 中的 CLI 任务导入 OPFS，再按 checkpoint 继续
const resp = await fetch(`/api/jobs/${encodeURIComponent('my-book')}/bundle`);
const imported = await pdf2skill.importJob(
  'my-book',
  new Uint8Array(await resp.arrayBuffer()),
);
console.log(imported.completedStages); // ['pdf_conversion', 'llm_chunking', ...]
```

代理服务的 `.env` 中需要有 `MY_PROVIDER_API_KEY`；浏览器只会把 Provider 名称发给代理。SDK 通过 `backendBaseUrl` 指向的代理调用 `/api/llm/chat` 与 `/api/mineru/*`，同源部署时留空即可；跨域部署时需同时配置代理的 CORS 与 Host 白名单。中断后重新运行同一文件自动从 checkpoint 续跑；`abort()`、`resume()`、`importJob()`、`deleteJob()` 语义与 CLI 一致。`resume()` 只依赖 OPFS 中的 Stage 1 markdown，因此 `listJobs()` 用 `resumable` 标记哪些任务可以不再上传原文件直接继续。

### SDK 测试

```bash
npm test   # vitest，167 个用例（分块 / 剥离与缓存 / 技能生成 / 流水线 / 任务导入 / 双 zip 导出 / 门面 / 命名校验 / 与 Python 录制回放逐字节对齐）
```

## 配置

### .env vs settings.yaml

通过 Web 工作台设置 API Key 或点「保存配置」会自动写入对应文件；下表用于决定手动编辑时改哪个。

| 场景 | 改哪个 |
|------|--------|
| API 密钥 | .env |
| 临时切换 Provider 或模型 | .env |
| 项目长期默认配置 | settings.yaml |
| 团队统一基线设置 | settings.yaml |

### LLM Provider

项目使用 OpenAI Chat Completions 兼容格式调用 LLM，因此**任何提供 OpenAI 兼容 API 的服务均可接入**。用户应自行寻找 API 来源（官方平台、第三方中转站、自建代理等），然后在 `settings.yaml` 中添加 Provider 配置即可，无需改动任何 Python 代码。

每个 Provider 需配置：

| 字段 | 说明 |
|------|------|
| `base_url` | OpenAI 兼容 API 地址（不含 `/chat/completions`） |
| `api_key_env` | 存放 API Key 的环境变量名 |
| `chunking_model` | Stage 2 使用的模型 |
| `peeling_model` | Stage 3 使用的模型 |
| `skill_engine_model` | Stage 4 使用的模型 |
| `chunking_reasoning_effort` | Stage 2 的思考强度（可选，`reasoning_effort`） |
| `peeling_reasoning_effort` | Stage 3 的思考强度（可选） |
| `skill_engine_reasoning_effort` | Stage 4 的思考强度（可选） |

**Provider 示例：**

| Provider | base_url | api_key_env | 说明 |
|----------|----------|-------------|------|
| siliconflow | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | SiliconFlow 官方平台 |
| google | `https://generativelanguage.googleapis.com/v1beta/openai` | `GOOGLE_API_KEY` | Google Gemini API |
| deepseek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | DeepSeek 官方 API |

> 上表仅为示例，`config/settings.yaml` 默认使用 siliconflow 路由；请替换为自己实际可用的 Provider。
> 升级提示：默认配置只保留这三个公开示例，此前自定义的 Provider 需在配置页重新添加，或从 git 历史恢复。

**添加新 Provider 示例：**

```yaml
# settings.yaml
llm:
  providers:
    my-provider:
      base_url: https://your-api-endpoint.com/v1
      api_key_env: MY_PROVIDER_API_KEY
      chunking_model: model-name-a
      peeling_model: model-name-b
      skill_engine_model: model-name-c
      # 可选：OpenAI Chat Completions 的 reasoning_effort
      chunking_reasoning_effort: low
      peeling_reasoning_effort: high
      skill_engine_reasoning_effort: high
```

```bash
# .env
MY_PROVIDER_API_KEY="your_key_here"
CHUNKING_PROVIDER="my-provider"
PEELING_PROVIDER="my-provider"
SKILL_ENGINE_PROVIDER="my-provider"
```

**Provider 路由**（三个阶段可独立选择不同 Provider）：

| 环境变量 | 作用 |
|----------|------|
| `CHUNKING_PROVIDER` | Stage 2 使用的 Provider |
| `PEELING_PROVIDER` | Stage 3 使用的 Provider |
| `SKILL_ENGINE_PROVIDER` | Stage 4 使用的 Provider |

**模型覆盖**（优先级从高到低）：

1. `{STAGE}_MODEL` 环境变量（如 `CHUNKING_MODEL`）— 全局覆盖
2. `settings.yaml` 中 `llm.providers.{provider}.{stage}_model`
3. 缺失时报错

**思考强度**（可选）：每个阶段可单独设置 OpenAI Chat Completions 的 `reasoning_effort`，内置预设为 `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`；留空表示不发送该字段（由 Provider/模型使用默认值）。不同模型支持的档位不同，不支持的档位会被 Provider 拒绝（HTTP 400）。Provider 的 `/models` 接口通常不返回该元数据，因此 Web 配置页直接提供上述预设。

Python CLI 的覆盖优先级：

1. `{STAGE}_REASONING_EFFORT` 环境变量（如 `PEELING_REASONING_EFFORT`）
2. `{PROVIDER_NAME}_{STAGE}_REASONING_EFFORT` 环境变量（如 `GOOGLE_PEELING_REASONING_EFFORT`）
3. `settings.yaml` 中 `llm.providers.{provider}.{stage}_reasoning_effort`
4. 留空不发送

**Provider 字段环境变量覆盖**：格式为 `{PROVIDER_NAME}_{FIELD}`（连字符转下划线）：

```bash
SILICONFLOW_BASE_URL="https://custom-proxy.example.com/v1"
GOOGLE_CHUNKING_MODEL="gemini-2.0-flash"
GOOGLE_PEELING_REASONING_EFFORT="high"
LOCAL_VLLM_BASE_URL="http://192.168.1.100:8000/v1"
```

### MinerU 配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MINERU_API_MODE` | `remote`（官方 API）或 `local`（本地 Gradio） | `remote` |
| `MINERU_LANGUAGE` | 语言：`ch` / `en` / `east_slavic` | `ch` |
| `MINERU_LOCAL_BASE_URL` | 本地 Gradio 地址（local 模式） | `http://localhost:7860` |
| `MINERU_REMOTE_UPLOAD_MODE` | 远程上传模式 | `file` |

> Remote 模式需要 `MINERU_API_KEY`；Local 模式需先启动 MinerU Gradio 服务。

### PDF 处理参数

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PDF_PAGE_LIMIT` | 单 PDF 最大页数 | 200 |
| `CHUNK_MERGE_THRESHOLD` | 合并分片字符阈值 | 5000 |
| `CHUNK_MIN_THRESHOLD` | 触发合并的最小字符长度 | 1000 |
| `REQUEST_INTERVAL` | API 请求间隔（秒） | 1.0 |

## 输出结构

下面以「每个任务一个目录」为例（Web 工作台和 `run_test.py` 默认如此）；`python main.py --output outputs` 会直接把 `outputs/` 当作当前任务目录。

```
outputs/
└── book_name/
    ├── .checkpoint.json        # 断点文件
    ├── full.md                 # Stage 1 输出（Markdown 全文）
    ├── full_chunks_original/   # Stage 2 原始分块
    ├── full_chunks/            # Stage 3 剥离后分块
    │   ├── chunks/
    │   ├── chunks_index.json
    │   └── tree.json
    ├── peeling_cache/          # Peeling 子树缓存（内部状态，不打包进 zip）
    └── generated_skills/       # Stage 4 技能文件
        ├── SKILL.md            # 主索引
        └── references/         # 各 chunk 参考
```

## 项目结构

```
main.py                  # CLI 入口 + run_pipeline()
run_test.py              # 交互式测试入口
config/
  settings.yaml          # Provider / MinerU / PDF 参数
  config.py              # 配置单例（双层合并：yaml + env）
core/
  pdf_processor.py       # Stage 1: MinerU remote/local
  llm_chunker.py         # Stage 2: Chunking 语义分块
  tree_merger.py         # Stage 3: Peeling TOC 剥离
  skill_engine.py        # Stage 4: Skill Engine 技能生成
  onboarding.py          # 首次运行引导向导
frontend/
  server.py              # 单入口：托管 packages/app/dist + 挂载代理 API（8501）
  proxy_server.py        # 瘦代理后端（LLM / MinerU 转发；开发模式 8502）
  job_bridge.py          # 磁盘 outputs/ 任务列表与打包（供浏览器导入 OPFS）
packages/
  sdk/                   # @pdf2skill/sdk：浏览器端流水线 SDK（Vite lib mode）
    src/
      pipeline.ts        # 四阶段编排（对应 main.py run_pipeline）
      pdf2skill.ts       # Pdf2Skill 门面类
      stages/            # llmChunker / treeMerger / peelCache / skillEngine
      mineru/            # MinerU 客户端 + zip 解压（经代理）
      storage/           # OPFS 封装 + checkpoint + importJob（磁盘任务导入）
      export/zip.ts      # 整包 zip + 按 SKILL.md name 打包的 Skill zip
    test/                # vitest 单测 + 与 Python 的录制回放对齐测试
  app/                   # @pdf2skill/app：纯前端演示界面（Vite + TS，4 Tab）
utils/
  logger.py              # 日志 + PDF2SkillsException
  llm_client.py          # OpenAI 兼容 LLM 客户端
  retry_client.py        # 带重试的 HTTP 客户端
  checkpoint.py          # 断点续传管理器
prompts/                 # 各阶段 LLM 提示词模板
tests/                   # pytest 测试（testpaths 已限定在此目录）
```

## 测试

```bash
# Python 单元测试（核心逻辑 + 代理安全 + 任务桥接 + 配置持久化 + 回归）
python -m pytest tests -q

# SDK 单元测试（167 个用例，vitest）
npm test

# 手工脚本（非 pytest 用例，需配置 .env，会调用真实 API）
python tests/test_e2e_real.py
python tests/test_mineru_stage.py
```

## 许可证

[MIT](LICENSE)
