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
      // 档位走 variants（v2 没有 capabilities.reasoning，可选档位就挂在这一格）：
      // off 落成 disabled 那一条，其余每档一条 adaptive 并带上同名 effort —— id 用网关原字符串，
      // 因为 opencode 拿 id 当选择项的键，改名等于换掉用户已经选中的那一档
      variants: [
        { id: "none", settings: { thinking: { type: "disabled" } } },
        { id: "low", settings: { thinking: { type: "adaptive", display: "summarized", effort: "low" } } },
        { id: "high", settings: { thinking: { type: "adaptive", display: "summarized", effort: "high" } } },
        { id: "max", settings: { thinking: { type: "adaptive", display: "summarized", effort: "max" } } },
      ],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 1000000, output: 384000 },
    },
    {
      id: "dsh-manager",
      modelID: "dsh-manager",
      providerID: "agentfacade",
      name: "Deepseek Harness Manager",
      capabilities: CAPABILITIES,
      // 上游报的档位原样带着 default / xhigh：variant id 是自由字符串（实测形状，不是按名字推断），
      // 所以网关报什么就摆什么；off 仍旧是 disabled 那一条
      variants: [
        { id: "none", settings: { thinking: { type: "disabled" } } },
        { id: "default", settings: { thinking: { type: "adaptive", display: "summarized", effort: "default" } } },
        { id: "low", settings: { thinking: { type: "adaptive", display: "summarized", effort: "low" } } },
        { id: "medium", settings: { thinking: { type: "adaptive", display: "summarized", effort: "medium" } } },
        { id: "high", settings: { thinking: { type: "adaptive", display: "summarized", effort: "high" } } },
        { id: "xhigh", settings: { thinking: { type: "adaptive", display: "summarized", effort: "xhigh" } } },
        { id: "max", settings: { thinking: { type: "adaptive", display: "summarized", effort: "max" } } },
      ],
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
      // reasoning 但网关一个档位都没报：不是「关掉思考」，而是二态 toggle（none / thinking）两条，
      // 少给这一对用户就没有开思考的入口 —— 空档位与不支持是两件事
      variants: [
        { id: "none", settings: { thinking: { type: "disabled" } } },
        { id: "thinking", settings: { thinking: { type: "adaptive", display: "summarized" } } },
      ],
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
      variants: [
        { id: "none", settings: { thinking: { type: "disabled" } } },
        { id: "thinking", settings: { thinking: { type: "adaptive", display: "summarized" } } },
      ],
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
      // 网关这份档位既拼错（midium）又重复（high 两次）：照原样搬，不去重不改名 ——
      // 这一层没有资格替网关猜它想说什么，去重那条规则将来该定在哪层要先有实测再谈
      variants: [
        { id: "high", settings: { thinking: { type: "adaptive", display: "summarized", effort: "high" } } },
        { id: "none", settings: { thinking: { type: "disabled" } } },
        { id: "midium", settings: { thinking: { type: "adaptive", display: "summarized", effort: "midium" } } },
        { id: "high", settings: { thinking: { type: "adaptive", display: "summarized", effort: "high" } } },
      ],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 131072, output: 32768 },
    },
  ],
};
