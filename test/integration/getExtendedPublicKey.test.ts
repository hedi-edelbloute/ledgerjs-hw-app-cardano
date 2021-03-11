import chai, { expect } from "chai";
import chaiAsPromised from 'chai-as-promised';

import type Ada from "../../src/Ada";
import { DeviceStatusError } from "../../src/errors";
import { getAda, str_to_path } from "../test_utils";
import getPathDerivationFixture from "./__fixtures__/pathDerivations";
chai.use(chaiAsPromised)

describe("getExtendedPublicKey", async () => {
  let ada: Ada = {} as Ada;

  beforeEach(async () => {
    ada = await getAda();
  });

  afterEach(async () => {
    await (ada as any).t.close();
  });

  it("Should successfully get a single extended public key", async () => {
    const test = async (path: string) => {
      const derivation = getPathDerivationFixture({
        path,
      })!;

      const result = await ada.getExtendedPublicKey(
        { path: str_to_path(derivation.path) }
      );

      expect(result.publicKeyHex).to.equal(derivation.publicKey);
      expect(result.chainCodeHex).to.equal(derivation.chainCode);
    };

    const _paths = [
      // Byron
      "44'/1815'/1'",
      "44'/1815'/1'/0/12'",
      "44'/1815'/1'/0/10'/1/2/3",
      // Shelley
      "1852'/1815'/0'/0/1",
      "1852'/1815'/0'/2/0"
    ]

    for (const path of _paths) {
      await test(path)
    }
  });

  it("Should successfully get several extended public keys, starting with a usual one", async () => {
    const _paths = [
      "44'/1815'/1'",
      "44'/1815'/1'/0/10'/1/2/3"
    ];

    const paths = [];
    const expectedResults = [];
    for (const path of _paths) {
      const derivation = getPathDerivationFixture({
        path,
      })!;

      paths.push(str_to_path(derivation.path));

      expectedResults.push({
        publicKeyHex: derivation.publicKey,
        chainCodeHex: derivation.chainCode,
      });
    }

    const results = await ada.getExtendedPublicKeys({ paths });
    for (let i = 0; i < expectedResults.length; i++) {
      expect(results[i].publicKeyHex).to.equal(expectedResults[i].publicKeyHex);
      expect(results[i].chainCodeHex).to.equal(expectedResults[i].chainCodeHex);
    }
  });

  it("Should successfully get several extended public keys, starting with an unusual one", async () => {
    const _paths = [
      "44'/1815'/1'/0/10'/1/2/3",
      "44'/1815'/1'",
      "44'/1815'/1'/0/12'",
      "1852'/1815'/0'/0/1",
      "1852'/1815'/0'/2/0",
    ];

    const paths = [];
    const expectedResults = [];
    for (const path of _paths) {
      const derivation = getPathDerivationFixture({
        path,
      })!;

      paths.push(str_to_path(derivation.path));

      expectedResults.push({
        publicKeyHex: derivation.publicKey,
        chainCodeHex: derivation.chainCode,
      });
    }

    const results = await ada.getExtendedPublicKeys({ paths });
    for (let i = 0; i < expectedResults.length; i++) {
      expect(results[i].publicKeyHex).to.equal(expectedResults[i].publicKeyHex);
      expect(results[i].chainCodeHex).to.equal(expectedResults[i].chainCodeHex);
    }
  });

  it("Should return the same public key with the same path consistently", async () => {
    const path = str_to_path("44'/1815'/1'");

    const res1 = await ada.getExtendedPublicKey({ path });
    const res2 = await ada.getExtendedPublicKey({ path });

    expect(res1.publicKeyHex).to.equal(res2.publicKeyHex);
    expect(res1.chainCodeHex).to.equal(res2.chainCodeHex);
  });

  it("Should reject path shorter than 3 indexes", async () => {
    const promise = ada.getExtendedPublicKey({ path: str_to_path("44'/1815'") })
    await expect(promise).to.be.rejectedWith(DeviceStatusError, "Action rejected by Ledger's security policy")
  });
});
