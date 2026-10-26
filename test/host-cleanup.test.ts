import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { directory } from "./fakes.ts";

for (const failing of [false, true])
  test(`host fixtures drain their work before removal, failing teardown: ${failing}`, (t) => {
    const root = directory(t);
    const temporary = join(root, "temporary");
    const unrelated = join(temporary, "factory-test-unrelated");
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, "keep"), "unrelated fixture\n");
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temporary };
    delete env.NODE_TEST_CONTEXT;
    for (let pass = 0; pass < 2; pass++) {
      const result = spawnSync(
        process.execPath,
        [
          ...(failing
            ? [
                "--import",
                "data:text/javascript,import { afterEach } from 'node:test'; afterEach(() => { throw new Error('expected teardown failure'); });",
              ]
            : []),
          "--test",
          "--test-name-pattern=with remote diverged pushed workflow$|after a restart an interrupted run relaunches|host fixture lifecycle",
          "test/host.test.ts",
        ],
        {
          cwd: new URL("..", import.meta.url),
          env,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      assert.match(output, /an ended run's unpushable changes/);
      if (failing) {
        assert.equal(result.status, 1, output);
        assert.match(output, /expected teardown failure/);
      } else assert.equal(result.status, 0, output);
      assert.deepEqual(
        readdirSync(temporary),
        ["factory-test-unrelated"],
        output,
      );
      assert.equal(
        readFileSync(join(unrelated, "keep"), "utf8"),
        "unrelated fixture\n",
      );
    }
  });
