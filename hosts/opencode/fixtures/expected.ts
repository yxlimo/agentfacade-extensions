// 期望值的**手写快照**：由 test/check.ts 里那份 SNAPSHOT_SPECS（6 条显式 ModelSpec）人工推导，
// 不由任何程序生成。
//
// 与测试分开放着，是为了让「改映射」这件事必须同时改两处：v2.ts 与这里。
// 生成式的期望值做不到这一点 —— 实现改成什么样，期望值就跟着变成什么样，永远绿。
//
// 文件名叫 expected 而不是 fixtures.json：这里**没有**网关报文的拷贝。网关报文的形状只留一份
// （在 core 的测试里），agent 这一层只认 ModelSpec。

import type { OpencodeV2Payload } from "../v2.ts";

/**
 * 网关报过这三项时的形状：能调工具、模态 text+image。
 *
 * SNAPSHOT_SPECS 里那 6 条都显式写了 `toolCall: true` 与 `modalities: {input: ["text","image"],
 * output: ["text"]}`，所以快照里这一格是同一个对象 —— 但它**不是**常量回填：v2.ts 从 spec
 * 取值（见 test/check.ts 里 toolCall=false / modalities=[] 那几条用例）。
 */
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
      // 上游报的档位原样带着 default / xhigh：本 agent 不表达档位，所以这里看不出差别 —— 这正是缺口
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
      // 名字与 id 一样只是这条输入的事实（displayName === id），不是「缺了才退回」的回填
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
      // 窗口是 core 归一后的值（200000/4096）；「0 也算没说」那条规则属于 core 的用例
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
      // 非默认的窗口值原样搬（归一成数字是 core 的事）
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
