import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// Test transport.ts at the socket level by mocking node:https directly.
// All other enforce tests mock the transport module itself — this file
// exercises the actual request/response plumbing.

vi.mock("node:https", () => ({ default: { request: vi.fn() } }));
vi.mock("node:http", () => ({ default: { request: vi.fn() } }));

import https from "node:https";
import { post } from "../transport";

const mockRequest = https.request as ReturnType<typeof vi.fn>;

afterEach(() => mockRequest.mockReset());

// Minimal fake ClientRequest
function fakeReq() {
  const em = new EventEmitter();
  return Object.assign(em, { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
}

// Minimal fake IncomingMessage
function fakeRes(statusCode: number) {
  return Object.assign(new EventEmitter(), { statusCode });
}

describe("transport.post", () => {
  it("resolves with status and concatenated body chunks", async () => {
    const req = fakeReq();
    const res = fakeRes(200);

    mockRequest.mockImplementation((_opts: unknown, cb: unknown) => {
      (cb as (r: typeof res) => void)(res);
      return req;
    });

    const p = post("https://api.test/v1/evaluate", '{"x":1}', { Authorization: "Bearer k" });
    res.emit("data", Buffer.from('{"ok"'));
    res.emit("data", Buffer.from(':true}'));
    res.emit("end");

    const result = await p;
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
  });

  it("sends Content-Type, Content-Length, and caller headers", async () => {
    const req = fakeReq();
    const res = fakeRes(200);
    let capturedOpts: Record<string, unknown> = {};

    mockRequest.mockImplementation((opts: unknown, cb: unknown) => {
      capturedOpts = opts as Record<string, unknown>;
      (cb as (r: typeof res) => void)(res);
      return req;
    });

    const p = post("https://api.test/v1/evaluate", '{"x":1}', { Authorization: "Bearer k" });
    res.emit("end");
    await p;

    const headers = capturedOpts["headers"] as Record<string, unknown>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Content-Length"]).toBeGreaterThan(0);
    expect(headers["Authorization"]).toBe("Bearer k");
  });

  it("rejects on request-level error (e.g. ECONNREFUSED)", async () => {
    const req = fakeReq();
    mockRequest.mockImplementation(() => req);

    const p = post("https://api.test/v1/evaluate", "{}", {});
    req.emit("error", new Error("ECONNREFUSED"));

    await expect(p).rejects.toThrow("ECONNREFUSED");
  });

  it("rejects on response-stream error (e.g. ECONNRESET mid-body)", async () => {
    const req = fakeReq();
    const res = fakeRes(200);

    mockRequest.mockImplementation((_opts: unknown, cb: unknown) => {
      (cb as (r: typeof res) => void)(res);
      return req;
    });

    const p = post("https://api.test/v1/evaluate", "{}", {});
    res.emit("data", Buffer.from("partial"));
    res.emit("error", new Error("ECONNRESET"));

    await expect(p).rejects.toThrow("ECONNRESET");
  });

  it("rejects with timeout message and destroys the request", async () => {
    const req = fakeReq();
    mockRequest.mockImplementation(() => req);

    const p = post("https://api.test/v1/evaluate", "{}", {});
    req.emit("timeout");

    await expect(p).rejects.toThrow("Request timed out after 30s");
    expect(req.destroy).toHaveBeenCalled();
  });
});
