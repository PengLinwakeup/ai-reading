# Ocean & Geochemistry Agent Evaluation Benchmark Cases

本评测案例集用于测试 Agent 的贪婪采样控制（Greedy Sampling）、Exact Quote 强引用约束、定量数据核算表（Quantitative Verification Table）以及 Self-Verification 自我审查机制。

---

## Test Case 1: DOC 分析测量空白与 CRM 漏洞 (Exact Quote & Quantitative Table Verification)

### 假想/测试文献片段
- **Title**: *Rapid Accumulation of Refractory Dissolved Organic Carbon in Global Deep Ocean*
- **Methods Snippet [Section 2.2]**: "DOC concentration was measured using a High-Temperature Catalytic Oxidation (HTCO) system (Shimadzu TOC-L). Samples were filtered through 0.45 μm PTFE filters and stored at -20°C in polyethylene bottles. Instrument blank was checked using Milli-Q water before each run batch. Deep sea reference water was measured occasionally."
- **Results Snippet [Section 3.1]**: "Deep water DOC concentrations averaged 54 ± 2 μmol/L across all 15 stations in the North Pacific (p < 0.05)."

### 预期 Agent 踩坑/缺陷检测指标 (Evaluation Rubric)
1. **Self-Verification Loop**：
   - 输出中必须显式包含 `<Self-Verification Log>`，展示真实比对逻辑。
2. **Exact Quote 强引用**：
   - 提取提取 `0.45 μm PTFE` 和 `polyethylene bottles` 时，必须附带：
     `[Exact Quote: "Samples were filtered through 0.45 μm PTFE filters and stored at -20°C in polyethylene bottles."]`
3. **定量数据核验表 (Quantitative Data Verification Table)**：
   - 必须独立列出：变量 `DOC Concentration` | 样本量 `n=15` | 均值误差 `54 ± 2 μmol/L` | `p < 0.05` | 水团 `North Pacific Deep Water` | Exact Quote 附带。

---

## Test Case 2: MCP 模型过度外推与概率采样防漂移测试

### 假想/测试文献片段
- **Title**: *Microbial Carbon Pump Driven Refractory DOC Production Rates in Marine Ecosystems*
- **Methods Snippet [Section 2.3 & Table 1]**: "Single-station incubation experiments were conducted using surface seawater (0-5m) from a coastal bay in July 2024. Bacterial production and D/L-amino acid ratios (D-Ala, D-Glu) were measured over 30 days."
- **Discussion Snippet [Section 4.3]**: "Based on our incubation results, we calculate that the global ocean microbial carbon pump converts 0.2 Pg C/year of labile DOC into refractory DOC in the mesopelagic and bathypelagic layers globally."

### 预期 Agent 踩坑/缺陷检测指标 (Evaluation Rubric)
1. **In-Context Grounding & Exact Quotes**：
   - 针对近岸表层与全球深层外推逻辑鸿沟，必须准确对齐引用 `[Section 2.3]` 原句 `[Exact Quote: "Single-station incubation experiments were conducted using surface seawater (0-5m) from a coastal bay..."]`。
2. **Greedy Sampling (T=0.0)**：
   - 严禁引入文章中没有提到的深海菌种或温度数值作为既定事实，未提到的信息必须显式标注 `[Exact Quote: NONE FOUND - Unsubstantiated]`。

---

## Test Case 3: 领读拆解与顶刊学术句式萃取 (Mode 3: Guided Walkthrough & Sentence Formula Extraction)

### 假想/测试文献片段
- **Title**: *Dynamic Turnover and Molecular Recalcitrance of Dissolved Organic Matter in the Deep Pacific*
- **Introduction Snippet [Section 1 / Page 1]**: "While the vast reservoir of oceanic refractory dissolved organic carbon (RDOC) has traditionally been regarded as an inert byproduct of surface biological production, emerging radiocarbon and molecular data reveal unexpected temporal variability in the deep North Pacific. However, the exact biochemical mechanisms underpinning this non-conservative behavior remain largely enigmatic, obscured by the analytical challenges of isolating ultra-dilute compounds. Here, using ultrahigh-resolution mass spectrometry coupled with compound-specific isotope analysis, we demonstrate that microbial community metabolism continuously synthesizes structurally unique recalcitrant molecules in the bathypelagic zone."

### 预期 Agent 教学与句式萃取指标 (Evaluation Rubric)
1. **Step 1: 精选段落与逐句逻辑链透视**：
   - 完整保留并展示英文原段 `[Section 1 / Page 1]`。
   - 逐句透视 4 层结构：Sentence 1 (宏大共识与反常悬念) -> Sentence 2 (现有方法局限与知识断层) -> Sentence 3 (破局手段与核心发现)。
2. **Step 2: 顶刊学术句式公式 (Sentence Formula)**：
   - 提炼高质量带槽位模板（如 `While [A] has traditionally been regarded as [B], emerging [Data/Evidence] reveal unexpected [Phenomenon] in [Target System]...`）。
   - 标注适用语境与修辞功能。
3. **Step 3: 迁移写作实战挑战与红笔点评 (Writing Challenge & Mentor Polish)**：
   - 提出迁移写作任务；当用户提交仿写后，输出 `### ✍️ 【导师写作红笔点评与润色】`，给出 Original 对比与 Polished 地道英文修改建议。

