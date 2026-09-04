export const TOKEN_VECTORS = Object.freeze([
  { id: "T001", input: "", expectedTokens: 0 },
  { id: "T002", input: "Hello", expectedTokens: 1 },
  { id: "T003", input: "hello world", expectedTokens: 2 },
  { id: "T004", input: "Hello world", expectedTokens: 2 },
  { id: "T005", input: "Hello, world!", expectedTokens: 4 },
  { id: "T006", input: "こんにちは", expectedTokens: 1 },
  { id: "T007", input: "こんにちは世界", expectedTokens: 2 },
  { id: "T008", input: "你好世界", expectedTokens: 2 },
  { id: "T009", input: "The quick brown fox jumps over the lazy dog", expectedTokens: 9 },
]);
