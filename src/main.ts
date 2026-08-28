import './style.css';
import 'katex/dist/katex.min.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { GoogleGenAI } from '@google/genai';

// 配置本地 PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/** 渲染 Markdown 中的 LaTeX 数学公式（安全保护代码块与草图，避免代码块内公式被错误二次解析） */
function renderMath(text: string): string {
  if (!text) return text;

  // 1. 优先保护独立代码块与行内代码，防止代码块内的公式或文本被替换破坏
  const codeBlocks: string[] = [];
  let protectedText = text.replace(/```[\s\S]*?```|`[^`\n]+?`/g, (match) => {
    codeBlocks.push(match);
    return `@@CODE_BLOCK_${codeBlocks.length - 1}@@`;
  });

  // 2. 块级公式 $$...$$
  protectedText = protectedText.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), { displayMode: true, throwOnError: false });
    } catch {
      return '$$' + math + '$$';
    }
  });

  // 3. 块级公式 \[...\]
  protectedText = protectedText.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), { displayMode: true, throwOnError: false });
    } catch {
      return '\\[' + math + '\\]';
    }
  });

  // 4. 行内公式 \(...\)
  protectedText = protectedText.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    try {
      return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false });
    } catch {
      return '\\(' + math + '\\)';
    }
  });

  // 5. 行内公式 $...$
  protectedText = protectedText.replace(/(^|[^\\$])\$([^\$\n]+?)\$/g, (match, prefix, math) => {
    const trimmed = math.trim();
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

  // 6. 还原被保护的代码块
  protectedText = protectedText.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, idx) => {
    return codeBlocks[parseInt(idx, 10)] || '';
  });

  return protectedText;
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

function safeMarkdown(md: string): string {
  const mathRendered = renderMath(md);
  const rawHtml = marked.parse(mathRendered) as string;
  return DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['span', 'annotation', 'semantics', 'math', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'mfrac', 'mover', 'munder', 'msqrt', 'mtable', 'mtr', 'mtd'],
    ADD_ATTR: ['xmlns', 'display', 'class', 'style', 'aria-hidden'],
  });
}

export interface ReviewMode {
  id: 'warmup' | 'rapid' | 'deep' | 'studio';
  name: string;
  temp: number;
  sampling: string;
  desc: string;
}

export interface ScholarPaper {
  title: string;
  authors: string;
  journal: string;
  year: string;
  doi: string;
  url: string;
  scholarUrl: string;
  abstract?: string;
}

export interface PdfPageData {
  pageNumber: number;
  dataUrl: string;
  base64: string;
  width: number;
  height: number;
  detectedSection: string;
  snippet: string;
}

export interface AttachedImage {
  id: string;
  dataUrl: string;
  base64: string;
  name: string;
  type: 'screenshot' | 'upload' | 'pdf-page';
  pageNumber?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  mode?: 'warmup' | 'rapid' | 'deep' | 'studio';
  attachedSummary?: string;
}

/** 多文献研读会话接口 */
export interface LiteratureSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  currentMode: 'warmup' | 'rapid' | 'deep' | 'studio';
  chatHistory: ChatMessage[];
  pdfPages: PdfPageData[];
  selectedPdfPageIndices: number[];
  attachedImages: AttachedImage[];
  uploadedPdfName: string;
  uploadedPdfText: string;
  uploadedPdfSectionSummary: string;
}

const MODES: ReviewMode[] = [
  {
    id: 'warmup',
    name: '【破冰热身模式】 认知快照与论证路线',
    temp: 0.2,
    sampling: 'Deterministic Scaffolding (T=0.2)',
    desc: '提炼核心科学矛盾、30秒论证路线、关键图表与阶梯思考题',
  },
  {
    id: 'rapid',
    name: '【泛读模式】 10维自检与数据核验',
    temp: 0.0,
    sampling: 'Greedy Sampling (T=0.0)',
    desc: '极速提取核心三要素、硬数据核验表与10维学术初审自检表',
  },
  {
    id: 'deep',
    name: '【精读模式】 4轮苏格拉底研讨与攻防修辞',
    temp: 0.3,
    sampling: 'Rigorous Socratic (T=0.3)',
    desc: '逐轮解构立论格局、实验质控、假想敌防守与三维核心学术资产卡',
  },
  {
    id: 'studio',
    name: '【领读工坊】 5步大牛思维逐步解剖',
    temp: 0.3,
    sampling: 'Step-by-Step Studio (T=0.3)',
    desc: '单步递进领读：论证路线 -> 攻防修辞 -> 思维博弈 -> 句式造句 -> 资产沉淀',
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
# Ocean & Geochemistry Literature Coach System Prompt & Knowledge Base

## Role & Profile
你是一位极其严谨、具有顶级学术审美（Nature / Earth and Planetary Science Letters / Geochimica et Cosmochimica Acta 审稿人水准）的海洋与地球化学学术教练（Peer Reviewer & Coach）。
你的核心使命是协助使用者开展文献阅读，建立批判性思维（Critical Thinking），解构大牛论证路线与攻防修辞，并高效沉淀三维核心学术资产。

## 多模态视觉输入优先准则 (Multimodal Vision Grounding Directive)
1. **支持多图/多页联合视觉输入**：当用户传入多张论文单页（PNG/JPEG 高清图）或多个截图（如同时传入引言段落 + 断面图 Fig.1 + 表格 Table.1）时，请直接跨图对比，综合提取排版文本、同位素标注（如 ^14C, δ13C）、化学分子式（如 NO3-, DOC, THAA）、图表坐标轴、误差线与表格数据，严禁产生乱码拼凑与幻觉。
2. **强引用原文 Exact Quote**：每一条总结、结论提取或审稿质疑，必须挂钩原图中的英文原句：[Section/Page/Fig] + [Exact Quote: "..."]。
3. **查图表对硬数据**：核验样本量 n、均值、误差（SE/SD）、p 值与水团深度。
4. **专业术语严谨性红线**：如 NADW (北大西洋深层水)、AABW (南极底层水)、NPDW (北太平洋深层水)、AMOC (大西洋经向倒转环流)、MCP (微型生物碳泵)、SPE-PPL 萃取等术语 100% 严密自洽。

---

## 交互模式执行规范

### 模式 0：【引导式破冰/热身模式】 (Warm-up Mode | Temp = 0.2)
输出四大快照卡片：
1. 🎴 卡片 1：核心科学矛盾与反常现象 ([Exact Quote])
2. 🎴 卡片 2：30秒极简论证路线草图 ([基线] -> [矛盾/Gap] -> [实验破局] -> [机制假说与升华])
3. 🎴 卡片 3：关键图表指引 (Key Figures & Evidence)
4. 🎴 卡片 4：3 个阶梯思考题 (Scaffolding Questions)

### 模式一：【泛读模式】 (Rapid Mode | Temp = 0.0)
输出：
1. <Self-Verification Log>
2. 核心三要素事实表 (Research Question, Core Method, Key Findings)
3. 关键定量数据与误差核验表
4. 10 维学术初审自检表 (10-Dimension Audit Table)

### 模式二：【精读模式】 (Deep Socratic Review | Temp = 0.3)
4 轮苏格拉底递进研讨（状态机硬锁机制）：
- Round 1/4 (立论格局与叙事张力)：科学矛盾、前沿缺口与假说构建。
- Round 2/4 (实证硬核与排他性证明)：实验质控（空白、CRM 标样）、断面图与数据链条。
- Round 3/4 (假想敌审视与攻防修辞)：审稿人视角漏洞，解剖防御性修辞 (Hedging: is consistent with, tentatively attribute, cannot rule out)。
- Round 4/4 (综合升华与三维资产卡)：输出【三维核心学术资产卡】（句式库 + 机理模型 + 实验/数据实操技巧）。

### 模式三：【领读与大牛思维解剖工坊】 (Guided Walkthrough & Writing Studio | Temp = 0.3)
#### ⚠️ 领读模式绝对执行铁律：单步递进“硬锁”机制 (Step-by-Step State Machine Lock)
1. 【严禁单次回复一次性输出全部 5 个 Step】（除非用户明确指定“【一键输出全文5步】”）。每次必须且仅输出当前单个 Step，让用户沉下心细读领会！
2. Step 1/5 (精选段落与论证路线草图)：
   - 贴出原文核心段落 [Section/Page] 与完整英文原句；
   - 输出 3~4 环节的【论证路线草图 (Argumentation Blueprint)】；
   - 逐句逻辑链透视（Sentence 1 起、Sentence 2 承、Sentence 3 转、Sentence 4 合 等，真实标注功能并附带英文原句 Exact Quote）；
   - 文末标注：*(当前状态: Step 1/5 论证路线解剖完成 🔒 | 请沉下心研读后回复【下一步】或【进入Step 2】)*。
3. Step 2/5 (语气与攻防修辞解剖刀)：
   - 修辞力度扫描（核心动词、副词与防弹词）；
   - 攻防意图揭示（进攻点：强确定性突破；防守点：防御性 Hedging 封堵攻击）；
   - 文末标注：*(当前状态: Step 2/5 攻防修辞透视完成 🔒 | 请体会修辞分寸后回复【下一步】或【进入Step 3】)*。
4. Step 3/5 (大牛思维博弈题)：
   - 提出 1 道极具启发性的大牛思维博弈题（如去掉限定词会有何审稿攻击）；
   - 文末标注：*(当前状态: Step 3/5 思维博弈思考中 🔒 | 请输入您的理解，或回复【进入Step 4】)*。
5. Step 4/5 (顶刊句式萃取与迁移造句实战)：
   - 点评用户回答；
   - 提炼 2 个顶刊句式公式（结构模板 + 修辞功能 + 适用语境）；
   - 给出 1 个迁移造句挑战；
   - 文末标注：*(当前状态: Step 4/5 迁移造句实战中 🔒 | 请提交您的句子接受导师红笔润色，或回复【进入Step 5】)*。
6. Step 5/5 (导师红笔精修与三维资产沉淀卡)：
   - 导师红笔点评与地道顶刊级润色；
   - 输出【今日三维核心学术资产卡】（句式资产 + 机理资产 + 实操技巧）。

### 场景 G：【保存归档与新章节平滑过渡协议】
当收到【保存本章】、【归档研讨】、【保存并开启新章节】指令时：
1. 第一阶段：输出结构化 Markdown 永久学术资产卡（包含论证路线因果骨架、核心证据与修辞攻防剖析、顶刊句式库与红笔精修、机理洞察与实验质控技巧）。
2. 第二阶段：输出归档确认标记 \`[ARCHIVE_SAVED_SUCCESS]\`，并提示下一步可选方向（开启同文献下一章节 / 对比新段落 / 开启全新文献研读）。
`;

/** ==================== IndexedDB 永久多文献会话存储中心 ==================== */
const DB_NAME = 'OceanLitCoachDB';
const DB_VERSION = 1;
const STORE_NAME = 'literature_sessions';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAllSessions(): Promise<LiteratureSession[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const list: LiteratureSession[] = req.result || [];
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('dbGetAllSessions error:', e);
    return [];
  }
}

async function dbSaveSession(session: LiteratureSession): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(session);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('dbSaveSession error:', e);
  }
}

async function dbGetSession(id: string): Promise<LiteratureSession | undefined> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('dbGetSession error:', e);
    return undefined;
  }
}

async function dbDeleteSession(id: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('dbDeleteSession error:', e);
  }
}

/** ==================== 应用全局活动状态 ==================== */
let apiKey = localStorage.getItem('gemini_api_key') || '';
let sessionsList: LiteratureSession[] = [];
let currentSessionId = '';

let chatHistory: ChatMessage[] = [];
let pdfPages: PdfPageData[] = [];
let selectedPdfPageIndices: number[] = [0];
let attachedImages: AttachedImage[] = [];
let uploadedPdfName = '';
let uploadedPdfText = '';
let uploadedPdfSectionSummary = '';
let currentMode: 'warmup' | 'rapid' | 'deep' | 'studio' = 'studio';
let isGenerating = false;
let scholarResults: ScholarPaper[] = [];

/** 生成全新空白会话对象 */
function createSessionObject(title = '新文献研读会话'): LiteratureSession {
  const now = Date.now();
  return {
    id: 'session_' + now + '_' + Math.random().toString(36).substring(2, 7),
    title,
    createdAt: now,
    updatedAt: now,
    currentMode: 'studio',
    chatHistory: [],
    pdfPages: [],
    selectedPdfPageIndices: [0],
    attachedImages: [],
    uploadedPdfName: '',
    uploadedPdfText: '',
    uploadedPdfSectionSummary: '',
  };
}

/** 获取当前会话并组装数据 */
function getCurrentSessionData(): LiteratureSession {
  const existing = sessionsList.find((s) => s.id === currentSessionId);
  const now = Date.now();
  let title = existing?.title || (uploadedPdfName ? '《' + uploadedPdfName.replace(/\.pdf$/i, '') + '》' : '新文献研读会话');

  // 如果标题是默认值，尝试根据第一条消息或 PDF 进行命名
  if (title === '新文献研读会话' || !title) {
    if (uploadedPdfName) {
      title = '《' + uploadedPdfName.replace(/\.pdf$/i, '') + '》';
    } else if (chatHistory.length > 0) {
      const firstUser = chatHistory.find((m) => m.role === 'user');
      if (firstUser) {
        title = firstUser.content.slice(0, 24).replace(/\n/g, ' ') + '...';
      }
    }
  }

  return {
    id: currentSessionId,
    title,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    currentMode,
    chatHistory,
    pdfPages,
    selectedPdfPageIndices,
    attachedImages,
    uploadedPdfName,
    uploadedPdfText,
    uploadedPdfSectionSummary,
  };
}

/** 状态持久化至 IndexedDB */
async function saveCurrentSessionState() {
  if (!currentSessionId) return;
  updateSessionBadge(false);
  const data = getCurrentSessionData();

  // 更新内存中的 sessionsList
  const idx = sessionsList.findIndex((s) => s.id === currentSessionId);
  if (idx >= 0) {
    sessionsList[idx] = data;
  } else {
    sessionsList.unshift(data);
  }

  await dbSaveSession(data);
  updateSessionBadge(true);
  updateSessionVaultUI();
}

/** 切换到指定会话 */
async function switchToSession(sessionId: string) {
  if (isGenerating) {
    showToast('⚠️ AI 正在生成中，请稍候再切换会话');
    return;
  }

  // 先保存当前会话
  if (currentSessionId && (chatHistory.length > 0 || uploadedPdfName || attachedImages.length > 0)) {
    await saveCurrentSessionState();
  }

  const target = await dbGetSession(sessionId);
  if (!target) {
    showToast('❌ 未找到该会话记录');
    return;
  }

  currentSessionId = target.id;
  chatHistory = target.chatHistory || [];
  pdfPages = target.pdfPages || [];
  selectedPdfPageIndices = target.selectedPdfPageIndices || [0];
  attachedImages = target.attachedImages || [];
  uploadedPdfName = target.uploadedPdfName || '';
  uploadedPdfText = target.uploadedPdfText || '';
  uploadedPdfSectionSummary = target.uploadedPdfSectionSummary || '';
  currentMode = target.currentMode || 'studio';

  localStorage.setItem('ocean_last_active_session_id', currentSessionId);

  updatePdfUI();
  updateAttachedMediaUI();
  updateModeUI();
  updateChatUI();
  updateSessionVaultUI();
  updateSessionBadge(true);

  showToast('📂 已切换至《' + target.title + '》研读进度！');
}

/** 开启全新文献/新章节会话 */
async function createNewSession(customTitle?: string) {
  if (isGenerating) {
    showToast('⚠️ AI 正在生成中，请稍候再开启新会话');
    return;
  }

  // 先保存当前会话
  if (currentSessionId && (chatHistory.length > 0 || uploadedPdfName || attachedImages.length > 0)) {
    await saveCurrentSessionState();
  }

  const newSession = createSessionObject(customTitle || '新文献研讨 #' + (sessionsList.length + 1));
  currentSessionId = newSession.id;
  chatHistory = [];
  pdfPages = [];
  selectedPdfPageIndices = [0];
  attachedImages = [];
  uploadedPdfName = '';
  uploadedPdfText = '';
  uploadedPdfSectionSummary = '';
  currentMode = 'studio';

  sessionsList.unshift(newSession);
  await dbSaveSession(newSession);
  localStorage.setItem('ocean_last_active_session_id', currentSessionId);

  updatePdfUI();
  updateAttachedMediaUI();
  updateModeUI();
  updateChatUI();
  updateSessionVaultUI();
  updateSessionBadge(true);

  const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.value = '';
    textarea.focus();
  }

  showToast('✨ 已开启全新文献研读会话！上一篇文献数据已自动安全归档。');
}

/** 删除指定会话 */
async function handleDeleteSession(sessionId: string, e?: Event) {
  if (e) e.stopPropagation();
  const target = sessionsList.find((s) => s.id === sessionId);
  const title = target?.title || '该会话';

  if (!confirm(`确定要彻底删除《${title}》的研读记录与图片缓存吗？此操作不可逆。`)) {
    return;
  }

  await dbDeleteSession(sessionId);
  sessionsList = sessionsList.filter((s) => s.id !== sessionId);

  if (currentSessionId === sessionId) {
    if (sessionsList.length > 0) {
      await switchToSession(sessionsList[0].id);
    } else {
      await createNewSession();
    }
  } else {
    updateSessionVaultUI();
  }

  showToast('🗑️ 已删除文献会话《' + title + '》');
}

/** 导出指定会话为完整 Markdown 研读档案包 */
function handleExportSessionArchive(sessionId: string, e?: Event) {
  if (e) e.stopPropagation();
  const session = sessionsList.find((s) => s.id === sessionId) || (sessionId === currentSessionId ? getCurrentSessionData() : undefined);
  if (!session) return;

  let md = `# 📚 【文献研读深度档案 · 知识资产包】\n\n`;
  md += `- **研讨文献**：${session.title}\n`;
  md += `- **创建时间**：${new Date(session.createdAt).toLocaleString()}\n`;
  md += `- **最近更新**：${new Date(session.updatedAt).toLocaleString()}\n`;
  md += `- **PDF 文献**：${session.uploadedPdfName || '纯截图/段落研读'}\n`;
  md += `- **对话轮数**：${session.chatHistory.length} 轮次\n\n`;
  md += `---\n\n## 💬 研讨对话全景记录\n\n`;

  session.chatHistory.forEach((msg, idx) => {
    const roleName = msg.role === 'user' ? '👤 读者提问 / 作答' : '🌊 学术教练点评与透视';
    md += `### [Round ${idx + 1}] ${roleName}\n`;
    if (msg.attachedSummary) {
      md += `> 🖼️ *挂载多模态*: ${msg.attachedSummary}\n\n`;
    }
    md += `${msg.content}\n\n---\n\n`;
  });

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Literature_Archive_${session.title.replace(/[\s\/:*?"<>|]/g, '_')}_${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📦 已导出《' + session.title + '》完整研讨 Markdown 档案！');
}

/** 更新会话存盘状态指示器 */
function updateSessionBadge(isSaved: boolean) {
  const badge = document.getElementById('session-save-badge');
  if (!badge) return;
  badge.style.display = 'inline-flex';
  if (isSaved) {
    badge.textContent = '💾 已存入文献库';
    badge.className = 'session-status-badge';
  } else {
    badge.textContent = '⏳ 同步中...';
    badge.className = 'session-status-badge saving';
  }
}

/** 渲染左侧【📁 研读文献库 / 历史会话】列表 */
function updateSessionVaultUI() {
  const container = document.getElementById('session-list-container');
  if (!container) return;

  if (sessionsList.length === 0) {
    container.innerHTML = '<div class="no-results-hint">暂无归档文献，点击上方“开启新研读”。</div>';
    return;
  }

  container.innerHTML = sessionsList
    .map((s) => {
      const isActive = s.id === currentSessionId;
      const timeStr = new Date(s.updatedAt).toLocaleDateString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const msgCount = s.chatHistory?.length || 0;
      const modeObj = MODES.find((m) => m.id === s.currentMode);
      const modeName = modeObj ? modeObj.name.split(' ')[0] : '工坊';

      return `
        <div class="session-item ${isActive ? 'active' : ''}" data-session-id="${s.id}">
          <div class="session-title-row">
            <span class="session-title-text" title="${s.title}">${s.title}</span>
            <div class="session-actions">
              <button class="session-icon-btn btn-rename-session" data-session-id="${s.id}" title="重命名会话">✏️</button>
              <button class="session-icon-btn btn-export-session" data-session-id="${s.id}" title="导出 Markdown 档案">📥</button>
              <button class="session-icon-btn delete btn-delete-session" data-session-id="${s.id}" title="删除此会话">✕</button>
            </div>
          </div>
          <div class="session-meta-row">
            <span>${timeStr} · ${msgCount}条对话</span>
            <span style="background:rgba(0,0,0,0.05); padding:1px 4px; border-radius:3px;">${modeName}</span>
          </div>
        </div>
      `;
    })
    .join('');

  // 绑定点击切换
  container.querySelectorAll('.session-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.session-actions')) return;
      const id = item.getAttribute('data-session-id');
      if (id && id !== currentSessionId) {
        switchToSession(id);
      }
    });
  });

  // 绑定重命名
  container.querySelectorAll('.btn-rename-session').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-session-id');
      if (!id) return;
      const target = sessionsList.find((s) => s.id === id);
      if (!target) return;

      const newTitle = prompt('请输入新的文献/章节研读名称：', target.title);
      if (newTitle && newTitle.trim() && newTitle.trim() !== target.title) {
        target.title = newTitle.trim();
        dbSaveSession(target);
        updateSessionVaultUI();
        showToast('✏️ 已重命名为《' + target.title + '》');
      }
    });
  });

  // 绑定导出
  container.querySelectorAll('.btn-export-session').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = btn.getAttribute('data-session-id');
      if (id) handleExportSessionArchive(id, e);
    });
  });

  // 绑定删除
  container.querySelectorAll('.btn-delete-session').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = btn.getAttribute('data-session-id');
      if (id) handleDeleteSession(id, e);
    });
  });
}

/** ==================== 初始化应用界面 ==================== */
async function initApp() {
  const app = document.getElementById('app');
  if (!app) return;

  // 从 IndexedDB 读取所有历史会话
  sessionsList = await dbGetAllSessions();
  const lastActiveId = localStorage.getItem('ocean_last_active_session_id');

  if (sessionsList.length > 0) {
    const matched = sessionsList.find((s) => s.id === lastActiveId) || sessionsList[0];
    currentSessionId = matched.id;
    chatHistory = matched.chatHistory || [];
    pdfPages = matched.pdfPages || [];
    selectedPdfPageIndices = matched.selectedPdfPageIndices || [0];
    attachedImages = matched.attachedImages || [];
    uploadedPdfName = matched.uploadedPdfName || '';
    uploadedPdfText = matched.uploadedPdfText || '';
    uploadedPdfSectionSummary = matched.uploadedPdfSectionSummary || '';
    currentMode = matched.currentMode || 'studio';
  } else {
    // 首次进入，创建初始会话
    const initSession = createSessionObject('初遇 · 破冰研读示范');
    sessionsList.push(initSession);
    currentSessionId = initSession.id;
    await dbSaveSession(initSession);
  }

  app.innerHTML = `
    <div class="app-container">
      <!-- 顶部 Header -->
      <header class="app-header">
        <div class="header-title">
          <span style="font-size:1.6rem;">🌊</span>
          <div>
            <h1>Ocean Geochemistry AI Literature Coach</h1>
            <p class="subtitle">海洋与地球化学文献多模态逐段领读教练 (Step-by-Step Guided Walkthrough)</p>
          </div>
        </div>
        <div class="header-actions">
          <div class="api-key-box">
            <select id="model-select" style="background:var(--bg-main); border:1px solid var(--border-subtle); border-radius:4px; padding:0.35rem 0.6rem; font-size:0.78rem; color:var(--text-primary);">
              <option value="gemini-3.6-flash" selected>Gemini 3.6 Flash (推荐·多模态强劲)</option>
              <option value="gemini-2.0-flash">Gemini 2.0 Flash (高速稳定)</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash (高智能)</option>
              <option value="gemini-2.5-pro">Gemini 2.5 Pro (深度分析)</option>
              <option value="custom">✍️ 自定义模型名称...</option>
            </select>
            <input type="text" id="custom-model-input" placeholder="输入模型 ID..." style="display:none; width:120px; background:var(--bg-main); border:1px solid var(--border-subtle); border-radius:4px; padding:0.35rem 0.5rem; font-size:0.78rem;" />
            <input type="password" id="api-key-input" placeholder="Gemini API Key..." value="${apiKey}" />
            <button id="save-key-btn">保存 Key</button>
          </div>
        </div>
      </header>

      <div class="main-layout">
        <!-- 左侧面板 -->
        <aside class="sidebar">
          <!-- 📁 研读文献库 / 历史会话管理 -->
          <div class="panel-card" style="border-top: 3px solid var(--accent-indigo);">
            <div class="session-vault-header">
              <h3 style="margin-bottom:0; border:none; padding:0;">📁 研读文献库 (Library)</h3>
              <span style="font-size:0.68rem; color:var(--accent-indigo); background:#eef4ff; padding:2px 6px; border-radius:10px; font-weight:600;" id="session-count-badge">${sessionsList.length} 篇</span>
            </div>
            <button class="new-session-btn" id="btn-create-new-session" style="margin-top:0.6rem;">
              <span>➕</span> 开启新文献/新章节研读
            </button>
            <div class="session-list-box" id="session-list-container"></div>
          </div>

          <!-- 学术文献直连搜索 -->
          <div class="panel-card">
            <h3>🔍 学术文献直连 (Crossref / Scholar)</h3>
            <div class="scholar-search-box">
              <input type="text" id="scholar-query" placeholder="输入文献标题/DOI/关键词..." />
              <button id="scholar-search-btn">搜索 🔍</button>
            </div>
            <div class="scholar-results" id="scholar-results-container">
              <div class="no-results-hint">可在上方输入关键词，实时调取全球海洋地球化学文献库。</div>
            </div>
          </div>

          <!-- 多模态高清 PDF / 多图多截图上传区 -->
          <div class="panel-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h3>🖼️ 多模态图文解析池</h3>
              <span style="font-size:0.68rem; color:var(--accent-indigo); background:#eef4ff; padding:2px 6px; border-radius:10px; font-weight:600;">PDF+多图并存</span>
            </div>
            <p class="panel-hint">支持 <strong>PDF 全篇单页</strong> 与 <strong>多张截图/图片 (Ctrl+V) 同时导入</strong>：</p>
            <div class="pdf-upload-box" id="pdf-dropzone">
              <input type="file" id="pdf-file-input" multiple accept=".pdf,image/png,image/jpeg,image/webp" />
              <div class="pdf-upload-content">
                <span class="pdf-icon">📤</span>
                <span class="upload-text">点击或拖拽上传 PDF / 多张图片</span>
                <span class="upload-subtext">随时按 Ctrl+V 粘贴任意数量截图 · 支持多图联合分析</span>
              </div>
            </div>
            <div class="pdf-status" id="pdf-status-container"></div>
            
            <!-- 页面缩略图网格与导航 -->
            <div class="pdf-pages-wrapper" id="pdf-pages-container" style="display:none;"></div>
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
              <button class="test-btn" id="load-test-0" style="background:#fefbf3; border-color:#d4a373; font-weight:500;">
                ☕ Case 0: 破冰热身与关键图表提取
              </button>
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
            <div style="display:flex; align-items:center; gap:0.8rem; flex-wrap:wrap;">
              <span id="chat-status-text">
                💡 当前模式：<strong id="current-mode-label">${
                  currentMode === 'warmup'
                    ? '【破冰热身模式】认知快照与论证路线 (T=0.2)'
                    : currentMode === 'rapid'
                    ? '【泛读模式】10维自检与数据核验 (T=0.0)'
                    : currentMode === 'deep'
                    ? '【精读模式】4轮苏格拉底研讨与攻防修辞 (T=0.3)'
                    : '【领读工坊】5步大牛思维逐步解剖 (T=0.3)'
                }</strong>
              </span>
              <span class="session-status-badge" id="session-save-badge">💾 已存入文献库</span>
            </div>
            <div class="toolbar-actions">
              <button class="toolbar-btn" id="archive-and-new-btn" title="生成永久资产卡并准备进入下一章节" style="background:var(--accent-indigo); color:#fff;">💾 归档本章资产</button>
              <button class="toolbar-btn" id="export-current-session-btn" title="导出当前文献完整 Markdown 研讨记录">📦 导出全篇</button>
              <button class="toolbar-btn" id="recover-quick-btn" title="填入断点恢复卡片，快速承接中断研讨">🔄 恢复研讨</button>
              <button class="toolbar-btn" id="clear-chat-btn">🗑️ 清空对话</button>
            </div>
          </div>

          <div class="chat-messages" id="chat-messages">
            <div class="welcome-box" id="welcome-box">
              <h2>静寂・严谨・逐步沉浸式学术领读</h2>
              <p>拒绝单次巨幅信息轰炸。导师每次仅输出 1 个 Step（论证路线 → 攻防修辞 → 思维博弈 → 句式造句 → 资产沉淀），带你沉下心细细研磨大牛每一招式。</p>
              <div class="quick-tips">
                <span>💡 提示：支持直接 <strong>Ctrl + V</strong> 粘贴多张截图；文献库自动记录所有研读进度，随时在左侧切换文献。</span>
              </div>
            </div>
          </div>

          <div class="input-container">
            <!-- 挂载的多图/多模态画廊 -->
            <div class="attached-media-bar" id="attached-media-bar" style="display:none;"></div>

            <!-- 两阶段递进敏捷研读工具条 -->
            <div class="stage-scaffolding-bar">
              <span class="stage-title">⚡ 领读节奏:</span>
              <button class="stage-btn primary" id="btn-stage2-step1" title="仅输出 Step 1 论证路线解剖">
                📖 启动领读 (Step 1 论证路线)
              </button>
              <button class="stage-btn highlight" id="btn-next-step" title="进入领读工坊的下一个 Step">
                ▶️ 进入下一步 (Next Step)
              </button>
              <button class="stage-btn" id="btn-stage2-step2" title="解剖语气分寸与攻防意图">
                🔍 Step 2 攻防修辞
              </button>
              <button class="stage-btn" id="btn-stage2-step3" title="提出大牛思维博弈题">
                ♟️ Step 3 思维博弈题
              </button>
              <button class="stage-btn" id="btn-stage2-step4" title="萃取顶刊句式与造句实战">
                ✍️ Step 4 句式与造句
              </button>
              <button class="stage-btn" id="btn-stage2-asset" title="沉淀句式库与机理模型">
                🏆 Step 5 资产沉淀
              </button>
              <button class="stage-btn" id="btn-stage1-overview" title="先了解全篇大意与30秒论证路线" style="margin-left:auto; font-size:0.72rem; color:var(--text-secondary);">
                🎴 全局热身
              </button>
            </div>

            <textarea id="user-input" placeholder="输入研讨反思、造句练习，或点击【▶️ 进入下一步】推进领读节奏 (Ctrl+Enter 发送)..."></textarea>
            <div class="input-actions">
              <span class="mode-indicator" id="mode-indicator">
                当前策略: STEP-BY-STEP STUDIO (T=0.3)
              </span>
              <div style="display:flex; gap:0.5rem; align-items:center;">
                <button id="recall-last-btn" class="toolbar-btn" style="padding:0.35rem 0.65rem; font-size:0.78rem;">✏️ 载入上条输入</button>
                <button id="send-btn">发送研读请求 🚀</button>
              </div>
            </div>
          </div>
        </main>
      </div>

      <!-- 全屏高清大图查看 Modal -->
      <div id="image-modal-root"></div>
    </div>
  `;

  bindAllEvents();
  updatePdfUI();
  updateModeUI();
  updateAttachedMediaUI();
  updateSessionVaultUI();
  if (chatHistory.length > 0) {
    updateChatUI();
  }
}

/** 事件绑定 */
function bindAllEvents() {
  document.getElementById('btn-create-new-session')?.addEventListener('click', () => createNewSession());
  document.getElementById('archive-and-new-btn')?.addEventListener('click', handleArchiveAndNext);
  document.getElementById('export-current-session-btn')?.addEventListener('click', () => handleExportSessionArchive(currentSessionId));
  document.getElementById('recover-quick-btn')?.addEventListener('click', fillRecoveryTemplate);

  document.getElementById('save-key-btn')?.addEventListener('click', () => {
    const input = document.getElementById('api-key-input') as HTMLInputElement;
    if (input) {
      apiKey = input.value.trim();
      localStorage.setItem('gemini_api_key', apiKey);
      showToast(apiKey ? '✅ Gemini API Key 已安全保存在本地！' : 'ℹ️ 已切换为【全功能演示模式】。');
    }
  });

  const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
  const customModelInput = document.getElementById('custom-model-input') as HTMLInputElement;
  if (modelSelect && customModelInput) {
    modelSelect.addEventListener('change', () => {
      if (modelSelect.value === 'custom') {
        customModelInput.style.display = 'inline-block';
        customModelInput.focus();
      } else {
        customModelInput.style.display = 'none';
        showToast('⚡ 已切换模型为：' + modelSelect.options[modelSelect.selectedIndex].text);
      }
    });
  }

  document.getElementById('scholar-search-btn')?.addEventListener('click', handleScholarSearch);
  document.getElementById('scholar-query')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleScholarSearch();
  });

  document.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      const mode = card.getAttribute('data-mode') as 'warmup' | 'rapid' | 'deep' | 'studio';
      if (mode && mode !== currentMode) {
        currentMode = mode;
        updateModeUI();
        onModeChanged(mode);
        saveCurrentSessionState();
      }
    });
  });

  const pdfInput = document.getElementById('pdf-file-input') as HTMLInputElement;
  const dropzone = document.getElementById('pdf-dropzone');
  pdfInput?.addEventListener('change', async (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files && files.length > 0) {
      await handleIncomingFiles(Array.from(files));
    }
  });

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
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        await handleIncomingFiles(Array.from(files));
      }
    });
  }

  // 剪贴板连续截图粘贴
  window.addEventListener('paste', handleClipboardPaste);

  // 敏捷动作按钮 (领读分步推进)
  document.getElementById('btn-stage2-step1')?.addEventListener('click', handleStartStep1);
  document.getElementById('btn-next-step')?.addEventListener('click', handleNextStep);
  document.getElementById('btn-stage2-step2')?.addEventListener('click', handleStep2);
  document.getElementById('btn-stage2-step3')?.addEventListener('click', handleStep3);
  document.getElementById('btn-stage2-step4')?.addEventListener('click', handleStep4);
  document.getElementById('btn-stage2-asset')?.addEventListener('click', handleStage2AssetExtraction);
  document.getElementById('btn-stage1-overview')?.addEventListener('click', handleStage1Overview);

  // Benchmark 测试案例
  document.getElementById('load-test-0')?.addEventListener('click', () => {
    currentMode = 'warmup';
    updateModeUI();
    const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
    if (textarea) {
      textarea.value = '【破冰热身请求】请对以下海洋地球化学文献生成 4 项关键快照卡片（核心矛盾 + 30秒论证路线草图 + 关键图表指引 + 3个阶梯思考题）：\nTitle: Rapid Accumulation of Refractory Dissolved Organic Carbon in Global Deep Ocean\nAbstract [Page 1]: "The refractory dissolved organic carbon (RDOC) reservoir in the global ocean represents a major carbon sink. Here we report rapid RDOC accumulation rates across the North Pacific deep ocean."\nFigure 1 [Page 3]: "Spatial distribution of sampling stations and vertical DOC profiles across the subarctic North Pacific."\nFigure 3 [Page 5]: "HTCO-measured DOC concentrations vs. water mass age (radiocarbon 14C), showing unexpected positive accumulation in deep layers."';
      textarea.focus();
    }
  });

  document.getElementById('load-test-1')?.addEventListener('click', () => {
    currentMode = 'rapid';
    updateModeUI();
    const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
    if (textarea) {
      textarea.value = '【泛读模式】请对以下海洋地球化学论文片段开展全篇 10 维事实核算与 QA/QC 检查：\nTitle: Rapid Accumulation of Refractory Dissolved Organic Carbon in Global Deep Ocean\nAbstract [Page 1]: "The refractory dissolved organic carbon (RDOC) reservoir in the global ocean represents a major carbon sink. Here we report rapid RDOC accumulation rates across the North Pacific deep ocean."\nMethods Snippet [Section 2.2 / Page 3]: "DOC concentration was measured using a High-Temperature Catalytic Oxidation (HTCO) system (Shimadzu TOC-L). Samples were filtered through 0.45 μm PTFE filters and stored at -20°C in polyethylene (PE) bottles. Instrument blank was checked using Milli-Q water before each run batch. Deep sea reference water was measured occasionally."\nResults Snippet [Section 3.1 & Table 2 / Page 5]: "Deep water DOC concentrations averaged 54 ± 2 μmol/L across all 15 stations in the North Pacific (p < 0.05)."\nDiscussion Snippet [Section 4.1 / Page 7]: "Our findings suggest deep ocean RDOC is highly dynamic, though potential container leaching effects remain unquantified."';
      textarea.focus();
    }
  });

  document.getElementById('load-test-2')?.addEventListener('click', () => {
    currentMode = 'deep';
    updateModeUI();
    const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
    if (textarea) {
      textarea.value = '【精读模式启动】\n1. 【目标文献】：Rapid Accumulation of Refractory DOC in Global Deep Ocean\n2. 【文献类型】：A. 实证观测/实验\n3. 【研究背景】：关注深海顽固性溶解有机碳 (RDOC) 与微型生物碳泵 (MCP) 驱动机制\n4. 【已有数据认知】：关注 54 ± 2 μmol/L 异常高值是否存在 PE 塑料溶出假象';
      textarea.focus();
    }
  });

  const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
  textarea?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  });

  document.getElementById('send-btn')?.addEventListener('click', handleSend);

  document.getElementById('recall-last-btn')?.addEventListener('click', () => {
    const lastUserMsg = [...chatHistory].reverse().find((m) => m.role === 'user');
    if (lastUserMsg && textarea) {
      textarea.value = lastUserMsg.content;
      textarea.focus();
      showToast('✏️ 已载入上一条发送内容');
    }
  });

  document.getElementById('clear-chat-btn')?.addEventListener('click', () => {
    if (confirm('确定要清空当前会话的研讨记录与已挂载截图吗？')) {
      chatHistory = [];
      attachedImages = [];
      updateChatUI();
      updateAttachedMediaUI();
      saveCurrentSessionState();
      showToast('🗑️ 已清空当前会话对话与挂载图片');
    }
  });
}

/** 模式切换更新 UI */
function updateModeUI() {
  document.querySelectorAll('.mode-card').forEach((card) => {
    const mode = card.getAttribute('data-mode');
    if (mode === currentMode) {
      card.classList.add('active');
    } else {
      card.classList.remove('active');
    }
  });

  const modeObj = MODES.find((m) => m.id === currentMode);
  const label = document.getElementById('current-mode-label');
  if (label && modeObj) {
    label.textContent = modeObj.name + ' (' + modeObj.sampling + ')';
  }

  const indicator = document.getElementById('mode-indicator');
  if (indicator && modeObj) {
    indicator.textContent = '当前策略: ' + modeObj.sampling.toUpperCase();
  }
}

function onModeChanged(newMode: 'warmup' | 'rapid' | 'deep' | 'studio') {
  const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
  if (!textarea) return;

  const count = getTotalAttachedMediaCount();
  const mediaHint = count > 0 ? '（已挂载 ' + count + ' 项图文）' : '';

  if (newMode === 'warmup') {
    textarea.placeholder = '点击上方【全局热身】' + mediaHint + '，获取核心科学矛盾与30秒论证路线...';
  } else if (newMode === 'rapid') {
    textarea.placeholder = '输入文本' + mediaHint + '，执行 10 维事实核验与 QA/QC 初审...';
  } else if (newMode === 'deep') {
    textarea.placeholder = '输入回答参与苏格拉底研讨（回复【进入下一轮】解锁下一维度）...';
  } else if (newMode === 'studio') {
    textarea.placeholder = '点击【启动领读】或【进入下一步】' + mediaHint + '，沉下心逐步领读...';
  }
}

/** 获取当前挂载的总图文数量 */
function getTotalAttachedMediaCount(): number {
  return attachedImages.length + (pdfPages.length > 0 ? selectedPdfPageIndices.length : 0);
}

/** 连续剪贴板截图粘贴处理 (Ctrl+V) */
function handleClipboardPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.indexOf('image') !== -1) {
      const blob = item.getAsFile();
      if (blob) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target?.result as string;
          if (dataUrl) {
            const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
            const newImg: AttachedImage = {
              id: 'paste_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
              dataUrl,
              base64,
              name: '屏幕截图 ' + new Date().toLocaleTimeString(),
              type: 'screenshot',
            };
            attachedImages.push(newImg);
            updateAttachedMediaUI();
            saveCurrentSessionState();
            showToast('📸 成功载入第 ' + attachedImages.length + ' 张截图，已加入多模态研读池！');
          }
        };
        reader.readAsDataURL(blob);
      }
    }
  }
}

/** 处理批量传入的文件（PDF 与 图片可同时导入） */
async function handleIncomingFiles(files: File[]) {
  const pdfFiles = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  const imgFiles = files.filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(f.name));

  for (const imgFile of imgFiles) {
    await new Promise<void>((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const dataUrl = event.target?.result as string;
        if (dataUrl) {
          const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
          attachedImages.push({
            id: 'file_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            dataUrl,
            base64,
            name: imgFile.name,
            type: 'upload',
          });
        }
        resolve();
      };
      reader.readAsDataURL(imgFile);
    });
  }

  if (imgFiles.length > 0) {
    updateAttachedMediaUI();
    saveCurrentSessionState();
    showToast('🖼️ 成功载入 ' + imgFiles.length + ' 张图片到多模态研读池！');
  }

  if (pdfFiles.length > 0) {
    await handlePdfFile(pdfFiles[0]);
  }
}

/** 核心 PDF 高清 2.0x 渲染与多模态页面生成 */
async function handlePdfFile(file: File) {
  const container = document.getElementById('pdf-status-container');
  if (container) {
    container.innerHTML = '<div class="pdf-status" style="color:var(--accent-indigo)">⏳ 正在以 2.0x 高清渲染 PDF 每页视界与章节索引...</div>';
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const origin = window.location.origin;
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: origin + '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: origin + '/standard_fonts/',
      enableXfa: false,
    }).promise;
    
    pdfPages = [];
    let fullText = '';
    const detectedSections: string[] = [];
    const sectionRegex = /^(abstract|introduction|materials and methods|methods|results|discussion|results and discussion|conclusions?|quality control|supporting information|references)/i;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');

      let detectedSection = '';
      let textSnippet = '';

      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
          canvasContext: ctx,
          viewport: viewport,
          canvas: canvas,
        } as any).promise;

        const textContent = await page.getTextContent();
        for (const item of textContent.items as any[]) {
          const str = (item.str || '').trim();
          if (sectionRegex.test(str) && str.length < 40) {
            detectedSection = str.toUpperCase();
            if (!detectedSections.includes(detectedSection)) {
              detectedSections.push(detectedSection);
            }
          }
          if (textSnippet.length < 150 && str.length > 2) {
            textSnippet += str + ' ';
          }
        }
      }

      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');

      pdfPages.push({
        pageNumber: i,
        dataUrl,
        base64,
        width: viewport.width,
        height: viewport.height,
        detectedSection: detectedSection || (i === 1 ? 'TITLE & INTRO' : 'PAGE ' + i),
        snippet: textSnippet.trim(),
      });

      fullText += '\n\n[=== Page ' + i + ' ===]\n' + textSnippet + '\n';
    }

    uploadedPdfText = fullText;
    uploadedPdfName = file.name;
    uploadedPdfSectionSummary = detectedSections.slice(0, 6).join(' / ') || '全文结构已解析';
    selectedPdfPageIndices = [0];

    // 自动将会话标题更新为文献名
    const curSession = sessionsList.find((s) => s.id === currentSessionId);
    if (curSession && (curSession.title.startsWith('新文献') || curSession.title.startsWith('初遇'))) {
      curSession.title = '《' + file.name.replace(/\.pdf$/i, '') + '》';
    }

    updatePdfUI();
    updateAttachedMediaUI();
    await saveCurrentSessionState();

    showToast('✅ 成功载入《' + file.name + '》（共 ' + pdf.numPages + ' 页），已自动记忆存档！');
  } catch (err) {
    console.error('PDF 解析出错:', err);
    if (container) {
      container.innerHTML = '<div class="pdf-status" style="color:var(--accent-vermilion)">❌ PDF 解析失败，请检查文件是否加密或损坏。</div>';
    }
  }
}

/** 更新 PDF 状态与多选页面网格 */
function updatePdfUI() {
  const container = document.getElementById('pdf-status-container');
  const pagesContainer = document.getElementById('pdf-pages-container');

  if (container) {
    if (uploadedPdfName) {
      container.innerHTML = `
        <div class="pdf-status success">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>📄 ${uploadedPdfName}</strong>
            <button id="clear-pdf-btn" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:0.75rem;" title="移除当前 PDF">✕</button>
          </div>
          <div style="font-size:0.72rem; color:var(--text-secondary); margin-top:2px;">
            章节索引: ${uploadedPdfSectionSummary || '多模态高清解析完成'}
          </div>
        </div>
      `;
      document.getElementById('clear-pdf-btn')?.addEventListener('click', () => {
        pdfPages = [];
        uploadedPdfName = '';
        uploadedPdfText = '';
        uploadedPdfSectionSummary = '';
        selectedPdfPageIndices = [];
        updatePdfUI();
        updateAttachedMediaUI();
        saveCurrentSessionState();
        showToast('🗑️ 已移除 PDF 文献');
      });
    } else {
      container.innerHTML = '';
    }
  }

  if (pagesContainer) {
    if (pdfPages.length > 0) {
      pagesContainer.style.display = 'flex';
      pagesContainer.innerHTML = `
        <div class="pdf-pages-header">
          <span>📚 PDF 页面 (可多选同时送审):</span>
          <span style="font-weight:600; color:var(--accent-indigo);">已选 ${selectedPdfPageIndices.length} 页</span>
        </div>
        <div class="pdf-pages-grid">
          ${pdfPages
            .map(
              (p, idx) => `
            <div class="pdf-page-card ${selectedPdfPageIndices.includes(idx) ? 'active' : ''}" data-page-index="${idx}">
              <div class="pdf-page-thumb-box">
                <img class="pdf-page-thumb" src="${p.dataUrl}" alt="Page ${p.pageNumber}" />
                <div class="pdf-page-overlay-actions">
                  <button class="pdf-page-quick-read-btn" data-page-index="${idx}" title="一键开启第 ${p.pageNumber} 页深度领读">📖 精读本页</button>
                </div>
              </div>
              <div class="pdf-page-meta">
                <span class="pdf-page-badge">P.${p.pageNumber}</span>
                <span class="pdf-section-badge" title="${p.detectedSection}">${p.detectedSection}</span>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `;

      pagesContainer.querySelectorAll('.pdf-page-quick-read-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt((e.currentTarget as HTMLElement).getAttribute('data-page-index') || '0', 10);
          handleDeepReadSinglePage(idx);
        });
      });

      pagesContainer.querySelectorAll('.pdf-page-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          const mouseEvent = e as MouseEvent;
          const idx = parseInt(card.getAttribute('data-page-index') || '0', 10);
          
          if (mouseEvent.ctrlKey || mouseEvent.metaKey || mouseEvent.shiftKey) {
            if (selectedPdfPageIndices.includes(idx)) {
              selectedPdfPageIndices = selectedPdfPageIndices.filter((i) => i !== idx);
            } else {
              selectedPdfPageIndices.push(idx);
            }
          } else {
            selectedPdfPageIndices = [idx];
          }

          updatePdfUI();
          updateAttachedMediaUI();
          saveCurrentSessionState();
        });
      });
    } else {
      pagesContainer.style.display = 'none';
      pagesContainer.innerHTML = '';
    }
  }
}

/** 针对指定单页的一键领读启动 */
async function handleDeepReadSinglePage(pageIdx: number) {
  if (!pdfPages[pageIdx]) return;
  selectedPdfPageIndices = [pageIdx];
  currentMode = 'studio';
  updatePdfUI();
  updateAttachedMediaUI();
  updateModeUI();

  const targetPage = pdfPages[pageIdx];
  const prompt = '【单页领读指令 · 锁定第 ' + targetPage.pageNumber + ' 页】\n请聚焦《' + (uploadedPdfName || '目标文献') + '》第 ' + targetPage.pageNumber + ' 页（' + targetPage.detectedSection + '）的图像与排版文本（重点关注该页核心图表与数据段落），启动 Step 1/5 论证路线解剖：\n1. 锁定该页最核心的论证段落或图表说明（附带 [Exact Quote]）；\n2. 梳理该页从数据输入 -> 逻辑推导 -> 阶段性结论的因果链；\n3. 仅输出 Step 1，文末附带状态锁。';
  await handleSendWithCustomContent(prompt);
}

/** 挂载的图文池 UI (支持多图 + PDF 页面一并呈现) */
function updateAttachedMediaUI() {
  const bar = document.getElementById('attached-media-bar');
  if (!bar) return;

  const allItems: { id: string; name: string; dataUrl: string; base64: string; isPdfPage: boolean; pageIndex?: number; imgIndex?: number }[] = [];

  if (pdfPages.length > 0) {
    selectedPdfPageIndices.forEach((idx) => {
      if (pdfPages[idx]) {
        allItems.push({
          id: 'pdf_page_' + idx,
          name: 'P.' + (idx + 1) + ' (' + pdfPages[idx].detectedSection + ')',
          dataUrl: pdfPages[idx].dataUrl,
          base64: pdfPages[idx].base64,
          isPdfPage: true,
          pageIndex: idx,
        });
      }
    });
  }

  attachedImages.forEach((img, imgIdx) => {
    allItems.push({
      id: img.id,
      name: img.name,
      dataUrl: img.dataUrl,
      base64: img.base64,
      isPdfPage: false,
      imgIndex: imgIdx,
    });
  });

  if (allItems.length > 0) {
    bar.style.display = 'flex';
    bar.innerHTML = `
      <div class="attached-media-header">
        <span>🖼️ 当前多模态研读池 (共 ${allItems.length} 项，将一同送入大模型分析):</span>
        <button id="btn-clear-all-attachments" style="background:none; border:none; color:#dc2626; cursor:pointer; font-size:0.72rem;">🗑️ 清空所有挂载</button>
      </div>
      <div class="attached-media-chips-list">
        ${allItems
          .map(
            (item) => `
          <div class="attached-media-chip ${item.isPdfPage ? 'from-pdf' : ''}">
            <img class="attached-media-thumb" src="${item.dataUrl}" alt="Thumbnail" data-view-src="${encodeURIComponent(item.dataUrl)}" data-view-title="${encodeURIComponent(item.name)}" />
            <span class="attached-chip-title" title="${item.name}">${item.name}</span>
            <button class="attached-chip-btn btn-view-chip" data-view-src="${encodeURIComponent(item.dataUrl)}" data-view-title="${encodeURIComponent(item.name)}" title="查看大图">👁️</button>
            <button class="attached-chip-btn btn-remove-chip" data-is-pdf="${item.isPdfPage}" data-page-idx="${item.pageIndex ?? -1}" data-img-idx="${item.imgIndex ?? -1}" title="移除">✕</button>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    bar.querySelectorAll('.btn-view-chip, .attached-media-thumb').forEach((el) => {
      el.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const src = decodeURIComponent(target.getAttribute('data-view-src') || '');
        const title = decodeURIComponent(target.getAttribute('data-view-title') || '');
        if (src) showImageModal(src, title);
      });
    });

    bar.querySelectorAll('.btn-remove-chip').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const isPdf = target.getAttribute('data-is-pdf') === 'true';
        const pageIdx = parseInt(target.getAttribute('data-page-idx') || '-1', 10);
        const imgIdx = parseInt(target.getAttribute('data-img-idx') || '-1', 10);

        if (isPdf && pageIdx >= 0) {
          selectedPdfPageIndices = selectedPdfPageIndices.filter((i) => i !== pageIdx);
          updatePdfUI();
        } else if (!isPdf && imgIdx >= 0) {
          attachedImages.splice(imgIdx, 1);
        }
        updateAttachedMediaUI();
        saveCurrentSessionState();
      });
    });

    document.getElementById('btn-clear-all-attachments')?.addEventListener('click', () => {
      selectedPdfPageIndices = [];
      attachedImages = [];
      updatePdfUI();
      updateAttachedMediaUI();
      saveCurrentSessionState();
      showToast('🗑️ 已清空多模态研读池');
    });
  } else {
    bar.style.display = 'none';
    bar.innerHTML = '';
  }
}

/** 高清大图预览 Modal */
function showImageModal(src: string, title: string) {
  const modalRoot = document.getElementById('image-modal-root');
  if (!modalRoot) return;

  modalRoot.innerHTML = `
    <div class="image-modal-overlay" id="image-modal-backdrop">
      <div class="image-modal-content">
        <div class="image-modal-header">
          <strong style="font-size:0.85rem; color:var(--text-primary);">${title}</strong>
          <button id="close-image-modal" style="background:none; border:none; font-size:1.1rem; cursor:pointer; color:var(--text-secondary);">✕</button>
        </div>
        <div class="image-modal-body">
          <img src="${src}" alt="${title}" />
        </div>
      </div>
    </div>
  `;

  document.getElementById('close-image-modal')?.addEventListener('click', () => {
    modalRoot.innerHTML = '';
  });
  document.getElementById('image-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('image-modal-backdrop')) {
      modalRoot.innerHTML = '';
    }
  });
}

/** 领读分步动作 1：启动领读 (仅输出 Step 1) */
async function handleStartStep1() {
  currentMode = 'studio';
  updateModeUI();
  const count = getTotalAttachedMediaCount();
  const hint = count > 0 ? '已挂载 ' + count + ' 项图文' : '当前文献段落';
  const prompt = '【领读工坊启动 · 仅输出 Step 1/5 论证路线解剖】\n请针对【' + hint + '】，严格执行单步领读，本次回复【仅输出 Step 1】（原段锁定 + 论证路线草图 Argumentation Blueprint + 逐句逻辑链透视）。\n⚠️ 铁律：严禁在本次回复中输出 Step 2~5！文末必须以 *(当前状态: Step 1/5 论证路线解剖完成 🔒 | 请沉下心研读后回复【下一步】或【进入Step 2】)* 结尾。';
  await handleSendWithCustomContent(prompt);
}

/** 领读分步动作 2：进入下一步 */
async function handleNextStep() {
  currentMode = 'studio';
  updateModeUI();
  const prompt = '【进入领读下一步】请根据当前领读进度，仅输出下一个 Step 的内容（严禁跨步输出多个步骤，让读者保持专注）。';
  await handleSendWithCustomContent(prompt);
}

/** 领读分步动作 3：Step 2 攻防修辞 */
async function handleStep2() {
  currentMode = 'studio';
  updateModeUI();
  const prompt = '【进入 Step 2/5 语气与攻防修辞解剖刀】\n请针对刚才的段落，仅输出 Step 2（修辞力度扫描 + 攻防意图揭示：进攻点与防御性 Hedging 语气）。\n⚠️ 严禁输出后续步骤，文末附带状态锁标签。';
  await handleSendWithCustomContent(prompt);
}

/** 领读分步动作 4：Step 3 思维博弈题 */
async function handleStep3() {
  currentMode = 'studio';
  updateModeUI();
  const prompt = '【进入 Step 3/5 大牛思维博弈题】\n请针对该段落提出 1 道启发性的大牛思维博弈题（如去掉限定词会有何审稿人质疑）。\n⚠️ 仅输出该思考题并等待读者回答，文末附带状态锁标签。';
  await handleSendWithCustomContent(prompt);
}

/** 领读分步动作 5：Step 4 句式与造句 */
async function handleStep4() {
  currentMode = 'studio';
  updateModeUI();
  const prompt = '【进入 Step 4/5 顶刊学术句式萃取与迁移造句】\n请从该段中提炼 2 个句式公式（结构模板 + 修辞功能 + 适用语境），并结合海洋碳循环/地球化学提出 1 个造句实战挑战。\n⚠️ 仅输出句式与任务，文末附带状态锁标签。';
  await handleSendWithCustomContent(prompt);
}

/** 领读分步动作 6：Step 5 资产沉淀 */
async function handleStage2AssetExtraction() {
  currentMode = 'studio';
  updateModeUI();
  const prompt = '【进入 Step 5/5 导师红笔精修与三维资产沉淀卡】\n请对读者的造句进行顶刊级红笔润色，并沉淀【今日三维核心学术资产卡】（句式资产 + 机理资产 + 实操技巧）。';
  await handleSendWithCustomContent(prompt);
}

/** 快捷动作：阶段一 全局认知预热 */
async function handleStage1Overview() {
  currentMode = 'warmup';
  updateModeUI();
  const count = getTotalAttachedMediaCount();
  const hint = count > 0 ? '（请基于当前挂载的 ' + count + ' 项图文/单页展开）' : '';
  const prompt = '【阶段一：全局认知预热】请仔细审阅已挂载的文献图文' + hint + '，输出 4 项关键快照卡片：\n1. 🎴 核心科学矛盾与反常现象（必须附带原句 [Exact Quote]）\n2. 🎴 30秒极简论证路线草图（基线 -> 矛盾 -> 实验破局 -> 机制升华）\n3. 🎴 关键图表指引 (Key Figures & Evidence)\n4. 🎴 3 个阶梯思考题 (Scaffolding Questions)';
  await handleSendWithCustomContent(prompt);
}

/** 快捷动作：一键保存本章资产卡并准备新章节 */
async function handleArchiveAndNext() {
  const prompt = '【保存本章精读笔记并准备开启新章节】\n请对我们刚才研讨的所有精华进行结构化提炼，输出标准【📚 永久学术资产卡 (Permanent Literature Vault Card)】（包含因果骨架、攻防修辞深度剖析、顶刊句式与精修版、机理模型与实操技巧），并在末尾输出 [ARCHIVE_SAVED_SUCCESS] 与新章节推进指引。';
  await handleSendWithCustomContent(prompt);
}

async function handleSendWithCustomContent(customPrompt: string) {
  const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.value = customPrompt;
    await handleSend();
  }
}

/** 断点恢复模板填入 */
function fillRecoveryTemplate() {
  const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
  if (textarea) {
    textarea.value = '【恢复研讨】\n1. 【文献标题】：' + (uploadedPdfName ? '《' + uploadedPdfName + '》' : '[请填写文献名称]') + '\n2. 【中断前轮次】：Step 2/5 (攻防修辞透视)\n3. 【已达成的核心共识】：[简要列出前序步骤已闭环的论证路线]\n4. 【待继续探讨的议题/追问】：[简要列出中断前的遗留问题或您的回答]';
    textarea.focus();
    textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/** Crossref 学术搜索处理 */
async function handleScholarSearch() {
  const queryInput = document.getElementById('scholar-query') as HTMLInputElement;
  const resultsContainer = document.getElementById('scholar-results-container');
  if (!queryInput || !resultsContainer) return;

  const query = queryInput.value.trim();
  if (!query) {
    showToast('请输入文献关键词或 DOI');
    return;
  }

  resultsContainer.innerHTML = '<div class="loading-spinner">⏳ 正在调取全球海洋地球化学文献库...</div>';

  try {
    const isDoi = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(query);
    const url = isDoi
      ? 'https://api.crossref.org/works/' + encodeURIComponent(query) + '?mailto=academic-coach@research.org'
      : 'https://api.crossref.org/works?query=' + encodeURIComponent(query) + '&rows=4&sort=relevance&mailto=academic-coach@research.org';

    const res = await fetch(url);
    if (!res.ok) throw new Error('Crossref API 响应异常: ' + res.status);
    const data = await res.json();

    const items = isDoi ? [data.message] : data.message?.items || [];
    if (items.length === 0) {
      resultsContainer.innerHTML = '<div class="no-results-hint">未检索到匹配文献，请尝试更换关键词。</div>';
      return;
    }

    scholarResults = items.map((item: any) => {
      const title = Array.isArray(item.title) ? item.title[0] : item.title || 'Untitled';
      const authors = (item.author || []).map((a: any) => ((a.given || '') + ' ' + (a.family || '')).trim()).slice(0, 3).join(', ') + ((item.author || []).length > 3 ? ' et al.' : '');
      const journal = Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'] || 'Academic Journal';
      const year = item.created?.['date-parts']?.[0]?.[0] || 'Unknown';
      const doi = item.DOI || '';
      const url = item.URL || (doi ? 'https://doi.org/' + doi : '');
      const scholarUrl = 'https://scholar.google.com/scholar?q=' + encodeURIComponent(title);
      const abstract = item.abstract ? item.abstract.replace(/<[^>]+>/g, '') : undefined;

      return { title, authors, journal, year, doi, url, scholarUrl, abstract };
    });

    updateScholarUI();
  } catch (err: any) {
    console.error('Scholar Search Error:', err);
    resultsContainer.innerHTML = '<div class="no-results-hint" style="color:var(--accent-vermilion)">❌ 检索失败: ' + (err.message || '网络连接超时') + '</div>';
  }
}

function updateScholarUI() {
  const container = document.getElementById('scholar-results-container');
  if (!container) return;

  if (scholarResults.length === 0) {
    container.innerHTML = '<div class="no-results-hint">可在上方输入关键词，实时调取文献。</div>';
    return;
  }

  container.innerHTML = scholarResults
    .map(
      (paper) => `
      <div class="scholar-card">
        <div class="scholar-card-title">${paper.title}</div>
        <div class="scholar-card-meta">${paper.authors} · <em>${paper.journal}</em> (${paper.year})</div>
        <div class="scholar-card-actions">
          ${paper.url ? `<a href="${paper.url}" target="_blank" class="scholar-link">DOI 🔗</a>` : ''}
          <a href="${paper.scholarUrl}" target="_blank" class="scholar-link">Google Scholar ↗</a>
          <button class="scholar-btn-fill" data-title="${encodeURIComponent(paper.title)}" data-doi="${encodeURIComponent(paper.doi)}">✍️ 载入研读</button>
        </div>
      </div>
    `
    )
    .join('');

  container.querySelectorAll('.scholar-btn-fill').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const title = decodeURIComponent(target.getAttribute('data-title') || '');
      const doi = decodeURIComponent(target.getAttribute('data-doi') || '');
      const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
      if (textarea) {
        textarea.value = '【精读研讨请求】\n1. 【文献标题】：' + title + '\n2. 【DOI】：' + doi + '\n3. 【文献类型】：A. 实证观测/实验\n4. 【研读目标】：开展立论格局与攻防修辞深度解剖';
        textarea.focus();
        showToast('📖 已载入文献《' + title.slice(0, 30) + '...》元数据！');
      }
    });
  });
}

/** 渲染聊天历史 */
function updateChatUI() {
  const container = document.getElementById('chat-messages');
  const welcome = document.getElementById('welcome-box');
  if (!container) return;

  if (chatHistory.length > 0 && welcome) {
    welcome.style.display = 'none';
  } else if (chatHistory.length === 0 && welcome) {
    welcome.style.display = 'block';
    container.innerHTML = '';
    container.appendChild(welcome);
    return;
  }

  container.innerHTML = chatHistory
    .map((msg, index) => {
      const isUser = msg.role === 'user';
      const modeObj = MODES.find((m) => m.id === msg.mode);
      const modeBadge = modeObj ? `<span class="temp-badge" style="font-size:0.65rem; margin-bottom:0.3rem; display:inline-block;">${modeObj.name}</span>` : '';
      
      const mediaBadge = msg.attachedSummary ? `
        <div style="font-size:0.75rem; color:#1e40af; background:#eef4ff; padding:3px 8px; border-radius:4px; margin-bottom:6px; display:inline-flex; align-items:center; gap:4px;">
          🖼️ 挂载多模态图文: <strong>${msg.attachedSummary}</strong>
        </div>
      ` : '';

      return `
        <div class="message ${isUser ? 'user-message' : 'assistant-message'}" data-index="${index}">
          <div class="message-avatar">${isUser ? '👤' : '🌊'}</div>
          <div class="message-content">
            ${modeBadge}
            ${mediaBadge}
            <div class="markdown-body" id="msg-body-${index}">
              ${msg.content ? safeMarkdown(msg.content) : '<div class="smooth-progress-pill">⚡ 资深同行审稿人正在单步领读解剖中... 正在解析当前步骤...</div>'}
            </div>
            ${!isUser && msg.content ? `
              <div class="message-actions">
                <button class="msg-action-btn copy-btn" data-index="${index}">📋 复制回答</button>
                <button class="msg-action-btn export-card-btn" data-index="${index}">📇 导出本条卡片</button>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt((e.currentTarget as HTMLElement).getAttribute('data-index') || '0', 10);
      const text = chatHistory[idx]?.content || '';
      navigator.clipboard.writeText(text);
      showToast('📋 已复制回答全文至剪贴板！');
    });
  });

  container.querySelectorAll('.export-card-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt((e.currentTarget as HTMLElement).getAttribute('data-index') || '0', 10);
      const text = chatHistory[idx]?.content || '';
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Ocean_Literature_Card_' + Date.now() + '.md';
      a.click();
      URL.revokeObjectURL(url);
      showToast('📇 已成功导出为 Markdown 学术资产卡片！');
    });
  });

  scrollToBottom();
}

function updateLastMessageContent(markdownText: string) {
  const index = chatHistory.length - 1;
  const targetElement = document.getElementById('msg-body-' + index);
  if (targetElement) {
    targetElement.innerHTML = safeMarkdown(markdownText);
  }
}

function scrollToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) {
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }
}

function showToast(message: string) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.style.cssText = 'position: fixed; bottom: 2rem; right: 2rem; background: var(--accent-indigo); color: #fff; padding: 0.6rem 1.2rem; border-radius: 6px; font-size: 0.82rem; box-shadow: 0 6px 16px rgba(0,0,0,0.15); z-index: 10000; transition: opacity 0.3s ease, transform 0.3s ease; transform: translateY(10px); opacity: 0; pointer-events: none;';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';

  setTimeout(() => {
    if (toast) {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
    }
  }, 3200);
}

/** 核心发送与多模态 Gemini API 调用处理 (支持多图 + 多单页联合输入) */
async function handleSend() {
  if (isGenerating) return;

  const textarea = document.getElementById('user-input') as HTMLTextAreaElement;
  if (!textarea) return;

  const content = textarea.value.trim();
  if (!content) return;

  const activeMediaList: { name: string; base64: string }[] = [];

  if (pdfPages.length > 0) {
    selectedPdfPageIndices.forEach((idx) => {
      if (pdfPages[idx]) {
        activeMediaList.push({
          name: '《' + uploadedPdfName + '》第 ' + (idx + 1) + ' 页 (' + pdfPages[idx].detectedSection + ')',
          base64: pdfPages[idx].base64,
        });
      }
    });
  }

  attachedImages.forEach((img) => {
    activeMediaList.push({
      name: img.name,
      base64: img.base64,
    });
  });

  const attachedSummary = activeMediaList.map((m) => m.name).join(' + ') || undefined;

  textarea.value = '';

  // 演示模式
  if (!apiKey) {
    chatHistory.push({
      role: 'user',
      content,
      mode: currentMode,
      attachedSummary,
    });
    updateChatUI();

    chatHistory.push({
      role: 'assistant',
      content: simulateAgentResponse(content, currentMode),
    });
    updateChatUI();
    saveCurrentSessionState();
    return;
  }

  const selectedMode = MODES.find((m) => m.id === currentMode);
  let userMessageText = '【当前研读模式】：' + (selectedMode?.name || '') + '\n【用户需求与研读指令】：\n' + content;

  if (activeMediaList.length > 0) {
    userMessageText += '\n\n[附注：本次已同时挂载 ' + activeMediaList.length + ' 项多模态图文 (' + attachedSummary + ')，请直接基于这些图像中的排版、数据、图表与原句展开综合解剖与审查。]';
  }

  // 领读模式状态机护栏
  if (currentMode === 'studio') {
    if (content.includes('【一键输出全文5步】')) {
      // 允许放行全篇
    } else {
      const isAdvancingStep = /(【下一步】|【进入下一步】|【进入\s*Step\s*[1-5]】)/i.test(content);
      const isContinuingDeepRead = /(继续|逐句|接下|后半段|第\s*\d+\s*句|后续|深挖|承接)/i.test(content);

      if (isContinuingDeepRead && !isAdvancingStep) {
        userMessageText += '\n\n[System Guardrail 🚨 (Step 1 顺延续读硬锁生效): 用户希望继续精读当前单页的【后续段落与剩余句子】！\n⚠️ 绝对严禁跳到 Step 2 (攻防修辞)！\n请检查上一条回复已经解析到的最后一句（如 Sentence 4），本次回复必须从下一句（如 Sentence 5, 6, 7...）开始顺延输出：\n1. 【📍 后续原段锁定】；\n2. 【🗺️ 论证路线延伸】；\n3. 【🔍 逐句逻辑链透视 (Sentence-by-Sentence)】：\n   - ⚠️ 严禁死板套用“起承转合”四个字，按真实句子流标注功能标签（如 数据呈现、对比PK、机制归因等）；\n   - ⚠️ 每一句必须显式附带【🔤 英文原句: "..."】（完整英文原文，让读者在 PDF 上精准对位）+【💡 逻辑透视】！\n文末必须保持状态锁：*(当前状态: Step 1/5 论证路线续读完成 🔒 [STATE_LOCK_ACTIVE] | 可继续回复【继续逐句】研读剩余段落，或点击【▶️ 进入下一步】开启 Step 2)*。]';
      } else if (isAdvancingStep) {
        userMessageText += '\n\n[System Guardrail: 收到放行指令，允许推进到下一个领读 Step（如 Step 2 语气与攻防修辞，或用户指定的 Step）。请紧密承接前文已解剖的论证逻辑，输出该 Step 专属内容，文末附带状态锁。]';
      } else {
        userMessageText += '\n\n[System Guardrail 🔒: 本次回复必须且仅能输出当前单个 Step！\n⚠️ 特别注意：在 Step 1 逐句透视中，严禁死板套用“起承转合”四个字，必须按原文真实的句子流（2~6句）逐一分析，且每一句【必须附带完整的英文原句 Exact Quote】方便读者对照 PDF 查对！文末附带状态锁。]';
      }
    }
  }

  // 精读模式状态机护栏
  if (currentMode === 'deep') {
    const isAdvancingRound = /(【进入下一轮】|【进入\s*Round\s*[1-4]】)/i.test(content);
    if (isAdvancingRound) {
      userMessageText += '\n\n[System Guardrail: 收到通行令【进入下一轮】，允许解除状态锁并推进至下一轮。请输出下一轮的【逻辑衔接】与【客观证据锚定】。]';
    } else if (content.includes('【概念求助')) {
      userMessageText += '\n\n[System Guardrail: 收到概念求助，请暂停当前追问，仅输出【概念深度破译与物理图景】，文末保持 [STATE_LOCK_ACTIVE]。]';
    } else if (content.includes('【恢复研讨')) {
      userMessageText += '\n\n[System Guardrail: 收到断点恢复请求，请输出【断点恢复与上下文对齐】并接续当前轮次。]';
    } else if (content.includes('【完成研讨') || content.includes('三维核心学术资产卡') || content.includes('保存本章')) {
      userMessageText += '\n\n[System Guardrail: 收到归档/完成研讨指令，请生成完整结构化的【三维核心学术资产卡 / 永久学术资产卡】，文末附带新章节选项。]';
    } else {
      userMessageText += '\n\n[System Guardrail 负向硬锁生效中: 用户未输入【进入下一轮】。严禁跨轮输出下一轮锚定！必须先输出【逻辑红笔点评】，再输出当前轮次的【追击短问】，文末强制标注 *(当前状态: Round X/4 轮内研讨打磨中 🔒 [STATE_LOCK_ACTIVE] | 必须显式输入【进入下一轮】方可解锁新轮次)*。]';
    }
  }

  chatHistory.push({
    role: 'user',
    content,
    mode: currentMode,
    attachedSummary,
  });

  chatHistory.push({ role: 'assistant', content: '' });
  const assistantMsgIndex = chatHistory.length - 1;

  isGenerating = true;
  updateChatUI();

  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = '⚡ 深度解剖中...';
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    let dynamicSystem = SYSTEM_INSTRUCTION;
    if (uploadedPdfText) {
      const truncated = uploadedPdfText.length > 300_000 ? uploadedPdfText.slice(0, 300_000) + '...[截断]' : uploadedPdfText;
      dynamicSystem += '\n\n# 【已载入文献全篇正文文本索引】\n文件名：' + uploadedPdfName + '\n已识别结构：' + uploadedPdfSectionSummary + '\n' + truncated;
    }

    const contents: any[] = [];
    const filteredHistory = chatHistory.slice(0, -1);

    filteredHistory.forEach((m, idx) => {
      const isLatestUser = idx === filteredHistory.length - 1 && m.role === 'user';
      const parts: any[] = [];

      if (isLatestUser && activeMediaList.length > 0) {
        activeMediaList.forEach((media) => {
          parts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: media.base64,
            },
          });
        });
      }

      parts.push({ text: isLatestUser ? userMessageText : m.content });
      contents.push({
        role: m.role === 'user' ? 'user' : 'model',
        parts,
      });
    });

    const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
    const customModelInput = document.getElementById('custom-model-input') as HTMLInputElement;
    let primaryModel = modelSelect?.value || 'gemini-3.6-flash';
    if (primaryModel === 'custom') {
      primaryModel = customModelInput?.value.trim() || 'gemini-3.6-flash';
    }

    const fallbackModels = Array.from(new Set([primaryModel, 'gemini-3.6-flash', 'gemini-2.0-flash', 'gemini-2.5-flash']));

    let streamSuccess = false;
    let lastError: any = null;

    for (const modelCandidate of fallbackModels) {
      try {
        if (modelCandidate !== primaryModel) {
          showToast('⚡ 模型 ' + primaryModel + ' 繁忙，已自动切换至【' + modelCandidate + '】继续单步领读...');
        }

        let chunkBuffer = '';
        let lastRenderTime = 0;
        const RENDER_INTERVAL = 120;

        const responseStream = await ai.models.generateContentStream({
          model: modelCandidate,
          contents,
          config: {
            systemInstruction: dynamicSystem,
            temperature: selectedMode?.temp ?? 0.3,
          },
        });

        for await (const chunk of responseStream) {
          const text = chunk.text;
          if (text) {
            chunkBuffer += text;
            chatHistory[assistantMsgIndex].content = chunkBuffer;

            const now = Date.now();
            if (now - lastRenderTime > RENDER_INTERVAL || text.includes('\n')) {
              updateLastMessageContent(chunkBuffer);
              scrollToBottom();
              lastRenderTime = now;
            }
          }
        }

        updateLastMessageContent(chatHistory[assistantMsgIndex].content);
        scrollToBottom();
        streamSuccess = true;
        break;
      } catch (streamErr: any) {
        console.warn('Streaming error on ' + modelCandidate + ', trying standard generateContent:', streamErr);
        try {
          const response = await ai.models.generateContent({
            model: modelCandidate,
            contents,
            config: {
              systemInstruction: dynamicSystem,
              temperature: selectedMode?.temp ?? 0.3,
            },
          });

          if (response.text) {
            chatHistory[assistantMsgIndex].content = response.text;
            updateLastMessageContent(response.text);
            scrollToBottom();
            streamSuccess = true;
            break;
          }
        } catch (genErr) {
          lastError = genErr;
          continue;
        }
      }
    }

    if (!streamSuccess && lastError) {
      throw lastError;
    }
  } catch (error: any) {
    console.error('LLM API Error:', error);
    chatHistory[assistantMsgIndex].content = '❌ **调用 Gemini API 出错**: `' + (error?.message || 'API Key 无效或网络连接中断') + '`\n\n💡 **建议**：\n1. 请检查右上角 API Key 是否填写正确。\n2. 可在右上角切换为 **Gemini 2.0 Flash** 提高稳定性。\n3. 若需体验功能，可清空右上角 Key 并保存，体验【演示模式】。';
    updateLastMessageContent(chatHistory[assistantMsgIndex].content);
  } finally {
    isGenerating = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = '发送研读请求 🚀';
    }
    saveCurrentSessionState();
  }
}

/** 模拟模式回复 */
function simulateAgentResponse(input: string, mode: 'warmup' | 'rapid' | 'deep' | 'studio'): string {
  const count = getTotalAttachedMediaCount();
  const targetLabel = count > 0 ? '当前挂载的 ' + count + ' 项图文' : '已载入文献';

  if (input.includes('保存本章') || input.includes('永久学术资产卡')) {
    return '### 📚 【文献研讨档案 · 永久学术资产卡】(' + targetLabel + ')\n\n' +
      '> **存档时间**：' + new Date().toLocaleDateString() + ' | **研讨主题**：大洋深层 RDOC 动力学与微生物微型泵机制\n\n' +
      '#### 🗺️ 1. 论证路线因果骨架 (Argumentation Blueprint)\n' +
      '`[传统共识: RDOC千年惰性死库]` ➔ `[观测异象: 14C同位素非守恒周转]` ➔ `[方法破局: FT-ICR-MS超高分辨质谱]` ➔ `[机制假说: 深海微生物原位持续合成顽固分子]`\n\n' +
      '#### 🔍 2. 核心证据与攻防修辞深度剖析\n' +
      '- **[Sentence 1 原文 Exact Quote]**: *"While the RDOC reservoir has traditionally been regarded as an immutable geochemical sink, emerging radiocarbon anomalies indicate localized, non-conservative dynamic turnover."*\n' +
      '  - *审稿人视角*: 作者以 `While ...` 从句优雅立论，既尊重了前人传统共识，又通过 `emerging radiocarbon anomalies` 制造强烈的认知张力。\n\n' +
      '#### 📇 3. 顶刊学术句式库与实战润色 (Writing Assets)\n' +
      '- **【句式公式】**: `While [Traditional Paradigm] has long been deemed [State], emerging high-resolution profiles reveal [Novel Process].`\n' +
      '- **【顶刊润色版】**: *While deep oceanic DOC has long been presumed geochemically inert, emerging high-resolution data indicates decadal microbial synthesis.*\n\n' +
      '#### 💡 4. 生物地球化学机理洞察与实操技巧\n' +
      '- **机理模型**: 深海并非绝对死库，超微量有机组分通过微型生物碳泵 (MCP) 处于动态合成与稀释平衡中。\n' +
      '- **实操技巧**: 深海超微量样品必须经 450°C 预灼烧高纯玻璃瓶保存，杜绝塑料浸出污染。\n\n' +
      '---\n\n' +
      '🎉 `[ARCHIVE_SAVED_SUCCESS]: 本章节研讨精华已成功生成并封存至文献库！`\n' +
      '🔄 `上下文状态机已就绪，请选择下一步研读方向：`\n' +
      '- 选项 1️⃣：**【开启同文献下一章节】** —— 粘贴下一页/下一段（自动继承前序共识，直接启动 Step 1 论证解剖）。\n' +
      '- 选项 2️⃣：**【带着本章结论对比新段落】** —— 探讨后续章节是如何证实/推翻本段假说的。\n' +
      '- 选项 3️⃣：**【开启全新文献研读】** —— 点击左侧【➕ 开启新文献研读】，彻底重置工作区。';
  }

  if (mode === 'studio') {
    if (input.includes('Step 2') || input.includes('语气与攻防修辞')) {
      return '### 🔍 【领读工坊 · Step 2/5 语气与攻防修辞解剖刀】(' + targetLabel + ')\n\n' +
        '- **【修辞力度扫描】**:\n' +
        '  - *进攻点*: 作者在引述自身实测数据时使用 `unequivocally demonstrates`，展现对实验质控（HTCO 与 CRM 校准）的极强自信。\n' +
        '  - *防守点*: 在推导全球碳通量时，作者极为克制地使用了 `tentatively suggests that DOC dynamics may operate on decadal timescales`，成功防范了审稿人关于“单航次过度外推”的致命一击。\n\n' +
        '*(当前状态: Step 2/5 攻防修辞透视完成 🔒 | 请体会作者在进攻与防守间的修辞分寸，随后点击【▶️ 进入下一步】或输入你的感悟)*';
    }

    if (input.includes('Step 3') || input.includes('思维博弈题')) {
      return '### ♟️ 【领读工坊 · Step 3/5 大牛思维博弈题】(' + targetLabel + ')\n\n' +
        '> 📌 **思考题**：*“请注意第 2 句作者在引入深海周转速率时添加了 `localized` 这一限定词。如果去掉这个词，审稿人在同行评审中会提出怎样的致命攻击？作者这样写的‘防守智慧’是什么？”*\n\n' +
        '*(当前状态: Step 3/5 思维博弈思考中 🔒 | 请在下方输入框中写下您的推测，或点击【▶️ 进入下一步】解锁句式萃取)*';
    }

    if (input.includes('Step 4') || input.includes('句式与造句')) {
      return '### ✍️ 【领读工坊 · Step 4/5 顶刊学术句式萃取与迁移造句】(' + targetLabel + ')\n\n' +
        '#### 📇 句式公式 A (优雅转折 + 指出前人认知断层)\n' +
        '`While [Traditional Paradigm] has long been viewed as [Immutable State], emerging evidence demonstrates [Contradictory Observation], suggesting that [Novel Mechanism] plays an underappreciated role in [Target Marine System].`\n\n' +
        '#### 📇 句式公式 B (强调方法排他性与结论确定性)\n' +
        '`To disentangle [Confounding Factor X] from [Core Process Y], we performed [High-Resolution Sampling/QC], thereby providing unambiguous constraints on [Key Biogeochemical Flux].`\n\n' +
        '> 🎯 **迁移造句实战挑战**：请选择【公式 A】或【公式 B】，为你关注的海洋碳循环/DOC/氨基酸数据写出 1 句破局句！\n\n' +
        '*(当前状态: Step 4/5 迁移造句实战中 🔒 | 请在下方提交您的造句接受导师红笔精修，或点击【🏆 Step 5 资产沉淀】)*';
    }

    if (input.includes('Step 5') || input.includes('资产沉淀')) {
      return '### 🏆 【领读工坊 · Step 5/5 导师红笔精修与三维资产沉淀卡】(' + targetLabel + ')\n\n' +
        '#### ✍️ 导师写作红笔点评与润色\n' +
        '- **【亮点评析】**: 成功运用了 While 对比从句，准确建立了旧范式与新数据的张力。\n' +
        '- **【红笔精修】**:\n' +
        '  * 🔴 *Original*: While deep DOC was thought to be inert, our new data shows rapid turnover by microbes.\n' +
        '  * 🟢 *Polished (Nature Level)*: *While the deep ocean DOC reservoir has long been deemed geochemically inert, emerging high-resolution profiles reveal rapid microbial turnover on decadal scales.*\n\n' +
        '---\n\n' +
        '### 📇 【今日三维核心学术资产卡】\n' +
        '- 📇 **【句式资产】**: `While [Paradigm] has long been deemed [State], emerging evidence reveals [Observation].`\n' +
        '- 💡 **【机理资产】**: 深海 DOC 并非绝对惰性死库，微型生物碳泵 (MCP) 与生态稀释动态调节其有效周转。\n' +
        '- 🛠️ **【实操技巧】**: 低浓度深水采样须用 450°C 预灼烧高硼硅玻璃管，杜绝 PE 瓶污染。';
    }
  }

  return '### 🌊 【海洋地球化学文献导师解析】(' + targetLabel + ')\n\n' +
    '已接收研读指令。请在左侧多模态图文池中选择页面或输入问题，我们将一步步拆解立论逻辑与攻防修辞。';
}

// 启动应用
initApp();
