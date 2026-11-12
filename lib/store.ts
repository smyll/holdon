import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Deal } from "./types.ts";

// shortcut: One Node process owns this JSON store. Use a database before running multiple app instances.
const shared = globalThis as typeof globalThis & { holdonWrites?: Promise<unknown> };
export const dataDirectory = resolve("data");

export function createStore(directory = dataDirectory) {
  const file = join(directory, "deals.json");
  async function read(): Promise<Deal[]> {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function write(deals: Deal[]) {
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `deals-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(deals, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, file);
  }
  function transaction<T>(task: (deals: Deal[], checkpoint: () => Promise<void>) => Promise<T>): Promise<T> {
    const next = (shared.holdonWrites ?? Promise.resolve()).then(async () => {
      const deals = await read();
      const result = await task(deals, () => write(deals));
      await write(deals);
      return result;
    });
    shared.holdonWrites = next.catch(() => {});
    return next;
  }
  return {
    transaction,
    list: read,
    async get(id: string) { return (await read()).find(deal => deal.id === id); },
    add(deal: Deal) { return transaction(async deals => { deals.push(deal); return deal; }); },
    update<T>(id: string, change: (deal: Deal, checkpoint: () => Promise<void>) => Promise<T>) {
      return transaction(async (deals, checkpoint) => {
        const deal = deals.find(value => value.id === id);
        if (!deal) throw new Error("Deal not found.");
        return change(deal, checkpoint);
      });
    },
  };
}
export const store = createStore();
