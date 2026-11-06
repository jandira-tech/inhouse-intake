import { assertEquals } from "jsr:@std/assert@1";

Deno.test("frontend modules name event and error types", async () => {
  const hits: string[] = [];
  for await (const entry of Deno.readDir(new URL(".", import.meta.url))) {
    if (!entry.isFile || entry.name.endsWith("_test.ts")) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, import.meta.url));
    text.split("\n").forEach((line, i) => {
      if (/:\s*any\b/.test(line)) hits.push(`${entry.name}:${i + 1}`);
    });
  }
  assertEquals(hits, []);
});
