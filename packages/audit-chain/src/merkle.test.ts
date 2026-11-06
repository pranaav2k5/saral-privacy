import { sha256Hex } from "./hash";
import { merkleProof, merkleRoot, verifyMerkleProof } from "./merkle";

const L = ["a", "b", "c"].map((x) => sha256Hex(x));
const EMPTY_ROOT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const leaves = (n: number): string[] => Array.from({ length: n }, (_, i) => sha256Hex(`leaf-${String(i)}`));

describe("merkleRoot (RFC 6962)", () => {
  test("empty tree is the hash of the empty string", () => {
    expect(merkleRoot([])).toBe(EMPTY_ROOT);
  });

  test("known answers match an independent implementation (Python hashlib)", () => {
    expect(merkleRoot(L.slice(0, 1))).toBe("a23bd5b06da9048238a65b3f1d9d0b9e15fae3dde262688e6489aa4c763d1820");
    expect(merkleRoot(L)).toBe("cac3d448d4e20a2ad5eae1f500e63c2a7f9217cd14572ba7fd22e26dc1ec2648");
    expect(merkleRoot([...L, L[2] as string])).toBe(
      "9d33f58b8278558c024289455085c05d2037eedf3fb1938c8e8c49a10603f687",
    );
  });

  test("[a,b,c] and [a,b,c,c] have different roots (no duplicate-leaf collision)", () => {
    expect(merkleRoot(L)).not.toBe(merkleRoot([...L, L[2] as string]));
  });

  test("an inner node does not pass for a leaf (domain separation)", () => {
    const root2 = merkleRoot(L.slice(0, 2));
    expect(merkleRoot([root2])).not.toBe(root2);
    expect(verifyMerkleProof(root2, root2, 0, 1, [])).toBe(false);
  });

  test("order matters", () => {
    expect(merkleRoot([L[1] as string, L[0] as string])).not.toBe(merkleRoot(L.slice(0, 2)));
  });

  test.each(["", "xyz", "A".repeat(64), "a".repeat(63)])("rejects a malformed leaf %p", (bad) => {
    expect(() => merkleRoot([bad])).toThrow(/leaf/);
  });
});

describe("merkle proofs", () => {
  test("every leaf of every tree from 1 to 17 leaves has a verifying proof", () => {
    for (let n = 1; n <= 17; n++) {
      const ls = leaves(n);
      const root = merkleRoot(ls);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(ls, i);
        expect(verifyMerkleProof(root, ls[i] as string, i, n, proof)).toBe(true);
      }
    }
  });

  test("a flipped bit anywhere in the proof fails", () => {
    const ls = leaves(11);
    const root = merkleRoot(ls);
    const proof = merkleProof(ls, 6);
    for (let k = 0; k < proof.length; k++) {
      const bad = [...proof];
      const first = bad[k] as string;
      bad[k] = (first[0] === "0" ? "1" : "0") + first.slice(1);
      expect(verifyMerkleProof(root, ls[6] as string, 6, 11, bad)).toBe(false);
    }
  });

  test("wrong index, wrong size, wrong leaf, extra or missing proof elements all fail", () => {
    const ls = leaves(9);
    const root = merkleRoot(ls);
    const proof = merkleProof(ls, 4);
    expect(verifyMerkleProof(root, ls[4] as string, 5, 9, proof)).toBe(false);
    expect(verifyMerkleProof(root, ls[4] as string, 4, 4, proof)).toBe(false); // index out of range
    expect(verifyMerkleProof(root, ls[4] as string, 4, 20, proof)).toBe(false); // path would be longer
    expect(verifyMerkleProof(root, ls[3] as string, 4, 9, proof)).toBe(false);
    expect(verifyMerkleProof(root, ls[4] as string, 4, 9, [...proof, sha256Hex("x")])).toBe(false);
    expect(verifyMerkleProof(root, ls[4] as string, 4, 9, proof.slice(1))).toBe(false);
  });

  test("the size only shapes the path: sizes with the same path shape verify, so the anchor count pins the size", () => {
    const ls = leaves(9);
    const proof = merkleProof(ls, 4);
    // Documented property of RFC 6962 inclusion proofs, not a defect. verifyAgainstAnchor checks `count`.
    expect(verifyMerkleProof(merkleRoot(ls), ls[4] as string, 4, 10, proof)).toBe(true);
  });

  test("out-of-range index and size are rejected without throwing in verify", () => {
    const ls = leaves(3);
    expect(() => merkleProof(ls, 3)).toThrow(/index/);
    expect(() => merkleProof(ls, -1)).toThrow(/index/);
    expect(verifyMerkleProof(merkleRoot(ls), ls[0] as string, 3, 3, [])).toBe(false);
    expect(verifyMerkleProof(merkleRoot(ls), ls[0] as string, 0, 0, [])).toBe(false);
  });
});
