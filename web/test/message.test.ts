import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { pkHash, sep53Hash, transferRotateMessage, verifyMessage } from "../src/message";
import { formatAmount, parseAmount } from "../src/vault";

// Same as MESSAGE_VECTOR in contracts/sorobunker/src/test.rs.
const MESSAGE_VECTOR = `SoroBunker transfer_rotate
vault: CD5WS6EMV4GBZDVIBKJVO4RSQPFFKSAS5OQCQFJT7A2NV27KSDZDYKX6
nonce: 7
token: CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
to: GBYUK7JWE4DX3Y2YR6TM755BVUVEVL4723TQ2SSUHH7YURGYRFNVSTLO
amount: -170141183460469231731687303715884105728
next key hash: 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`;

describe("message", () => {
  it("matches the contract's message byte for byte", () => {
    const message = transferRotateMessage({
      vault: "CD5WS6EMV4GBZDVIBKJVO4RSQPFFKSAS5OQCQFJT7A2NV27KSDZDYKX6",
      nonce: 7n,
      token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      to: "GBYUK7JWE4DX3Y2YR6TM755BVUVEVL4723TQ2SSUHH7YURGYRFNVSTLO",
      amount: -(2n ** 127n),
      nextPkHash: Uint8Array.from({ length: 32 }, (_, i) => i),
    });
    expect(message).toBe(MESSAGE_VECTOR);
  });

  it("follows SEP-53 (first test vector from the spec)", () => {
    const kp = Keypair.fromSecret("SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW");
    expect(Buffer.from(kp.sign(sep53Hash("Hello, World!"))).toString("hex")).toBe(
      "7cee5d6d885752104c85eea421dfdcb95abf01f1271d11c4bec3fcbd7874dccd" +
        "6e2e98b97b8eb23b643cac4073bb77de5d07b0710139180ae9f3cbba78f2ba04",
    );
  });

  it("verifies only the right key and message", () => {
    const kp = Keypair.random();
    const sig = kp.sign(sep53Hash("hi"));
    expect(verifyMessage(kp.publicKey(), "hi", sig)).toBe(true);
    expect(verifyMessage(kp.publicKey(), "hi!", sig)).toBe(false);
    expect(verifyMessage(Keypair.random().publicKey(), "hi", sig)).toBe(false);
    expect(pkHash(kp.publicKey())).toHaveLength(32);
  });
});

describe("amounts", () => {
  it("parses and formats decimals", () => {
    expect(parseAmount("12.5", 7)).toBe(125_000_000n);
    expect(parseAmount("0", 7)).toBe(0n);
    expect(() => parseAmount("1.12345678", 7)).toThrow();
    expect(() => parseAmount("-1", 7)).toThrow();
    expect(formatAmount(125_000_000n, 7)).toBe("12.5");
    expect(formatAmount(5n, 7)).toBe("0.0000005");
  });
});
