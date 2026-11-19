// 期望值的**手写快照**：由 fixtures/gateway-v1-models.json 那份录制人工推导，不由任何程序生成。
//
// 文件名里的 `v1` 是**网关**的 `/v1/models`，与「opencode 插件 v1」无关 —— 那份录制是网关的原始
// payload，v1/v2 两个插件形状都从它推导。
//
// 与测试分开放着，是为了让「改映射」这件事必须同时改两处：v2.ts 与这里。
// 生成式的期望值做不到这一点 —— 实现改成什么样，期望值就跟着变成什么样，永远绿。

import type { OpencodeV2Payload } from "../v2.ts";

/** 网关能开工具、模态是 text+image：录制的 16 个模型全是这两项 */
const CAPABILITIES = {
  tools: true,
  input: ["text", "image"],
  output: ["text"],
};

export const EXPECTED: OpencodeV2Payload = {
  info: {
    id: "agentfacade",
    name: "AgentFacade (main route)",
    activation: "enabled",
    package: "@opencode/ai/providers/anthropic",
    settings: { baseURL: "http://gateway.example:6450/v1", apiKey: "public" },
  },
  models: [
    {
      id: "coder-a",
      modelID: "coder-a",
      providerID: "agentfacade",
      name: "Coder A",
      capabilities: CAPABILITIES,
      // 档位不表达：v2 没有 capabilities.reasoning，variants 的形状未公开 → 恒为空数组
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 1000000, output: 384000 },
    },
    {
      // 上游报的档位原样带着 default / xhigh：本宿主不表达档位，所以这里看不出差别 —— 这正是缺口
      id: "dsh-manager",
      modelID: "dsh-manager",
      providerID: "agentfacade",
      name: "Deepseek Harness Manager",
      capabilities: CAPABILITIES,
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 1000000, output: 128000 },
    },
    {
      id: "flat",
      modelID: "flat",
      providerID: "agentfacade",
      name: "Flat",
      capabilities: CAPABILITIES,
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 200000, output: 4096 },
    },
    {
      // 什么字段都没给：名字退回 id（不是空串），窗口 200000/4096
      id: "bare",
      modelID: "bare",
      providerID: "agentfacade",
      name: "bare",
      capabilities: CAPABILITIES,
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 200000, output: 4096 },
    },
    {
      // 0 是网关表达「没填」的方式，不是真的零窗口
      id: "zeros",
      modelID: "zeros",
      providerID: "agentfacade",
      name: "zeros",
      capabilities: CAPABILITIES,
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 200000, output: 4096 },
    },
    {
      // 字符串数字 "131072" / "32768" 归一成数字
      id: "weird",
      modelID: "weird",
      providerID: "agentfacade",
      name: "Weird",
      capabilities: CAPABILITIES,
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 131072, output: 32768 },
    },
  ],
};
