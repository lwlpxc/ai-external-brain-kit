---
type: summary
tags: [AI, Transformer, RAG, 学习方法]
sources: ["../../../raw/notion/AI学习/Transformer知识.md", "../../../raw/notion/AI学习/RAG落地.md", "../../../raw/notion/AI学习/skill.md"]
created: 2026-10-19
updated: 2026-10-19
---

# 摘要：AI 学习（Transformer / RAG / skill）

三篇 AI 学习笔记聚合。

## Transformer

- **演进线**：N-gram（不懂词间关系）→ Embedding 词向量 → FFN（长度不够）→ RNN（长期记忆差）→ LSTM（一个一个算效率低、远距离传不了）→ Transformer 让远距离 token 直接建立联系
- **Attention**：Q 主动查询 / K 被动被匹配 / V 收集信息，Q-K 匹配度建立联系；多头注意力让多个 token 互相理解
- **三个问题与解法**：并行计算丢顺序 → 位置编码；猜词分工 = Attention 交流信息 + FFN 思考；多层堆叠梯度消失 → 残差连接（只学"差了多少"）
- **编码器/解码器**：编码器只看前面防过度解读；解码器三步 = 掩码自注意力 → 交叉注意力（对编码器的 K/V）→ FFN

## RAG 落地

- **流程**：切片 + 向量化 + 召回 + 重排 + 生成；企业动机 = 私有信息大模型没学过 + 信息量超上下文
- **切片六法**：固定/递归/结构/语义/父子（子块检索父块回答）/Agent 切片，按文档形态选
- **落地难点**：解析清洗占六成工作量（PDF→md/txt 保结构；降噪清洗 + 业务清洗）；权限用元数据控制；混合检索 = 语义 + 关键词；提问模糊 → 交互澄清或问题改写；多文档答案难 → 图谱 RAG（贵）/ Agent RAG（有幻觉）
- **优劣**：成本低、迭代快、可追溯、数据安全；依赖文档、向量检索不严谨

## skill（方法论笔记）

一段把"跑通流程"沉淀为可复用 skill 的提问模板：区分共通操作与页面特有操作、流程自带的坑与侥幸没踩的坑、未写进对话的隐式判断。

原文见 [[raw/notion/AI学习/Transformer知识|Transformer知识 原文]]、[[raw/notion/AI学习/RAG落地|RAG落地 原文]]、[[raw/notion/AI学习/skill|skill 原文]]。概念展开见 [[Transformer]]、[[RAG]]、[[Agent与Skill工作流]]；此前接触记录见 [[日记-主题提炼]]。skill 模板在课程心得中的实战展开见 [[AI-Embedded-Workflow]]。
