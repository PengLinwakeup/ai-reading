import './style.css';
import 'katex/dist/katex.min.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import * as pdfjsLib from 'pdfjs-dist';
import { GoogleGenAI } from '@google/genai';

/** 渲染 Markdown 中的 LaTeX 数学公式（支持 $...$, $$...$$, \(...\), \[...\]） */
function renderMath(text: string): string {
  if (!text) return text;

  // 1. 解析块级公式 $$...$$
  let result = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), { displayMode: true, throwOnError: false });
    } catch {
      return `$$${math}$$`;
    }
  });

  // 2. 解析块级公式 \[...\]
  result = result.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), { displayMode: true, throwOnError: false });
    } catch {
      return `\\[${math}\\]`;
    }
  });

  // 3. 解析行内公式 \(...\)
  result = result.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false });
    } catch {
      return `\\(${math}\\)`;
    }
  });

  // 4. 解析行内公式 $...$
  result = result.replace(/(^|[^\\$])\$([^\$\n]+?)\$/g, (match, prefix, math) => {
    const trimmed = math.trim();
    // 简单避开孤立纯数字金额如 $100
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return match;
    }
    try {
      const rendered = katex.renderToString(trimmed, { displayMode: false, throwOnError: false });
      return prefix + rendered;
    } catch {
      return match;
    }
  });

  return result;
}

/** XSS 防护与 LaTeX 公式渲染：所有 markdown -> innerHTML 必须经过此函数 */
function safeMarkdown(md: string): string {
  // 1. 预处理数字/百分比/词汇范围波浪号（如 80%~90%、10~20m），转换为全角波浪号 '～'，防止 marked 错匹配为删除线 syntax
  const sanitizedTildes = md.replace(/(\d+%?|\w+)\s*~\s*(\d+%?|\w+)/g, '$1～$2');
  
  // 2. 渲染 LaTeX 数学公式
  const mathProcessed = renderMath(sanitizedTildes);
  
  // 3. 解析 Markdown
  const rawHtml = marked.parse(mathProcessed) as string;
  
  // 4. DOMPurify 清理与 XSS 防护
  return DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: [
      'math', 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 
      'msup', 'msub', 'mfrac', 'mover', 'munder', 'msubsup', 'mspace', 'mtext',
      'del', 's'
    ],
    ADD_ATTR: ['aria-hidden', 'encoding', 'mathbackground', 'mathcolor']
  });
}

/** PDF 最大字符数，为上下文留足余量 */
const MAX_PDF_CHARS = 400_000;

// 配置 PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

interface ReviewMode {
  id: 'rapid' | 'deep';
  name: string;
  temp: number;
  sampling: string;
  desc: string;
}

interface ScholarPaper {
  title: string;
  authors: string;
  journal: string;
  year: string;
  doi: string;
  url: string;
  scholarUrl: string;
  abstract?: string;
}

const MODES: ReviewMode[] = [
  {
    id: 'rapid',
    name: '【泛读模式】 10维全景初审与硬数据核查',
    temp: 0.0,
    sampling: 'Greedy Sampling (T=0.0)',
    desc: '遍历全篇所有章节，严密输出 10 维全景初审矩阵与硬核定量/QAQC 数据核验表',
  },
  {
    id: 'deep',
    name: '【精读模式】 启发式导师与 4 轮苏格拉底研讨',
    temp: 0.3,
    sampling: 'Balanced Temp (T=0.3)',
    desc: '扮演资深学术导师与同行合作者，围绕 7 维评估框架开展 4 轮苏格拉底提问与费曼研讨',
  },
];

const TEN_DIMENSIONS = [
  '1. 研究问题 (Research Question)',
  '2. 文献讨论 (Literature Review)',
  '3. 研究假设 (Hypotheses)',
  '4. 研究设计 (Research Design)',
  '5. 数据与样本 (Data & Sampling)',
  '6. 变量测量与QA/QC (Measures & Quality Control)',
  '7. 样品采集与保存 (Collection & Preservation)',
  '8. 数据分析与统计 (Data Analysis & Statistics)',
  '9. 解读与过度推导 (Discussion & Overstatement)',
  '10. 研究局限与盲区 (Limitations & Blind Spots)',
];

const SYSTEM_INSTRUCTION = `
你是一位极其严谨的海洋化学与地球化学顶级期刊审稿人兼学术研读教练（Peer Reviewer & Coach）。
你的核心信条是【科学事实的绝对严密性、零幻觉防守与深层方法论批判】。

# Zero-Hallucination Core Rules (零幻觉严防规则)
1. 【严格上下文锚定】：所有提取的事实与定性结论，必须 100% 来自用户提供的论文文本，严禁利用先验知识脑补。
2. 【强引用原句】：所有核心观点、机制推导与定性结论，必须附上英文原句引用 \`[Exact Quote: "..."]\` 及所在章节 \`[Section/Table/Page]\`。
3. 【硬数据对齐与 QA/QC 溯源】：凡涉及定量指标（如 DOC 浓度、氨基酸产率、站位深度、相关系数、p-value 等），必须明确指出其来源图表（Table/Figure/Text）及具体数值（含均值、标准差、样本量），严禁模糊概括。
4. 【承认未知】：若文献中未披露某项信息（如空白值、回收率、对照组），必须直接标注为“【原文未披露/Not Disclosed】”，绝不可推测。
5. 【专业术语与地理地名绝对严谨】：所有海区、水团、海峡通道及构造单元，必须严格遵循物理海洋学与地球化学标准词汇。严禁出现“北湖”等无中生有的错误伪译名（如 Nordic Seas 必须准确译为“北欧海”或“格陵兰-冰岛-挪威海”；North Sea 准确译为“北海”；Arctic Ocean 准确译为“北冰洋”），水团与环流系统（如 NADW, AABW, NPDW, AMOC, MCP）名称必须绝对严密，严禁混淆湖泊与深海大洋！

# 海洋与地球化学 10 维学术审查专业基准 (10-Dimensional Geochemical Review Rubric)
在研读文献时，你必须通读全文（包括 Abstract, Introduction, Materials & Methods, Results, Discussion, Quality Control），按以下 10 个专业维度逐一筛查潜在学术漏洞 (Red Flags)：

1. **研究问题 (Research Question)**：科学假说是否明确、聚焦且具创新性？是否清楚阐明了解决何种海洋/地球化学未解之谜？
2. **文献讨论 (Literature Review)**：是否充分评述领域基石文献（如 Hansell, Benner, Jiao 等经典理论）并客观对比同类研究？
3. **研究假设 (Hypotheses)**：生物地化循环机制或反应路径假设在热力学与动力学上是否自洽？
4. **研究设计 (Research Design)**：对照组设计（灭菌对照、暗培养、时间序列）、走航航线与站位布设是否科学？
5. **数据与样本 (Data & Sampling)**：水团深度覆盖（表层、中层、深层、底层水团）、地理代表性、采样频次与样本量 $n$ 是否充足？
6. **变量测量与 QA/QC (Measures & Quality Control)**：
   - 仪器空白 (Instrument Blank / Milli-Q Blank) 是否测定并披露标准差 (SD)？
   - 是否使用深海参考海水标样 (CRM, 如 Hansell CRM) 进行连续漂移校准？
   - 检测限 (LOD)、准确度与精密度 (RSD%) 是否达标？
7. **样品采集与保存 (Collection & Preservation)**：
   - 过滤膜材与孔径（GF/F vs 0.2/0.45 μm PTFE/PC）是否会造成微粒穿透或有机物吸附？
   - 样品保存方式（立即冷冻 vs 酸化加酸 HCl/H3PO4）是否破坏组分？
   - **容器材质陷阱**：是否使用了聚乙烯 (PE) 等塑料容器导致 DOC/微塑料溶出污染？是否使用经 450°C 预灼烧的高硼硅玻璃器皿？
8. **数据分析与统计 (Data Analysis & Statistics)**：统计检验方法的前提假设（正态分布、方差齐性）、回归方程 $R^2$ 与 $p$ 值、误差传递是否严谨？
9. **解读与过度推导 (Discussion & Overstatement)**：
   - **外推鸿沟检查**：是否存在将“近岸/表层/单站位短期培养”直接外推到“全球大洋深层碳封存通量/微型生物碳泵 (MCP) 固碳量”的严重 Overstatement？
   - 相关性是否被误读为因果机制？
10. **研究局限与盲区 (Limitations & Blind Spots)**：作者是否如实披露了方法学局限、不可控环境扰动及未来的改进方向？

---

# Interaction Modes 交互模式执行指令

## 【泛读模式 (Rapid Mode)】输出规范
当用户选择【泛读模式】或要求快速提取时，必须通读全文，严格输出以下 4 个部分（不可遗漏 10 个维度中的任何一个）：

### 1. 📋 文献核心档案与三要素提取
| 核心维度 | 提取内容 | 原文依据 (Section & Page) | Exact Quote (英文原句) |
| :--- | :--- | :--- | :--- |
| **Research Question** | [解决什么科学问题] | [Section / Page] | \`[Exact Quote: "..."]\` |
| **Core Method** | [实验手段/分析方法] | [Section / Page] | \`[Exact Quote: "..."]\` |
| **Key Findings** | [核心定性结论与机制] | [Section / Page] | \`[Exact Quote: "..."]\` |

### 2. 🎯 10 维学术全景初审矩阵 (10-Dimensional Comprehensive Audit Matrix)
*必须完整列出全部 10 个维度，结合海洋地球化学专业标准逐一评估*：
| 审查维度 | 评估评级 (Clear / Vulnerable / Unstated) | 原文凭据与位置 [Exact Quote] | 审稿人专业审查意见与潜在漏洞 (Critique & Red Flags) |
| :--- | :--- | :--- | :--- |
| **1. 研究问题** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [具体审查意见] |
| **2. 文献讨论** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [具体审查意见] |
| **3. 研究假设** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [具体审查意见] |
| **4. 研究设计** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [具体审查意见] |
| **5. 数据与样本** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [具体审查意见] |
| **6. 变量测量与QA/QC** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [必须核查空白、CRM、检测限] |
| **7. 样品采集与保存** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [必须核查过滤、酸化、瓶壁溶出] |
| **8. 数据分析与统计** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [具体审查意见] |
| **9. 解读与过度推导** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [必须核查是否存在局部外推全球 Overstatement] |
| **10. 局限与盲区** | Clear / Vulnerable / Unstated | \`[Exact Quote: "..."]\` | [具体审查意见] |

### 3. 📊 硬核定量数据与质量控制核验表 (Hard Data & QA/QC Check)
| 关键变量 / 参数 | 样本量 (n) | 均值 ± 误差 / 范围 | 质量控制 (Blank / CRM) | 采样深度 / 水团 | 数据来源 (Table/Fig/Text) 与 Exact Quote |
| :--- | :--- | :--- | :--- | :--- | :--- |

### 4. ⚖️ 审稿人终审裁决 (Reviewer Verdict & Key Major Concerns)
- **总体评级**：[Accept / Minor Revision / Major Revision / Reject]
- **Top 2 核心硬伤**：简要指明本篇文献在方法论与外推推论中最需警惕的问题。

---

## 【精读模式 (Deep Socratic Review)】输出规范
当用户选择【精读模式】或开启研讨时，你扮演一位在海洋科学与生物地球化学领域具有深厚学术积淀、极其严谨的资深学术导师与顶级期刊（Nature Geoscience, GCA, L&O 等）同行评审专家。
你的核心目标是：**绝不代替用户做单向信息概括**，而是通过【苏格拉底式追问】、【费曼研讨法】与【深度推敲闭环】，引导用户批判性地拆解文献的机理逻辑、实验设计与学术叙事策略（Storytelling），并内化为用户自身的科研洞见与学术审美。

---

### Step 0: Initialization (启动引导)
当开启研讨或进入【精读模式】时，请仅回复欢迎语，并提示用户提供以下信息（在此之前严禁输出任何文献分析）：
1. **【目标文献全文/核心段落/图表】（必填）**
2. **【文献类型判定】（必选）**：A. 实证观测/实验；B. 理论模型/数值模拟；C. 综述与前沿观点
3. **【我的研究背景与关注方向】（可选）**：关注的化学组分/介质/海区尺度/机理猜想；若无请填“探索中”
4. **【我已有的实验/数据认知】（可选）**：已有测试手段、反常数据、预实验现象

---

### ⚠️ 绝对执行铁律：状态转移“硬锁”机制 (State Machine Hard Lock)
1. **【严禁擅自抢跑】**：**除非用户的最新回复中明确包含指令词“【进入下一轮】”或“【进入 Round X】”，否则你绝对严禁输出下一轮的任何内容或标题！** 即使你认为上一轮探讨已经非常严密，也必须停留在当前轮次等待指令。
2. **【轮内深度推敲与达标判定】**：
   - 在用户未发送通行令前，持续停留在当前 Round 展开研讨。
   - **若用户回答存在漏洞**：输出【逻辑红笔点评】并紧跟【1 个精准追击问】或【反向质疑】。
   - **若用户回答已逻辑闭环且严密**：输出【学术肯定与共识提炼】，不再刁难追问，并显式提示：“*本轮逻辑已严密闭环，请回复【进入下一轮】以开启新维度。*”
3. **【概念求助随时响应】**：无论在第几轮，只要用户输入“【概念求助：XXX】”，立刻暂停当前追问，用生动的“物理图景和大白话”讲透该机制/术语，讲完后等待用户确认理解并继续当前轮次。
4. **【卡壳启发通道】**：若用户在某问上卡壳并输入“【给个提示】”，请提供 1~2 个关键物理/化学线索或对比视角，引导用户补齐推导。

---

### Multi-Turn Workflow (4 大研讨维度)

- **第一轮：科学矛盾、前沿缺口与假说 (Round 1/4 - 培养学术审美与立论格局)**
  - **【客观证据锚定】**：提炼作者拟解决的核心矛盾（Gap）、必读理论依据与核心驱动假说。英文原句引用 \`[Exact Quote: "..."]\`。
  - **【💡 核心物理/化学概念脚手架】**：针对文献中 1~2 个关键术语/缩写（如 AO、TPD、碳酸盐补偿、同位素分馏假定等），用一句话大白话给出物理图像。
  - **【学术审美与苏格拉底 Why-Chains 追问（动态 2~4 问）】**：
    - **动机溯源 (Motivation Why)**：为什么作者认为该海区/特定化学组分的这一反常现象是关键突破口？前人为什么忽略了或没能解决？
    - **假说之美 (Hypothesis Elegance)**：作者提出的机制假说精妙在哪里？它如何打破或修正了传统认知？
    - **第一性原理与费曼转述 (First Principle)**：强制用户用最通俗直白的大白话（不堆砌术语），讲清底层因果链条与研究的必要性。
- **第二轮：实验质控、机制推导与叙事链条 (Round 2/4)**
  - **【承前启后】**：用 1 句话将 Round 1 达成的核心机理与本轮的方法/设计进行逻辑衔接。
  - **【客观证据锚定】**：提炼采样/观测尺度、测试质控（空白、检出限、标样校正）、对照组或核心图表（如 Profile/Section 图）推进链。
  - **【💡 方法/参数概念脚手架】**：若涉及复杂分析手段（如 eOMP、端元分析、动力学模型），用 1 句话讲清其本质逻辑。
  - **【方法与故事线追问】**：追问数据链条是否排他性地支持机制？是否存在替代解释？解构 Figure 1 到主要结论图的叙事推进逻辑。
- **第三轮：假想敌审视与局限突破 (Round 3/4)**
  - **【承前启后】**：承接 Round 2 的数据链条，切入其未言明或承认的薄弱点。
  - **【客观证据锚定】**：列出 Discussion/Limitation 中的不足与防弹修辞。
  - **【同行评审式交锋】**：扮演刁钻审稿人，指出时空分辨率、前置假设或方法漏洞，追问用户的改进方案与反常认知比对。
- **第四轮：学术叙事升华与综合写作 (Round 4/4)**
  - **【承前启后】**：将前面拆解的机理与方法局限，升华至学术大脉络。
  - **【综合产出引导】**：解构作者如何将具体数据融入全球学术大对话（Big Conversation），并要求用户写出 150 字的高质量文献综合段落（Synthesis）。

---

### Execution Guardrails & Response Templates (回复规范与模板)

1. **【场景 A：收到用户的研讨回答时（轮内推敲模板）】**：
   - 必须先输出 \`### 🎯 【逻辑红笔点评】\`（指出回答中的逻辑漏洞、表述不严密处，或提炼已达标的逻辑亮点）。
   - 紧接着输出 \`### 📌 【追击短问 / 达标确认】\`（若有漏洞则发起精准追问；若已闭环则做共识总结并邀请推进）。
   - 文末标注：\`*(当前状态: Round X/4 轮内打磨中 | 若已通透请回复【进入下一轮】)*\`。

2. **【场景 B：收到【进入下一轮】指令时（跨轮推进模板）】**：
   - 第一句话必须是 \`【逻辑衔接】\`，清晰阐明本轮议题如何建立在上一轮研讨结论的基础之上。
   - 严格展开本轮的【客观证据锚定】、【概念脚手架】与【追问】。

3. **【场景 C：收到【概念求助：XXX】指令时】**：
   - 暂停当前追问，输出 \`### 💡 【概念深度破译与物理图景】\`，用生动比喻与物理图像彻底剖析。
   - 结尾提示：\`*(是否理解清晰？确认后请输入【进入下一轮】或继续回答上一问)*\`。

4. **【场景 D：第 4 轮闭环并收到【完成研讨】指令时（文献笔记卡片生成）】**：
   - 输出结构化 Markdown 卡片，汇总本次研讨的核心资产：
     - **1. 科学矛盾与驱动假说**（含必读文献）
     - **2. 实验质控与图表逻辑链**
     - **3. 审稿人视角局限与我的改进设计**
     - **4. 学术故事线（Storyline）亮点**
`;

// 应用状态
let currentMode: 'rapid' | 'deep' = 'rapid';
let apiKey = localStorage.getItem('gemini_api_key') || (import.meta.env.VITE_GEMINI_API_KEY as string) || '';
let chatHistory: Array<{ role: 'user' | 'assistant'; content: string; mode?: string }> = [];
let uploadedPdfText = '';
let uploadedPdfName = '';
let uploadedPdfSectionSummary = '';
let isGenerating = false;
let scholarResults: ScholarPaper[] = [];
let isSearchingScholar = false;

/** 初始化应用骨架 (仅执行一次) */
function initApp() {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="app-container">
      <header class="app-header">
        <div class="header-title">
          <div class="logo">🎏</div>
          <div>
            <h1>Ocean Geochemistry AI Literature Coach</h1>
            <p class="subtitle">海洋与地球化学文献研读教练 (Exact Quotes & 10-Dimension Deep Review)</p>
          </div>
        </div>
        <div class="header-actions">
          <div class="api-key-box">
            <select id="model-select" style="background:var(--bg-main); border:1px solid var(--border-subtle); border-radius:4px; padding:0.35rem 0.6rem; font-size:0.78rem; color:var(--text-primary);">
              <option value="gemini-3.6-flash" selected>Gemini 3.6 Flash (推荐·高效强劲)</option>
              <option value="gemini-2.0-flash">Gemini 2.0 Flash (高速稳定)</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash (高智能)</option>
              <option value="gemini-2.5-pro">Gemini 2.5 Pro (深度分析)</option>
              <option value="custom">✍️ 自定义模型名称...</option>
            </select>
            <input type="text" id="custom-model-input" placeholder="输入自定义模型 ID..." style="display:none; width:130px; background:var(--bg-main); border:1px solid var(--border-subtle); border-radius:4px; padding:0.35rem 0.5rem; font-size:0.78rem;" />
            <input type="password" id="api-key-input" placeholder="Gemini API Key..." value="${apiKey}" />
            <button id="save-key-btn">保存 Key</button>
          </div>
        </div>
      </header>

      <div class="main-layout">
        <!-- 左侧面板 -->
        <aside class="sidebar">
          <!-- 学术文献直连搜索模块 -->
          <div class="panel-card">
            <h3>🔍 学术文献库直连 (Scholar & Crossref)</h3>
            <p class="panel-hint">输入关键词或 DOI，实时调取文献库元数据并直连 Google Scholar：</p>
            <div class="scholar-search-box">
              <input type="text" id="scholar-query" placeholder="如: Microbial Carbon Pump DOC..." />
              <button id="scholar-search-btn">搜索文献 🔍</button>
            </div>
            <div class="scholar-results" id="scholar-results-container">
              <div class="no-results-hint">可在上方输入关键词，直接调取全球海洋地球化学文献库。</div>
            </div>
          </div>

          <!-- PDF 上传区 -->
          <div class="panel-card">
            <h3>📄 论文 PDF 上传解析 (全篇结构感知)</h3>
            <p class="panel-hint">自动解析章节结构、过滤页眉杂音，为 10 维审稿提取 Exact Quote：</p>
            <div class="pdf-upload-box" id="pdf-dropzone">
              <input type="file" id="pdf-file-input" accept=".pdf" />
              <div class="pdf-upload-content">
                <span class="pdf-icon">📤</span>
                <span class="upload-text">点击或拖拽上传 PDF 文献</span>
                <span class="upload-subtext">自动识别 Abstract / Methods / Results / Discussion</span>
              </div>
            </div>
            <div class="pdf-status" id="pdf-status-container"></div>
          </div>

          <!-- 研读模式选择 -->
          <div class="panel-card">
            <h3>🎛️ 研读模式 (Mode & Strategy)</h3>
            <div class="mode-selector" id="mode-selector-container">
              ${MODES.map(
                (m) => `
                <div class="mode-card ${currentMode === m.id ? 'active' : ''}" data-mode="${m.id}">
                  <div class="mode-header">
                    <span class="mode-name">${m.name}</span>
                    <span class="temp-badge">${m.sampling}</span>
                  </div>
                  <p class="mode-desc">${m.desc}</p>
                </div>
              `
              ).join('')}
            </div>
          </div>

          <!-- 10 维学术审查框架 -->
          <div class="panel-card">
            <h3>🎯 10 维学术审查框架</h3>
            <div class="ten-dim-list">
              ${TEN_DIMENSIONS.map((dim) => `<div class="dim-tag">${dim}</div>`).join('')}
            </div>
          </div>

          <!-- Benchmark 测试案例 -->
          <div class="panel-card">
            <h3>🧪 Benchmark 测试案例</h3>
            <div class="test-cases">
              <button class="test-btn" id="load-test-1">
                📌 Case 1: DOC 空白与 Exact Quote 提取
              </button>
              <button class="test-btn" id="load-test-2">
                📌 Case 2: MCP 外推与 Overstatement 审查
              </button>
            </div>
          </div>
        </aside>

        <!-- 聊天主区域 -->
        <main class="chat-area">
          <div class="chat-toolbar">
            <span id="chat-status-text">
              💡 当前模式：<strong id="current-mode-label">${
                currentMode === 'rapid'
                  ? '【泛读模式】10维全景初审与硬数据核查 (T=0.0)'
                  : '【精读模式】锁定致命漏洞与苏格拉底考问 (T=0.3)'
              }</strong>
            </span>
            <button class="toolbar-btn" id="clear-chat-btn">🗑️ 清空对话</button>
          </div>

          <div class="chat-messages" id="chat-messages">
            <div class="welcome-box" id="welcome-box">
              <h2>静寂・严谨・学术文献库直连</h2>
              <p>可通过左侧搜索框直连文献库调取论文，或上传 PDF/粘贴片段开展 10 维 Peer Review。</p>
              <div class="quick-tips">
                <span>💡 提示：按 <strong>Ctrl + Enter</strong> 或 <strong>Cmd + Enter</strong> 可快捷发送。</span>
              </div>
            </div>
          </div>

          <div class="input-container">
            <textarea id="user-input" placeholder="粘贴论文片段、提出答辩反思，或上传 PDF 后直接点击发送 (Ctrl+Enter 发送)..."></textarea>
            <div class="input-actions">
              <span class="mode-indicator" id="mode-indicator">
                当前策略: ${currentMode === 'rapid' ? 'GREEDY (T=0.0)' : 'SOCRATIC MENTOR (T=0.3)'}
              </span>
              <div style="display:flex; gap:0.5rem; align-items:center;">
                <button id="recall-last-btn" class="toolbar-btn" style="padding:0.35rem 0.65rem; font-size:0.78rem;" title="将上一条发送的内容载入输入框">✏️ 载入上条输入</button>
                <button id="send-btn">发送研读请求 🚀</button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  `;

  bindAllEvents();
  updatePdfUI();
  updateModeUI();
}

/** 事件绑定 */
function bindAllEvents() {
  // API Key 保存
  document.getElementById('save-key-btn')?.addEventListener('click', () => {
    const input = document.getElementById('api-key-input') as HTMLInputElement;
    if (input) {
      apiKey = input.value.trim();
      localStorage.setItem('gemini_api_key', apiKey);
      if (apiKey) {
        showToast('✅ Gemini API Key 已成功保存！发送消息将调用官方 API 实时分析。');
      } else {
        showToast('ℹ️ API Key 已清空，系统已切换为【演示/模拟分析模式】。');
      }
    }
  });

  // 模型选择切换
  const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
  const customModelInput = document.getElementById('custom-model-input') as HTMLInputElement;
  const savedModel = localStorage.getItem('gemini_model') || 'gemini-2.0-flash';

  if (modelSelect) {
    if (['gemini-3.6-flash', 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'].includes(savedModel)) {
      modelSelect.value = savedModel;
    } else if (savedModel) {
      modelSelect.value = 'custom';
      if (customModelInput) {
        customModelInput.style.display = 'inline-block';
        customModelInput.value = savedModel;
      }
    }

    modelSelect.addEventListener('change', () => {
      if (modelSelect.value === 'custom') {
        if (customModelInput) {
          customModelInput.style.display = 'inline-block';
          customModelInput.focus();
        }
      } else {
        if (customModelInput) customModelInput.style.display = 'none';
        localStorage.setItem('gemini_model', modelSelect.value);
        showToast(`已切换模型为: ${modelSelect.value}`);
      }
    });
  }

  customModelInput?.addEventListener('change', () => {
    const customVal = customModelInput.value.trim();
    if (customVal) {
      localStorage.setItem('gemini_model', customVal);
      showToast(`已设定自定义模型: ${customVal}`);
    }
  });

  // Crossref 学术搜索
  document.getElementById('scholar-search-btn')?.addEventListener('click', handleScholarSearch);
  document.getElementById('scholar-query')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleScholarSearch();
  });

  // 模式切换卡片
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      const mode = card.getAttribute('data-mode') as 'rapid' | 'deep';
      if (mode && mode !== currentMode) {
        currentMode = mode;
        updateModeUI();
        onModeChanged(mode);
      }
    });
  });

  // PDF 文件上传 (点击)
  const pdfInput = document.getElementById('pdf-file-input') as HTMLInputElement;
  pdfInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) await handlePdfFile(file);
    pdfInput.value = ''; // 清空以允许重复上传同一文件
  });

  // PDF 拖拽上传 (Drag & Drop)
  const dropzone = document.getElementById('pdf-dropzone');
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          await handlePdfFile(file);
        } else {
          alert('请上传 PDF 格式的学术文献。');
        }
      }
    });
  }

  // Benchmark 测试用例
  document.getElementById('load-test-1')?.addEventListener('click', () => {
    currentMode = 'rapid';
    updateModeUI();
    const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
    if (textarea) {
      textarea.value = `【泛读模式】请对以下海洋地球化学论文片段开展全篇 10 维事实核算与 QA/QC 检查：\nTitle: Rapid Accumulation of Refractory Dissolved Organic Carbon in Global Deep Ocean\nAbstract [Page 1]: "The refractory dissolved organic carbon (RDOC) reservoir in the global ocean represents a major carbon sink. Here we report rapid RDOC accumulation rates across the North Pacific deep ocean."\nMethods Snippet [Section 2.2 / Page 3]: "DOC concentration was measured using a High-Temperature Catalytic Oxidation (HTCO) system (Shimadzu TOC-L). Samples were filtered through 0.45 μm PTFE filters and stored at -20°C in polyethylene (PE) bottles. Instrument blank was checked using Milli-Q water before each run batch. Deep sea reference water was measured occasionally."\nResults Snippet [Section 3.1 & Table 2 / Page 5]: "Deep water DOC concentrations averaged 54 ± 2 μmol/L across all 15 stations in the North Pacific (p < 0.05)."\nDiscussion Snippet [Section 4.1 / Page 7]: "Our findings suggest deep ocean RDOC is highly dynamic, though potential container leaching effects remain unquantified."`;
      textarea.focus();
    }
  });

  document.getElementById('load-test-2')?.addEventListener('click', () => {
    currentMode = 'deep';
    updateModeUI();
    const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
    if (textarea) {
      textarea.value = `【精读研讨初始化】\n1. 【目标文献】：Microbial Carbon Pump Driven Refractory DOC Production Rates in Marine Ecosystems\n2. 【我的研究背景与课题方向】：关注大洋碳循环与微型生物碳泵(MCP)机理，当前拟探讨难降解DOC产率\n3. 【我已有的实验/数据认知】：实验室具备HTCO与氨基酸手性测定手段`;
      textarea.focus();
    }
  });

  // 输入框快捷键 (Ctrl+Enter / Cmd+Enter 发送)
  const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
  textarea?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  });

  // 发送按钮
  document.getElementById('send-btn')?.addEventListener('click', handleSend);

  // 载入上条输入按钮
  document.getElementById('recall-last-btn')?.addEventListener('click', () => {
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      if (chatHistory[i].role === 'user' && chatHistory[i].content) {
        const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
        if (textarea) {
          textarea.value = chatHistory[i].content;
          textarea.focus();
          showToast('✏️ 已载入上一条发送内容，修改后点击发送即可！');
          return;
        }
      }
    }
    showToast('ℹ️ 暂无历史发送记录。');
  });

  // 清空对话
  document.getElementById('clear-chat-btn')?.addEventListener('click', () => {
    if (chatHistory.length === 0) return;
    if (confirm('确定要清空当前对话记录吗？')) {
      chatHistory = [];
      updateChatUI();
    }
  });
}

/** 模式 UI 局部更新 */
function updateModeUI() {
  document.querySelectorAll('.mode-card').forEach((card) => {
    const mode = card.getAttribute('data-mode');
    if (mode === currentMode) {
      card.classList.add('active');
    } else {
      card.classList.remove('active');
    }
  });

  const modeLabel = document.getElementById('current-mode-label');
  if (modeLabel) {
    modeLabel.textContent =
      currentMode === 'rapid'
        ? '【泛读模式】10维全景初审与硬数据核查 (T=0.0)'
        : '【精读模式】启发式导师与 4 轮苏格拉底研讨 (T=0.3)';
  }

  const modeIndicator = document.getElementById('mode-indicator');
  if (modeIndicator) {
    modeIndicator.textContent = `当前策略: ${
      currentMode === 'rapid' ? 'GREEDY (T=0.0)' : 'SOCRATIC MENTOR (T=0.3)'
    } ${uploadedPdfName ? `| 📄 已载入: ${uploadedPdfName} (${uploadedPdfText.length.toLocaleString()}字)` : ''}`;
  }
}

/** 研读模式切换后的逻辑与互动引导 */
function onModeChanged(newMode: 'rapid' | 'deep') {
  if (newMode === 'deep') {
    // 检查最后一条消息是否包含精读引导，避免重复推送
    const lastMsg = chatHistory[chatHistory.length - 1];
    if (!lastMsg || !lastMsg.content.includes('【精读模式已激活')) {
      const noticeContent = `### 🎓 【精读模式已激活 · 学术导师苏格拉底研讨】

已成功切换至 **【精读模式】**。在此模式下，系统将化身为**海洋科学与生物地球化学领域资深学术导师与同行评审专家**，通过【苏格拉底式追问】、【费曼研讨法】与【深度推敲闭环】，引导您批判性地拆解文献机理、实验设计与叙事策略。

---

#### 📋 Step 0: Initialization (启动引导)：

1. **【目标文献全文/核心段落/图表】（必填）**：上传 PDF 或粘贴文献核心内容。
2. **【文献类型判定】（必选）**：A. 实证观测/实验；B. 理论模型/数值模拟；C. 综述与前沿观点。
3. **【我的研究背景与关注方向】（可选）**：关注的化学组分/介质/海区尺度/机理猜想；若无请填“探索中”。
4. **【我已有的实验/数据认知】（可选）**：已有测试手段、反常数据、预实验现象。

<div class="mode-switch-card">
  <div class="mode-switch-header">🚀 4 轮状态推进研讨通道与指令硬锁</div>
  <div class="mode-switch-desc">${uploadedPdfName ? `针对已载入文献《${uploadedPdfName}》，` : ''}包含【进入下一轮】解锁、卡壳【给个提示】与【概念求助】：</div>
  <div class="quick-action-chips">
    <button class="chip-btn" id="chip-init-info">📝 填入 Step 0 启动引导模板</button>
    <button class="chip-btn" id="chip-next-round" style="background:#e8f4ff; border-color:var(--accent-indigo); font-weight:600;">🔓 【进入下一轮】 (解锁轮次硬锁)</button>
    <button class="chip-btn" id="chip-give-tip" style="background:#f0fdf4; border-color:#16a34a; color:#15803d;">🧩 【给个提示】</button>
    <button class="chip-btn" id="chip-concept-help" style="background:#fff8e6; border-color:#d97706; color:#b45309;">💡 【概念求助：XXX】</button>
    <button class="chip-btn" id="chip-finish-review" style="background:#fcf4ff; border-color:#9333ea; color:#7e22ce;">🏁 【完成研讨】 (生成文献卡片)</button>
    <button class="chip-btn" id="chip-round-1">1️⃣ Round 1: 科学矛盾、缺口与假说</button>
    <button class="chip-btn" id="chip-round-2">2️⃣ Round 2: 质控、机制推导与叙事</button>
    <button class="chip-btn" id="chip-round-3">3️⃣ Round 3: 假想敌与局限突破</button>
    <button class="chip-btn" id="chip-round-4">4️⃣ Round 4: 叙事升华与综合写作</button>
  </div>
</div>`;

      chatHistory.push({
        role: 'assistant',
        content: noticeContent,
        mode: 'deep',
      });
      updateChatUI();
    }
  } else {
    showToast('💡 已切换为【泛读模式】：聚焦全篇 10 维初审矩阵与硬数据核验。');
  }
}

/** 绑定精读互动快捷按钮事件 */
function bindChipEvents() {
  document.querySelectorAll('#chip-init-info').forEach((btn) => {
    btn.addEventListener('click', () => {
      const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
      if (textarea) {
        textarea.value = uploadedPdfName
          ? `【精读研讨 Step 0 启动】\n1. 【目标文献全文/核心段落/图表】：已载入《${uploadedPdfName}》\n2. 【文献类型判定】：A. 实证观测/实验\n3. 【我的研究背景与关注方向】：[关注的化学组分/介质/海区尺度/机理猜想，若无填“探索中”]\n4. 【我已有的实验/数据认知】：[已有测试手段、反常数据、预实验现象]`
          : `【精读研讨 Step 0 启动】\n1. 【目标文献全文/核心段落/图表】：[请在此贴入文献内容/标题]\n2. 【文献类型判定】：A. 实证观测/实验\n3. 【我的研究背景与关注方向】：[关注的化学组分/介质/海区尺度/机理猜想，若无填“探索中”]\n4. 【我已有的实验/数据认知】：[已有测试手段、反常数据、预实验现象]`;
        textarea.focus();
        showToast('已填入 Step 0 启动引导模板，补充信息后点击发送即可启动！');
      }
    });
  });

  // 快捷解锁进入下一轮
  document.querySelectorAll('#chip-next-round').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleSendWithCustomContent('【进入下一轮】');
    });
  });

  // 快捷卡壳请求提示
  document.querySelectorAll('#chip-give-tip').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleSendWithCustomContent('【给个提示】');
    });
  });

  // 快捷完成研讨生成文献卡片
  document.querySelectorAll('#chip-finish-review').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleSendWithCustomContent('【完成研讨】');
    });
  });

  // 快捷发起概念求助
  document.querySelectorAll('#chip-concept-help').forEach((btn) => {
    btn.addEventListener('click', () => {
      const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
      if (textarea) {
        textarea.value = '【概念求助：请在此输入您困惑的专业术语/公式/生化机制】';
        textarea.focus();
        textarea.setSelectionRange(6, textarea.value.length - 1);
        showToast('💡 请替换具体术语后发送，导师将用物理图景与大白话深度解惑！');
      }
    });
  });

  document.querySelectorAll('#chip-round-1').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleSendWithCustomContent(
        uploadedPdfName
          ? `【Round 1/4: 科学矛盾、前沿缺口与假说】：针对文献《${uploadedPdfName}》，请提炼拟解决的核心矛盾（Gap）、理论依据（英文 Exact Quote）及驱动假说，并提出 2 个尖锐的苏格拉底追问！`
          : `【Round 1/4: 科学矛盾、前沿缺口与假说】：请提炼拟解决的核心矛盾（Gap）、理论依据（英文 Exact Quote）及驱动假说，并提出 2 个尖锐的苏格拉底追问！`
      );
    });
  });

  document.querySelectorAll('#chip-round-2').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleSendWithCustomContent(
        uploadedPdfName
          ? `【Round 2/4: 实验质控、机制推导与叙事链条】：针对文献《${uploadedPdfName}》，请用 1 句话逻辑衔接，提炼采样/观测尺度、质控（空白/检出限/标样）、对照组与 Figure 叙事链条并追问排他性机制！`
          : `【Round 2/4: 实验质控、机制推导与叙事链条】：请用 1 句话逻辑衔接，提炼采样/观测尺度、质控（空白/检出限/标样）、对照组与 Figure 叙事链条并追问排他性机制！`
      );
    });
  });

  document.querySelectorAll('#chip-round-3').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleSendWithCustomContent(
        uploadedPdfName
          ? `【Round 3/4: 假想敌审视与局限突破】：针对文献《${uploadedPdfName}》，请承接数据链条，列出 Discussion/Limitation 薄弱点与防弹修辞，并扮演刁钻审稿人进行交锋！`
          : `【Round 3/4: 假想敌审视与局限突破】：请承接数据链条，列出 Discussion/Limitation 薄弱点与防弹修辞，并扮演刁钻审稿人进行交锋！`
      );
    });
  });

  document.querySelectorAll('#chip-round-4').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleSendWithCustomContent(
        uploadedPdfName
          ? `【Round 4/4: 学术叙事升华与综合写作】：针对文献《${uploadedPdfName}》，请将机理与局限升华至学术大脉络，解构全球学术大对话，并引导我完成 150 字 Synthesis 段落！`
          : `【Round 4/4: 学术叙事升华与综合写作】：请将机理与局限升华至学术大脉络，解构全球学术大对话，并引导我完成 150 字 Synthesis 段落！`
      );
    });
  });
}

/** 使用自定义输入自动发送 */
async function handleSendWithCustomContent(customPrompt: string) {
  const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.value = customPrompt;
  }
  await handleSend();
}

/** 根据当前模式与用户输入动态获取加载占位提示 */
function getLoadingPlaceholderText(userPrompt?: string): string {
  if (currentMode === 'deep') {
    if (userPrompt && (userPrompt.includes('考问') || userPrompt.includes('挑战') || userPrompt.includes('答辩'))) {
      return '🛡️ 正在梳理论文致命漏洞与构思苏格拉底考问... ⏳';
    }
    if (userPrompt && (userPrompt.includes('追问') || userPrompt.includes('问') || userPrompt.includes('请教'))) {
      return '🛡️ 正在深入剖析方法论并思考审稿对策... ⏳';
    }
    return '🛡️ 正在进行精读深度思考与方法论剖析... ⏳';
  } else {
    if (userPrompt && (userPrompt.includes('追问') || userPrompt.includes('问') || userPrompt.includes('请教') || userPrompt.includes('解释'))) {
      return '🌊 正在跨章节检索文献证据与分析深度解答... ⏳';
    }
    return '🔍 正在全篇严密核验文献与提取 10 维证据链... ⏳';
  }
}

/** 根据当前模式获取发送按钮加载文字 */
function getLoadingBtnText(): string {
  if (currentMode === 'deep') {
    return '正在精读思考中 ⏳';
  }
  return '正在 10 维核查中 ⏳';
}

/** PDF 上传状态局部更新 */
function updatePdfUI() {
  const container = document.getElementById('pdf-status-container');
  if (!container) return;

  if (uploadedPdfName) {
    container.innerHTML = `
      <div class="pdf-file-info">
        <div>
          <div>📄 <strong>${uploadedPdfName}</strong> (${uploadedPdfText.length.toLocaleString()} 字)</div>
          ${uploadedPdfSectionSummary ? `<div style="font-size:0.68rem; color:var(--text-secondary); margin-top:2px;">📑 识别章节: ${uploadedPdfSectionSummary}</div>` : ''}
        </div>
        <button class="clear-pdf-btn" id="clear-pdf-btn" title="移除此 PDF">✕</button>
      </div>
    `;
    document.getElementById('clear-pdf-btn')?.addEventListener('click', () => {
      uploadedPdfText = '';
      uploadedPdfName = '';
      uploadedPdfSectionSummary = '';
      updatePdfUI();
      updateModeUI();
      showToast('已移除上传的 PDF 文献。');
    });
  } else {
    container.innerHTML = '';
  }
  updateModeUI();
}

/** 学术文献搜索结果局部更新 */
function updateScholarUI() {
  const container = document.getElementById('scholar-results-container');
  const btn = document.getElementById('scholar-search-btn') as HTMLButtonElement;
  if (btn) {
    btn.disabled = isSearchingScholar;
    btn.textContent = isSearchingScholar ? '检索中...' : '搜索文献 🔍';
  }

  if (!container) return;

  if (scholarResults.length === 0) {
    container.innerHTML = `<div class="no-results-hint">可在上方输入关键词，直接调取全球海洋地球化学文献库。</div>`;
    return;
  }

  container.innerHTML = scholarResults
    .map(
      (p, idx) => `
    <div class="scholar-card">
      <div class="scholar-title">${p.title}</div>
      <div class="scholar-meta">${p.authors} (${p.year}) • <em>${p.journal}</em></div>
      <div class="scholar-actions">
        <button class="import-paper-btn" data-idx="${idx}">📥 导入研读</button>
        <a href="${p.scholarUrl}" target="_blank" class="scholar-link-btn">🔗 Google Scholar</a>
      </div>
    </div>
  `
    )
    .join('');

  // 重新绑定导入按钮
  container.querySelectorAll('.import-paper-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt((e.currentTarget as HTMLElement).getAttribute('data-idx') || '0', 10);
      const paper = scholarResults[idx];
      if (!paper) return;

      const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
      if (textarea) {
        textarea.value = `【文献库调取研读】\nTitle: ${paper.title}\nAuthors: ${paper.authors}\nJournal: ${paper.journal} (${paper.year})\nDOI: ${paper.doi}\nAbstract: "${paper.abstract || '（调取摘要中...）'}"\n\n请对此文献开展 10 维学术初审与定量核算。`;
        textarea.focus();
        showToast('已将文献元数据填入输入框，点击发送即可开始分析。');
      }
    });
  });
}

/** 聊天列表局部更新 */
function updateChatUI() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  if (chatHistory.length === 0) {
    container.innerHTML = `
      <div class="welcome-box" id="welcome-box">
        <h2>静寂・严谨・学术文献库直连</h2>
        <p>可通过左侧搜索框直连文献库调取论文，或上传 PDF/粘贴片段开展 10 维 Peer Review。</p>
        <div class="quick-tips">
          <span>💡 提示：按 <strong>Ctrl + Enter</strong> 或 <strong>Cmd + Enter</strong> 可快捷发送。</span>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = chatHistory
    .map(
      (msg, i) => `
    <div class="message ${msg.role}" data-index="${i}">
      <div class="message-avatar">${msg.role === 'user' ? '👤' : '🌊'}</div>
      <div class="message-wrapper">
        <div class="message-content markdown-body${
          isGenerating && i === chatHistory.length - 1 && msg.role === 'assistant' ? ' streaming' : ''
        }">
          ${msg.content ? safeMarkdown(msg.content) : `<span style="color:var(--text-muted)">${getLoadingPlaceholderText(chatHistory[i - 1]?.content)}</span>`}
        </div>
        <div class="message-actions">
          ${
            msg.role === 'user'
              ? `<button class="msg-action-btn edit-user-btn" data-idx="${i}" title="将此条发送内容载入输入框重新修改">✏️ 修改并载入输入框</button>
                 <button class="msg-action-btn copy-btn" data-idx="${i}">📋 复制</button>`
              : msg.content
              ? `<button class="msg-action-btn copy-btn" data-idx="${i}">📋 复制 Markdown</button>
                 <button class="msg-action-btn export-btn" data-idx="${i}">💾 导出为 .md</button>`
              : ''
          }
        </div>
      </div>
    </div>
  `
    )
    .join('');

  // 绑定用户消息编辑与载入按钮
  container.querySelectorAll('.edit-user-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt((e.currentTarget as HTMLElement).getAttribute('data-idx') || '0', 10);
      const text = chatHistory[idx]?.content || '';
      if (text) {
        const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
        if (textarea) {
          textarea.value = text;
          textarea.focus();
          textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
          showToast('✏️ 已将该条发送内容载入输入框，修改后点击发送即可！');
        }
      }
    });
  });

  // 绑定复制与导出按钮
  container.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt((e.currentTarget as HTMLElement).getAttribute('data-idx') || '0', 10);
      const text = chatHistory[idx]?.content || '';
      if (text) {
        navigator.clipboard.writeText(text).then(() => {
          showToast('✅ 已复制 Markdown 到剪贴板！');
        });
      }
    });
  });

  container.querySelectorAll('.export-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt((e.currentTarget as HTMLElement).getAttribute('data-idx') || '0', 10);
      const text = chatHistory[idx]?.content || '';
      if (text) {
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Ocean_Geochem_Review_${new Date().toISOString().slice(0, 10)}.md`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('💾 已导出 Markdown 文件！');
      }
    });
  });

  bindChipEvents();
  scrollToBottom();
}

/** 增量更新最后一条 Assistant 消息 (用于流式渲染) */
function updateLastMessageContent(markdownText: string) {
  const chatContainer = document.getElementById('chat-messages');
  if (!chatContainer) return;
  const lastMsg = chatContainer.querySelector('.message.assistant:last-child .message-content');
  if (lastMsg) {
    lastMsg.innerHTML = safeMarkdown(markdownText);
  }
}

/** 滚动到底部 */
function scrollToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

/** Toast 轻量消息通知 */
function showToast(message: string) {
  const oldToast = document.querySelector('.app-toast');
  if (oldToast) oldToast.remove();

  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 2400);
}

/** PDF 核心解析 (优化多栏排版、页眉页脚降噪与章节结构化提取) */
async function handlePdfFile(file: File) {
  const container = document.getElementById('pdf-status-container');
  if (container) {
    container.innerHTML = `<div class="pdf-status" style="color:var(--accent-indigo)">⏳ 正在高保真解析 PDF 学术排版与全篇章节...</div>`;
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    const detectedSections: string[] = [];

    // 常见章节正则表达式
    const sectionRegex = /^(abstract|introduction|materials and methods|methods|results|discussion|results and discussion|conclusions?|quality control|supporting information|references)/i;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      let lastY: number | null = null;
      let pageText = '';

      for (const item of textContent.items as any[]) {
        const currentY = item.transform?.[5] ?? 0;
        const str = (item.str || '').trim();

        // 过滤常见的单纯页码或冗余版权页眉
        if (/^(page \d+ of \d+|\d+\s*\|\s*www\.|\bdownloaded from\b)/i.test(str)) {
          continue;
        }

        // 章节标题检测
        if (sectionRegex.test(str) && str.length < 40) {
          const matched = str.toUpperCase();
          if (!detectedSections.includes(matched)) {
            detectedSections.push(matched);
          }
        }

        // 当 Y 坐标变化超过阈值时，换行以保留学术段落与表格结构
        if (lastY !== null && Math.abs(currentY - lastY) > 5) {
          pageText += '\n';
        } else if (pageText.length > 0 && !pageText.endsWith('\n') && !pageText.endsWith(' ')) {
          pageText += ' ';
        }
        pageText += item.str;
        lastY = currentY;
      }

      fullText += `\n\n[=== Page ${i} ===]\n` + pageText.trim() + '\n';
    }

    uploadedPdfText = fullText;
    uploadedPdfName = file.name;
    uploadedPdfSectionSummary = detectedSections.slice(0, 6).join(' / ') || '全文结构已解析';
    updatePdfUI();

    const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
    if (textarea && !textarea.value) {
      textarea.value = `请对已上传的海洋地球化学文献《${uploadedPdfName}》执行【${
        currentMode === 'rapid' ? '泛读模式：10维全景初审与硬数据核查' : '精读模式：锁定致命漏洞与苏格拉底考问'
      }】。`;
    }
    showToast(`✅ 成功解析《${file.name}》，共 ${pdf.numPages} 页，已建立全篇章节索引！`);
  } catch (err) {
    console.error('PDF 解析出错:', err);
    if (container) {
      container.innerHTML = `<div class="pdf-status" style="color:var(--accent-vermilion)">❌ PDF 解析失败，请检查文件是否加密或损坏。</div>`;
    }
  }
}

/** Crossref 学术搜索处理 (带 Polite Pool 请求优化) */
async function handleScholarSearch() {
  const inputEl = document.getElementById('scholar-query') as HTMLInputElement;
  if (!inputEl) return;
  const query = inputEl.value.trim();
  if (!query) return;

  isSearchingScholar = true;
  updateScholarUI();

  try {
    // 使用 mailto 接入 Crossref Polite Pool 提升稳定性与并发响应
    const apiUrl = `https://api.crossref.org/works?query=${encodeURIComponent(
      query
    )}&rows=5&mailto=ocean-researcher@academic-ai.org`;
    const res = await fetch(apiUrl);
    const data = await res.json();
    const items = data?.message?.items || [];

    scholarResults = items.map((item: any) => {
      const title = item.title?.[0] || 'Untitled Paper';
      const authors = item.author
        ? item.author
            .slice(0, 3)
            .map((a: any) => `${a.given || ''} ${a.family || ''}`.trim())
            .join(', ')
        : 'Unknown Authors';
      const journal = item['container-title']?.[0] || item.publisher || 'Academic Journal';
      const year =
        item.published?.['date-parts']?.[0]?.[0] || item['created']?.['date-parts']?.[0]?.[0] || 'N/A';
      const doi = item.DOI || '';
      const url = item.URL || `https://doi.org/${doi}`;
      const scholarUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`;
      const abstract = item.abstract ? item.abstract.replace(/<[^>]*>/g, '') : undefined;

      return { title, authors, journal, year: String(year), doi, url, scholarUrl, abstract };
    });
  } catch (err) {
    console.error('Crossref search error:', err);
    showToast('⚠️ 文献库检索服务网络波动，请稍后重试。');
  } finally {
    isSearchingScholar = false;
    updateScholarUI();
  }
}

/** 发送消息与流式响应处理 */
async function handleSend() {
  if (isGenerating) return;

  const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
  if (!textarea) return;
  let content = textarea.value.trim();

  if (!content && uploadedPdfText) {
    content = `请对已上传文献《${uploadedPdfName}》执行【${
      currentMode === 'rapid' ? '泛读模式：10维全景初审与硬数据核查' : '精读模式：锁定致命漏洞与苏格拉底考问'
    }】。`;
  }
  if (!content) return;

  // 清空输入框并更新状态
  textarea.value = '';

  // 若无 API Key，进入演示模拟模式
  if (!apiKey) {
    chatHistory.push({ role: 'user', content, mode: currentMode });
    updateChatUI();

    chatHistory.push({
      role: 'assistant',
      content: simulateAgentResponse(content, currentMode),
    });
    updateChatUI();
    return;
  }

  // 构建用户消息与对话历史
  const modeLabel = currentMode === 'rapid' ? '【泛读模式：10维全景初审与硬数据核查】' : '【精读模式：锁定致命漏洞与苏格拉底考问】';
  const userMessageText = `【当前执行模式】：${modeLabel}\n【用户需求与论文研读指令】：\n${content}`;

  chatHistory.push({ role: 'user', content, mode: currentMode });
  chatHistory.push({ role: 'assistant', content: '' });
  const assistantMsgIndex = chatHistory.length - 1;

  isGenerating = true;
  updateChatUI();
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = getLoadingBtnText();
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const selectedMode = MODES.find((m) => m.id === currentMode);

    // 注入系统指令与全篇结构化文献内容
    let dynamicSystem = SYSTEM_INSTRUCTION;
    if (uploadedPdfText) {
      const truncated =
        uploadedPdfText.length > MAX_PDF_CHARS
          ? uploadedPdfText.slice(0, MAX_PDF_CHARS) +
            `\n\n[--- 提示：论文文本已截断，仅载入前 ${MAX_PDF_CHARS.toLocaleString()} 字符 ---]`
          : uploadedPdfText;
      dynamicSystem += `\n\n# 【已载入文献全篇正文 · Full Paper Text & Sections】\n文件名：${uploadedPdfName}\n已识别结构：${uploadedPdfSectionSummary}\n\n${truncated}\n\n# 【文献正文结束 - 请务必跨章节扫描 Methods, QA/QC 与 Discussion 提取 10 维证据】`;
    }

    // 格式化多轮历史记录
    const contents = chatHistory
      .filter((m) => m.content !== '')
      .map((m, idx, arr) => {
        const isCurrent = idx === arr.length - 1 && m.role === 'user';
        return {
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: isCurrent ? userMessageText : m.content }],
        };
      });

    // 获取用户选中的模型或自定义模型 ID，并建立优雅降级备选列表
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
    const customModelInput = document.getElementById('custom-model-input') as HTMLInputElement;
    let primaryModel = modelSelect?.value || 'gemini-2.0-flash';
    if (primaryModel === 'custom') {
      primaryModel = customModelInput?.value.trim() || 'gemini-2.0-flash';
    }

    // 备用模型降级队列 (仅包含官方当前支持的有效模型)
    const fallbackModels = Array.from(
      new Set([primaryModel, 'gemini-3.6-flash', 'gemini-2.0-flash'])
    );

    let streamSuccess = false;
    let lastError: any = null;

    for (const modelCandidate of fallbackModels) {
      try {
        if (modelCandidate !== primaryModel) {
          showToast(`⚡ 模型 ${primaryModel} 繁忙，已自动切换为【${modelCandidate}】继续深度研读...`);
        }

        // 尝试流式响应
        try {
          const responseStream = await ai.models.generateContentStream({
            model: modelCandidate,
            contents,
            config: {
              systemInstruction: dynamicSystem,
              temperature: selectedMode?.temp ?? 0.0,
            },
          });

          for await (const chunk of responseStream) {
            const text = chunk.text;
            if (text) {
              chatHistory[assistantMsgIndex].content += text;
              updateLastMessageContent(chatHistory[assistantMsgIndex].content);
              scrollToBottom();
            }
          }

          streamSuccess = true;
          break; // 流式成功完成
        } catch (streamErr: any) {
          console.warn(`Streaming failed on ${modelCandidate}, falling back to standard generateContent:`, streamErr);
          const errStr = String(streamErr?.message || '');

          // 如果是网络代理导致的 SSE 分块错误 (Incomplete JSON segment)，切换为标准的非流式一次性请求
          if (errStr.includes('Incomplete JSON') || errStr.includes('JSON') || errStr.includes('stream') || !chatHistory[assistantMsgIndex].content) {
            showToast(`正在通过高可靠模式接收【${modelCandidate}】全篇审稿结果...`);
            const response = await ai.models.generateContent({
              model: modelCandidate,
              contents,
              config: {
                systemInstruction: dynamicSystem,
                temperature: selectedMode?.temp ?? 0.0,
              },
            });

            if (response.text) {
              chatHistory[assistantMsgIndex].content = response.text;
              updateLastMessageContent(chatHistory[assistantMsgIndex].content);
              scrollToBottom();
              streamSuccess = true;
              break;
            }
          }

          // 若非流式问题，记录错误继续轮询备选模型
          lastError = streamErr;
          continue;
        }
      } catch (err: any) {
        console.warn(`Model ${modelCandidate} total failure:`, err);
        lastError = err;
        continue;
      }
    }

    if (!streamSuccess && lastError) {
      throw lastError;
    }
  } catch (error: any) {
    console.error('LLM API Error:', error);
    chatHistory[assistantMsgIndex].content = `❌ **调用 Gemini API 出错**: \`${
      error?.message || 'API Key 无效或网络连接中断'
    }\`\n\n💡 **排查与解决建议**：\n1. Google 服务器当前模型可能正处于全球高峰期 (503 High Demand)，可在右上角手动切换为 **Gemini 2.0 Flash**（最为稳定）。\n2. 请确认网络环境代理正常。\n3. 若需快速浏览，可**清空右上角 Key 并保存**体验【全功能演示模式】。`;
  } finally {
    isGenerating = false;
    updateChatUI();
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = '发送研读请求 🚀';
    }
  }
}

/** 模拟响应（无 API Key 时的备用体验，完全对齐 10 维学术矩阵规范） */
function simulateAgentResponse(_input: string, mode: 'rapid' | 'deep'): string {
  if (mode === 'rapid') {
    return `### 🔍 <Self-Verification Log>
- [✓] **Full-Text In-Context Grounding**: Verified across Abstract, Methods (Section 2.2), Results (Section 3.1), and Discussion (Section 4.1). Zero external hallucinations added.
- [✓] **Exact Quotes Matching**: 100% quoted verbatim with Section and Page anchors.

---

### 1. 📋 文献核心档案与三要素提取
| 核心维度 | 提取内容 | 原文依据 (Section & Page) | Exact Quote (英文原句) |
| :--- | :--- | :--- | :--- |
| **Research Question** | 大洋深层惰性溶解有机碳 (RDOC) 积累动力学与碳库稳定性 | \`[Abstract / Page 1]\` | \`[Exact Quote: "The refractory dissolved organic carbon (RDOC) reservoir in the global ocean represents a major carbon sink. Here we report rapid RDOC accumulation rates..."]\` |
| **Core Method** | 岛津 TOC-L 高温催化氧化法 (HTCO)；0.45 μm PTFE 过滤与 PE 塑料瓶 -20°C 保存 | \`[Section 2.2 / Page 3]\` | \`[Exact Quote: "DOC concentration was measured using a High-Temperature Catalytic Oxidation (HTCO) system (Shimadzu TOC-L). Samples were filtered through 0.45 μm PTFE filters and stored at -20°C in polyethylene (PE) bottles."]\` |
| **Key Findings** | 北太平洋 15 站位深层水 (3000-4000m) DOC 平均浓度为 54 ± 2 μmol/L ($p < 0.05$) | \`[Section 3.1 & Table 2 / Page 5]\` | \`[Exact Quote: "Deep water DOC concentrations averaged 54 ± 2 μmol/L across all 15 stations in the North Pacific (p < 0.05)."]\` |

---

### 2. 🎯 10 维学术全景初审矩阵 (10-Dimensional Comprehensive Audit Matrix)
| 审查维度 | 评估结果 | 原文凭据 [Exact Quote & Location] | 审稿人专业审查意见与潜在漏洞 (Critique & Red Flags) |
| :--- | :--- | :--- | :--- |
| **1. 研究问题** | Clear | \`[Page 1: "RDOC reservoir in the global ocean represents a major carbon sink..."]\` | 假说明确，聚焦于大洋深层 RDOC 的非保守周转特征。 |
| **2. 文献讨论** | Clear | \`[Page 2: "Previous baselines established by Hansell et al. (2012)..."]\` | 引用了 Hansell, Carlson 等经典文献，对比了全球大洋平均背景值 (38-42 μmol/L)。 |
| **3. 研究假设** | Clear | \`[Page 2: "Hypothesized that deep water DOC undergoes rapid non-conservative turnover..."]\` | 假设深层水 DOC 积累由局地微型生物碳泵次生合成驱动。 |
| **4. 研究设计** | **Vulnerable** | \`[Page 3: "Single transect cruise with no seasonal or time-series repeats..."]\` | 单一航次走航，缺乏时间序列追踪与水团沉降追踪对照。 |
| **5. 数据与样本** | **Vulnerable** | \`[Page 5: "averaged 54 ± 2 μmol/L across all 15 stations in North Pacific"]\` | 15 个站位虽然给出均值，但深层水团（NPDW）纵向梯度与中层水 (NPIW) 混合比例未进行水文学端元校正。 |
| **6. 变量测量与QA/QC** | **Vulnerable** | \`[Page 3: "Instrument blank was checked using Milli-Q water... Deep sea reference water was measured occasionally."]\` | **严重缺陷 (Major Red Flag)**：未披露 Milli-Q 水空白的具体数值与标准差 (SD)；CRM (Hansell Reference Water) 仅为“occasionally”测定，缺少每批次的基线漂移校正曲线。 |
| **7. 样品采集与保存** | **Vulnerable** | \`[Page 3: "stored at -20°C in polyethylene (PE) bottles..."]\` | **严重致命缺陷 (Major Red Flag)**：PE 塑料瓶极易向超低浓度海水样品溶出微量塑化剂与有机碳；海洋化学测定 DOC 标准规范必须使用经 450°C 灼烧的高硼硅玻璃安瓿瓶加酸封存。 |
| **8. 数据分析与统计** | Clear | \`[Page 5: "p < 0.05 across stations using one-way ANOVA..."]\` | 统计分析报告了显著性水平，数据分布符合方差齐性。 |
| **9. 解读与过度推导** | **Vulnerable** | \`[Page 7: "Our findings suggest deep ocean RDOC is highly dynamic globally..."]\` | **Overstatement (过度推导)**：实测 54 μmol/L 显著高于大洋公认背景值 (38-42 μmol/L)，在未扣除 PE 瓶溶出背景前，直接定论深海碳汇具有全球普遍动态性属于严重过度外推。 |
| **10. 局限与盲区** | Clear | \`[Page 7: "though potential container leaching effects remain unquantified."]\` | 作者在文末提及了容器溶出可能，但未在正文进行空白扣除修正。 |

---

### 3. 📊 硬核定量数据与质量控制核验表 (Hard Data & QA/QC Check)
| 关键变量 / 参数 | 样本量 (n) | 均值 ± 误差 / 范围 | 质量控制 (Blank / CRM) | 采样深度 / 水团 | 数据来源与 Exact Quote |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Deep Ocean DOC** | n = 15 | 54 ± 2 μmol/L | 未扣除容器溶出空白 | 3000–4000 m (NPDW) | \`[Table 2 / Page 5]\` \`[Exact Quote: "averaged 54 ± 2 μmol/L across all 15 stations"]\` |
| **Instrument Blank** | Not Disclosed | Milli-Q Water | 【原文未披露 SD/数值】 | 实验室 Shimadzu HTCO | \`[Section 2.2 / Page 3]\` \`[Exact Quote: "checked using Milli-Q water before each run batch"]\` |
| **Deep Sea CRM** | Occasional | Not Disclosed | 缺少连续漂移校准图 | Hansell Batch CRM | \`[Section 2.2 / Page 3]\` \`[Exact Quote: "Deep sea reference water was measured occasionally."]\` |

---

### 4. ⚖️ 审稿人终审裁决 (Reviewer Verdict & Key Major Concerns)
- **审稿人初审决议**：**Major Revision (大修)**
- **Top 2 核心硬伤警示**：
  1. **样品瓶溶出污染假象 (Artifact of PE Leaching)**：使用 PE 塑料瓶冷冻保存低浓度深海 DOC 样品，测得的 54 μmol/L 异常高值极可能是瓶壁塑料溶出假象，而非真实的海洋学信号。
  2. **QA/QC 链条断裂**：缺少每批次 Milli-Q 空白绝对值和 Hansell CRM 漂移校准曲线，数据测量信度存在系统性可疑。

*(提示：当前为模拟/演示模式。在右上角输入有效 Gemini API Key 后，将由官方大模型对你上传的论文全文执行全篇深度解析与多轮交锋)*`;
  } else {
    return `### 🎓 【精读研讨 · 轮次一：文献树溯源与科学问题启发】

#### 📌 提炼文献核心客观事实与证据锚定 (2~3 点)
1. **研究假说**：\`[Section 1 / Page 2]\` \`[Exact Quote: "We hypothesize that the microbial carbon pump converts labile organic carbon into refractory DOC..."]\` —— 论文提出了基于微型生物碳泵 (MCP) 驱动难降解有机碳 (RDOC) 积累的核心假说。
2. **基石文献对比**：\`[Section 2 / Page 3]\` \`[Exact Quote: "Building upon the oceanic carbon reservoir model by Hansell et al. (2012)..."]\` —— 借鉴了 Hansell 大洋碳库分类理论，但在近岸表层与深海碳汇外推上存在显著差异。

---

#### 💡 苏格拉底式思辨追问 (费曼阐述考问)
1. **科学问题**：本篇论文提出的核心假说，试图解决海洋生物地球化学中的哪一个未解问题？它与经典 Hansell 碳库理论的根本分歧在哪里？
2. **文献溯源**：在您自己的课题方向中，有哪些经典文献是理解该机制必须精读的基础？如果您要将其假说应用到您的研究介质/海区中，面临的最大理论挑战是什么？

*(提示：您可以在下方回复您的回答，开启逻辑红笔审视；或点击 4 轮研讨 Chip 切换后续维度)*`;
  }
}

// 启动应用
initApp();
