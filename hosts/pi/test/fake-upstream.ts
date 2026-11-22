// test/fake-upstream.ts — 假上游的唯二入口之一（另一个是 `mise run probe -- --fake`）。
//
// 测试要一个假上游时，import 这里的 startFakeUpstream，不要自己 http.createServer
// + 起后台进程 + sleep + wait：那条 bash 命令永不返回，看起来像卡死。这里端口
// 随机（不抢已知端口）、收到的请求按序记录、close() 真的能返回。
//
//   const fake = await startFakeUpstream();
//   const res = await fetch(`${fake.url}/x`);
//   fake.requests[0].url === "/x"
//   await fake.close();

import http from "node:http";

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** body 按 JSON 解析一次并缓存；解析不了返回 undefined（不抛） */
  json<T = unknown>(): T | undefined;
}

export interface FakeUpstream {
  /** http://127.0.0.1:<随机端口> */
  url: string;
  /** 收到的每个请求，按顺序（含 body 全文） */
  requests: CapturedRequest[];
  /** 最后收到的请求；一个都没收到时 undefined */
  last(): CapturedRequest | undefined;
  /** 最后一个请求的 body 解析结果；没有请求或解析失败都是 undefined */
  lastJson<T = unknown>(): T | undefined;
  /** 关掉并把还挂着的连接 destroy 掉 */
  close(): Promise<void>;
}

export type FakeHandler = (
  req: CapturedRequest,
) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

const DEFAULT_HEADERS = { "content-type": "application/json" };

export async function startFakeUpstream(handler?: FakeHandler): Promise<FakeUpstream> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let parsed: { value?: unknown } | undefined;
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers } as Record<string, string>,
        body: Buffer.concat(chunks).toString("utf8"),
        json<T = unknown>(): T | undefined {
          // 首次调用才解析；解析失败记成空对象，反复调用不再抛
          if (!parsed) {
            try {
              parsed = { value: JSON.parse(captured.body) };
            } catch {
              parsed = {};
            }
          }
          return parsed.value as T | undefined;
        },
      };
      requests.push(captured);
      const out = handler?.(captured);
      const bodyText =
        out?.body === undefined
          ? JSON.stringify({ code: 0, msg: "ok", data: { path: captured.url, method: captured.method } })
          : typeof out.body === "string"
            ? out.body
            : JSON.stringify(out.body);
      res.writeHead(out?.status ?? 200, { ...DEFAULT_HEADERS, ...out?.headers });
      res.end(bodyText);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("假上游没有拿到 127.0.0.1 的随机端口");

  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    last() {
      return requests[requests.length - 1];
    },
    lastJson<T = unknown>() {
      return requests[requests.length - 1]?.json<T>();
    },
    close() {
      // 坑：只调 server.close() 会等 keep-alive 连接自然断开（undici 的连接
      // 默认挂好几分钟），promise 永不 resolve —— 测试看起来关了其实没关，
      // 整个进程挂着。先把还活着的 socket 全部 destroy，close 回调才会来。
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
