// 期望的 provider 配置：**手写快照**，不由任何程序生成。
//
// 改 catalog.ts 的映射就要同步改这里 —— 两边一起动是刻意的，否则「映射改了但
// 测试还绿」。要重录：对着 fixtures/gateway-v1-models.json 那份录制，按新映射
// 逐条改，不许再写脚本自动生成。

import type { PiProviderConfig } from "../catalog.ts";

export const EXPECTED: PiProviderConfig = {
  "name": "AgentFacade (main route)",
  "baseUrl": "http://gateway.example:6450",
  "api": "anthropic-messages",
  "apiKey": "public",
  "models": [
    {
      "id": "model-01",
      "name": "Model 01",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 384000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "max"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-02",
      "name": "Model 02",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "default"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-03",
      "name": "Model 03",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "max"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-04",
      "name": "Model 04",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1048576,
      "maxTokens": 65536,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "high",
        "low": "high",
        "medium": "high",
        "high": "high",
        "xhigh": "high",
        "max": "none"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-05",
      "name": "Model 05",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "midium"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-06",
      "name": "Model 06",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "max"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-07",
      "name": "Model 07",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 384000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "max"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-08",
      "name": "Model 08",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "default"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-09",
      "name": "Model 09",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 131072,
      "maxTokens": 32768,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "high"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-10",
      "name": "Model 10",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 131072,
      "maxTokens": 65536,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "high"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-11",
      "name": "Model 11",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "default"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-12",
      "name": "Model 12",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1048576,
      "maxTokens": 65536,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "high",
        "low": "high",
        "medium": "high",
        "high": "high",
        "xhigh": "high",
        "max": "none"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-13",
      "name": "Model 13",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "max"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-14",
      "name": "Model 14",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 262144,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "off",
        "low": "off",
        "medium": "off",
        "high": "off",
        "xhigh": "off",
        "max": "off"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-15",
      "name": "Model 15",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "midium"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-16",
      "name": "Model 16",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "max"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    },
    {
      "id": "model-17",
      "name": "Model 17",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "thinkingLevelMap": {
        "off": "off",
        "minimal": "low",
        "low": "low",
        "medium": "low",
        "high": "high",
        "xhigh": "high",
        "max": "max"
      },
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "compat": {
        "forceAdaptiveThinking": true,
        "sendSessionAffinityHeaders": true
      }
    }
  ]
};
