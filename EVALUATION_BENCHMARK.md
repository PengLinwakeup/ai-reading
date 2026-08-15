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
