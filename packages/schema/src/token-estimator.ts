import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

import {
  EGA_O200K_V1_ESTIMATOR_ID,
  TokenEstimatorError,
  assertTokenEstimatorCompatibility,
  assertTokenEstimatorId,
  createTokenEstimator,
  type TokenEstimator,
  type TokenEstimatorErrorCode,
  type TokenEstimatorInput,
  type TokenEstimatorReferenceVector,
} from "./token-estimator-internal.js";

export const tokenEstimator: TokenEstimator = createTokenEstimator(
  () => new Tiktoken(o200kBase),
);

export {
  EGA_O200K_V1_ESTIMATOR_ID,
  TokenEstimatorError,
  assertTokenEstimatorCompatibility,
  assertTokenEstimatorId,
};
export type {
  TokenEstimator,
  TokenEstimatorErrorCode,
  TokenEstimatorInput,
  TokenEstimatorReferenceVector,
};
