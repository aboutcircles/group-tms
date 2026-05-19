import {promises as fs} from "fs";
import * as os from "os";
import * as path from "path";

import {FileStateStore} from "../../src/services/fileStateStore";

const APP = "group-affiliates";

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fss-"));
  return path.join(dir, "nested", "cursor.json");
}

describe("FileStateStore", () => {
  it("round-trips a cursor (block + transactionIndex + logIndex) through save/load", async () => {
    const file = await tmpFile();
    const store = new FileStateStore(file);

    await store.save(APP, 42_000_000, {transactionIndex: 7, logIndex: 3});
    const loaded = await store.load(APP);

    expect(loaded).toEqual({
      lastScannedBlock: 42_000_000,
      data: {transactionIndex: 7, logIndex: 3}
    });
  });

  it("returns null when the state file does not exist (→ caller full-replays from start block)", async () => {
    const store = new FileStateStore(await tmpFile());
    expect(await store.load(APP)).toBeNull();
  });

  it("returns null (no throw) when the state file is corrupt", async () => {
    const file = await tmpFile();
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, "{ this is not json", "utf8");

    const store = new FileStateStore(file);
    await expect(store.load(APP)).resolves.toBeNull();
  });

  it("writes atomically — no leftover .tmp file and the result is valid JSON", async () => {
    const file = await tmpFile();
    const store = new FileStateStore(file);

    await store.save(APP, 1, {transactionIndex: 0, logIndex: 0});
    await store.close();

    await expect(fs.stat(`${file}.tmp`)).rejects.toMatchObject({code: "ENOENT"});
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    expect(parsed[APP].lastScannedBlock).toBe(1);
  });

  it("keeps separate apps independent in one state file", async () => {
    const file = await tmpFile();
    const store = new FileStateStore(file);

    await store.save("group-affiliates", 100, {transactionIndex: 1, logIndex: 1});
    await store.save("other-app", 200, {transactionIndex: 2, logIndex: 2});

    expect(await store.load("group-affiliates")).toEqual({
      lastScannedBlock: 100,
      data: {transactionIndex: 1, logIndex: 1}
    });
    expect(await store.load("other-app")).toEqual({
      lastScannedBlock: 200,
      data: {transactionIndex: 2, logIndex: 2}
    });
  });

  it("serialises concurrent saves without losing an update", async () => {
    const file = await tmpFile();
    const store = new FileStateStore(file);

    await Promise.all([
      store.save(APP, 10, {transactionIndex: 0, logIndex: 0}),
      store.save("app-b", 20, {transactionIndex: 0, logIndex: 0}),
      store.save(APP, 30, {transactionIndex: 9, logIndex: 9})
    ]);
    await store.close();

    expect(await store.load("app-b")).toEqual({
      lastScannedBlock: 20,
      data: {transactionIndex: 0, logIndex: 0}
    });
    // last write for APP wins; app-b not clobbered by interleaved RMW
    expect(await store.load(APP)).toEqual({
      lastScannedBlock: 30,
      data: {transactionIndex: 9, logIndex: 9}
    });
  });
});
