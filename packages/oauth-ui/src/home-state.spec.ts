import { describe, expect, it } from "vitest";
import { classifyOAuthGrantError } from "./home-state";

describe("classifyOAuthGrantError", () => {
  it("recognizes the provider's disabled OAuth server response", () => {
    expect(classifyOAuthGrantError({ code: "feature_disabled", status: 404 })).toBe("disabled");
    expect(classifyOAuthGrantError({ message: "OAuth server is disabled", status: 404 })).toBe("disabled");
  });

  it("keeps unexpected provider failures as errors", () => {
    expect(classifyOAuthGrantError({ code: "network_error", status: 503 })).toBe("error");
    expect(classifyOAuthGrantError({ message: "OAuth server is disabled", status: 500 })).toBe("error");
    expect(classifyOAuthGrantError(null)).toBe("error");
  });
});
