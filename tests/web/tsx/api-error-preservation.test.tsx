/**
 * Regression: the API client's structured errors must survive the resource hook.
 *
 * `client.get` already classifies every failure into the shared `ApiError` union
 * (`unauthorized`, `forbidden`, `unavailable`, `malformed_response`, ...). Those
 * values are plain frozen objects, not `Error` instances. `useApiResource` used
 * to funnel whatever it caught back through `normalizeThrownError`, which only
 * recognises `Error` instances and abort-like values — so a perfectly good
 * `ApiError` was re-wrapped as `kind: "network"` with
 * `"Transport failure: Unknown transport failure."`. Every real status, code and
 * message was destroyed, and the console rendered
 * "The console could not reach its own API." for a request that had in fact
 * reached the API and received a typed refusal.
 *
 * These tests drive the REAL client and the REAL hook together (only `fetch` is
 * stubbed) so the defect is caught at the boundary that caused it, not at a
 * mock. They must fail on the pre-repair hook.
 */

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import { createApiClient, type ApiClient } from "../../../apps/web/src/api/client";
import type { ApiError } from "../../../apps/web/src/api/contracts";
import { useApiResource } from "../../../apps/web/src/api/useApiResource";
import { createDom, type MountedDom } from "./helpers/dom";

let dom: MountedDom | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  dom?.restore();
  dom = null;
});

/** A `Response`-shaped stand-in: the client reads `ok`, `status`, `text`, `json`. */
function stubResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
    },
  } as unknown as Response;
}

function envelope(code: string, message: string): unknown {
  return { error: { code, message } };
}

/** The one component under test: the production hook, through the production client. */
function Probe({ client }: { readonly client: ApiClient }) {
  const resource = useApiResource((signal) => client.get("/catalog", { signal }), [client]);
  return <output>{JSON.stringify(resource.state)}</output>;
}

function mount(client: ApiClient) {
  dom = createDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <StrictMode>
        <Probe client={client} />
      </StrictMode>,
    );
  });
  return {
    container,
    text: () => container.textContent ?? "",
    async settle() {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
        });
        if (!(container.textContent ?? "").includes('"loading"')) return;
      }
      throw new Error("the resource never settled");
    },
  };
}

/**
 * Mount the real hook over the real client and return the error it settled on.
 * Fails loudly if the state is not an error, so a case cannot pass silently.
 */
async function errorFrom(fetchImpl: typeof fetch): Promise<ApiError> {
  const client = createApiClient({ fetchImpl });
  const view = mount(client);
  await view.settle();
  const parsed = JSON.parse(view.text()) as
    | { status: "error"; error: ApiError }
    | { status: string };
  if (parsed.status !== "error") {
    throw new Error(`expected an error state, received ${view.text()}`);
  }
  return (parsed as { status: "error"; error: ApiError }).error;
}

describe("a structured ApiError reaches the consumer unchanged", () => {
  test("503 unavailable keeps its kind, status, code and message", async () => {
    const message =
      "Control-plane data is unavailable: EGA_SUPABASE_URL is not configured for this deployment";
    const error = await errorFrom(async () =>
      stubResponse(503, envelope("E_WEB_READ_UNAVAILABLE", message)),
    );
    expect(error.kind).toBe("unavailable");
    expect(error.status).toBe(503);
    expect(error.code).toBe("E_WEB_READ_UNAVAILABLE");
    expect(error.message).toBe(message);
    expect(error.retryable).toBe(true);
  });

  test("401 keeps unauthorized, not network", async () => {
    const error = await errorFrom(async () =>
      stubResponse(401, envelope("E_WEB_UNAUTHENTICATED", "The presented session was rejected")),
    );
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(error.code).toBe("E_WEB_UNAUTHENTICATED");
  });

  test("403 keeps forbidden, not network", async () => {
    const error = await errorFrom(async () =>
      stubResponse(
        403,
        envelope("E_WEB_CONTROL_PLANE_FORBIDDEN", "Access to the requested release is forbidden"),
      ),
    );
    expect(error.kind).toBe("forbidden");
    expect(error.status).toBe(403);
    expect(error.code).toBe("E_WEB_CONTROL_PLANE_FORBIDDEN");
  });

  test("a success body that breaks the contract stays malformed_response", async () => {
    // A 200 whose body is not the catalog envelope: the decoder rejects it.
    const error = await errorFrom(async () => stubResponse(200, { nope: true }));
    expect(error.kind).toBe("malformed_response");
    expect(error.status).toBe(200);
  });
});

describe("transport and cancellation behaviour is preserved", () => {
  test("a rejected fetch is still a network error with no status", async () => {
    const error = await errorFrom(async () => {
      throw new TypeError("fetch failed");
    });
    expect(error.kind).toBe("network");
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("Transport failure");
  });

  test("an abort-like rejection is still classified as aborted", async () => {
    const error = await errorFrom(async () => {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      throw abort;
    });
    expect(error.kind).toBe("aborted");
    expect(error.retryable).toBe(false);
  });
});

describe("runtime validation is not a shape-blind trust", () => {
  test("an object that only has a message is not mistaken for an ApiError", async () => {
    const error = await errorFrom(async () => {
      throw { message: "looks structured" };
    });
    expect(error.kind).toBe("network");
    expect(error.status).toBeNull();
    expect(error.code).toBeNull();
    expect(error.message).not.toBe("looks structured");
  });

  test("a partial ApiError (kind only, no message) is not trusted", async () => {
    const error = await errorFrom(async () => {
      throw { kind: "unavailable" };
    });
    expect(error.kind).toBe("network");
    expect(error.status).toBeNull();
  });
});
