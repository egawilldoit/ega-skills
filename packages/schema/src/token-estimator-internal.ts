export const EGA_O200K_V1_ESTIMATOR_ID = "ega-o200k-v1" as const;

export type TokenEstimatorErrorCode =
  | "E_TOKEN_BINARY_INPUT"
  | "E_TOKEN_ESTIMATOR_INCOMPATIBLE"
  | "E_TOKEN_ESTIMATOR_UNAVAILABLE";

export type TokenEstimatorInput = string | Uint8Array | ArrayBuffer;

export interface TokenEncoder {
  encode(
    text: string,
    allowedSpecial?: string[] | "all",
    disallowedSpecial?: string[] | "all",
  ): ArrayLike<number>;
}

export interface TokenEstimator {
  readonly id: typeof EGA_O200K_V1_ESTIMATOR_ID;
  count(input: TokenEstimatorInput): number;
}

export interface TokenEstimatorReferenceVector {
  readonly id: string;
  readonly input: string;
  readonly expectedTokens: number;
}

export class TokenEstimatorError extends Error {
  readonly code: TokenEstimatorErrorCode;

  constructor(code: TokenEstimatorErrorCode, message: string) {
    super(message);
    this.name = "TokenEstimatorError";
    this.code = code;
  }
}

export function canonicalizeTokenText(text: string): string {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return withoutBom.replace(/\r\n|\r/g, "\n");
}

function unavailable(): TokenEstimatorError {
  return new TokenEstimatorError(
    "E_TOKEN_ESTIMATOR_UNAVAILABLE",
    "The ega-o200k-v1 token estimator is unavailable.",
  );
}

export function createTokenEstimator(createEncoder: () => TokenEncoder): TokenEstimator {
  let encoder: TokenEncoder | undefined;

  const getEncoder = (): TokenEncoder => {
    if (encoder !== undefined) {
      return encoder;
    }

    try {
      const initialized = createEncoder();
      if (typeof initialized?.encode !== "function") {
        throw new TypeError("encoder does not expose encode");
      }
      encoder = initialized;
      return initialized;
    } catch {
      throw unavailable();
    }
  };

  return Object.freeze({
    id: EGA_O200K_V1_ESTIMATOR_ID,
    count(input: TokenEstimatorInput): number {
      if (typeof input !== "string") {
        throw new TokenEstimatorError(
          "E_TOKEN_BINARY_INPUT",
          "Binary input cannot be tokenized by ega-o200k-v1.",
        );
      }

      const canonicalText = canonicalizeTokenText(input);

      try {
        return getEncoder().encode(canonicalText, [], []).length;
      } catch (error) {
        if (error instanceof TokenEstimatorError) {
          throw error;
        }
        throw unavailable();
      }
    },
  });
}

export function assertTokenEstimatorId(estimatorId: string): void {
  if (estimatorId !== EGA_O200K_V1_ESTIMATOR_ID) {
    throw new TokenEstimatorError(
      "E_TOKEN_ESTIMATOR_INCOMPATIBLE",
      `Expected token estimator ${EGA_O200K_V1_ESTIMATOR_ID}.`,
    );
  }
}

export function assertTokenEstimatorCompatibility(
  estimator: TokenEstimator,
  vectors: readonly TokenEstimatorReferenceVector[],
): void {
  assertTokenEstimatorId(estimator.id);

  for (const vector of vectors) {
    const actualTokens = estimator.count(vector.input);
    if (actualTokens !== vector.expectedTokens) {
      throw new TokenEstimatorError(
        "E_TOKEN_ESTIMATOR_INCOMPATIBLE",
        `Token estimator reference vector ${vector.id} is incompatible.`,
      );
    }
  }
}
