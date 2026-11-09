import { describe, expect, it } from "vitest";

import { outboundProblem } from "./net-guard.js";

/**
 * 出站地址守卫。
 *
 * 背景：模型接口地址由用户填，而服务端会带着**真实 API key** 去请求它。填成云厂商元数据
 * 地址时，等于把 key 连同请求一起发到一个能换出临时凭证的地方。
 */

describe("出站地址守卫", () => {
  it("放行公网地址", () => {
    for (const u of [
      "https://api.openai.com/v1",
      "https://api.anthropic.com",
      "http://8.8.8.8:8080/v1",
      "https://llm.example.com/v1",
    ])
      expect(outboundProblem(u), u).toBeNull();
  });

  it("拦住云元数据地址（拿到它就能换临时凭证）", () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[fd00:ec2::254]/latest/meta-data/",
    ])
      expect(outboundProblem(u), u).toContain("本机或内网");
  });

  it("拦住本机与内网地址（会被用来打自己和内网服务）", () => {
    for (const u of [
      "http://127.0.0.1:4400/api/sessions",
      "http://localhost:11434/v1",
      "http://10.0.0.5/v1",
      "http://192.168.1.10/v1",
      "http://172.16.0.1/v1",
      "http://[::1]:8080/",
      "http://0.0.0.0:80/",
    ])
      expect(outboundProblem(u), u).toContain("本机或内网");
  });

  it("显式放行时允许本机（本地推理服务）", () => {
    expect(
      outboundProblem("http://127.0.0.1:11434/v1", { allowLocal: true }),
    ).toBeNull();
    // 但协议仍然要合法。
    expect(
      outboundProblem("file:///etc/passwd", { allowLocal: true }),
    ).toContain("http");
  });

  it("只接受 http(s)，其余协议一律拒", () => {
    for (const u of [
      "file:///etc/passwd",
      "ftp://x.com",
      "javascript:alert(1)",
    ])
      expect(outboundProblem(u), u).not.toBeNull();
    expect(outboundProblem("不是 URL")).toContain("合法的 URL");
  });

  it("172.16–172.31 才算内网，172.32 属于公网", () => {
    expect(outboundProblem("http://172.31.255.255/")).toContain("本机或内网");
    expect(outboundProblem("http://172.32.0.1/")).toBeNull();
  });
});
