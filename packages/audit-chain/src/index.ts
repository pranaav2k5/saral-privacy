export { GENESIS_HASH, entryHash, hashesEqual, isHash, sha256Hex } from "./hash";
export { merkleProof, merkleRoot, verifyMerkleProof } from "./merkle";
export {
  sealEntry,
  verifyChain,
  type ChainEntry,
  type ChainFailure,
  type ChainResult,
  type KeyResolver,
  type SealOptions,
  type VerifyOptions,
} from "./chain";
export { anchorBody, buildAnchor, verifyAgainstAnchor, type Anchor, type AnchorResult } from "./anchor";
