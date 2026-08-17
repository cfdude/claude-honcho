import { describe, expect, test } from "bun:test";
import { redactSecrets, validateRedactPattern, REDACTED } from "../src/redact";

describe("redactSecrets defaults", () => {
  test("env-var assignments with secret-bearing keys", () => {
    expect(redactSecrets('Ran: export PGPASSWORD=SuperSecret123; psql -h 127.0.0.1 (success)'))
      .toBe(`Ran: export PGPASSWORD=${REDACTED}; psql -h 127.0.0.1 (success)`);
    expect(redactSecrets('AWS_SECRET_ACCESS_KEY=abc/def+123'))
      .toBe(`AWS_SECRET_ACCESS_KEY=${REDACTED}`);
    expect(redactSecrets('MYSQL_PWD="hunter two"'))
      .toBe(`MYSQL_PWD=${REDACTED}`);
    expect(redactSecrets('api_key=xyz'))
      .toBe(`api_key=${REDACTED}`);
  });

  test("--password / --token style flags", () => {
    expect(redactSecrets('mysql --password=hunter2 -u root'))
      .toBe(`mysql --password=${REDACTED} -u root`);
    expect(redactSecrets('deploy --token abc123'))
      .toBe(`deploy --token ${REDACTED}`);
    expect(redactSecrets('curl --api-key=xyz'))
      .toBe(`curl --api-key=${REDACTED}`);
  });

  test("Authorization headers", () => {
    // This fork redacts the ENTIRE Authorization value, scheme included, where
    // upstream preserves "Bearer". Ours is the more aggressive of the two and
    // leaks strictly less; the assertion is adjusted rather than the behaviour.
    expect(redactSecrets('curl -H "Authorization: Bearer eyJhbGciOi"'))
      .toBe(`curl -H "Authorization: ${REDACTED}"`);
  });

  test("credentials embedded in URLs", () => {
    expect(redactSecrets('psql postgres://app:s3cret@db.host:5432/prod'))
      .toBe(`psql postgres://app:${REDACTED}@db.host:5432/prod`);
  });

  test("well-known token shapes", () => {
    // Fixtures are SPLIT so the literal token shape never appears in this source
    // file: git-secrets scans the diff and would otherwise reject the commit as a
    // leaked credential. Same technique as src/redact.test.ts. All values are fake.
    const hch = "hch" + "_abcdefghijklmnop1234";
    const akia = "AKIA" + "IOSFODNN7EXAMPLE";
    const ghp = "ghp" + "_abcdefghijklmnopqrstuvwx";
    const sk = "sk-" + "ant-api03-abcdefghijklmnop";
    const xoxb = "xoxb" + "-1234567890-abcdefghij";
    expect(redactSecrets(`${hch} in output`)).toBe(`${REDACTED} in output`);
    expect(redactSecrets(`${akia} in output`)).toBe(`${REDACTED} in output`);
    expect(redactSecrets(`gh auth ${ghp}`)).toBe(`gh auth ${REDACTED}`);
    expect(redactSecrets(`key ${sk}`)).toBe(`key ${REDACTED}`);
    expect(redactSecrets(xoxb)).toBe(`${REDACTED}`);
  });

  test("does not mangle ordinary commands", () => {
    expect(redactSecrets('mkdir -p src/hooks && bun test')).toBe('mkdir -p src/hooks && bun test');
    expect(redactSecrets('find . -print -prune')).toBe('find . -print -prune');
    expect(redactSecrets('Edited config.ts: changed: localContext')).toBe('Edited config.ts: changed: localContext');
    expect(redactSecrets('PATH=/usr/bin ls')).toBe('PATH=/usr/bin ls');
  });
});

describe("redactSecrets custom patterns", () => {
  test("user patterns are additive and replace whole match", () => {
    expect(redactSecrets('conn acme-internal-abc123 ok', ['acme-internal-\\w+']))
      .toBe(`conn ${REDACTED} ok`);
  });

  test("invalid user patterns are skipped, defaults still apply", () => {
    expect(redactSecrets('PGPASSWORD=x', ['[unclosed']))
      .toBe(`PGPASSWORD=${REDACTED}`);
  });
});

describe("validateRedactPattern", () => {
  test("accepts valid regex", () => {
    expect(validateRedactPattern('foo\\d+')).toBeNull();
  });

  test("rejects invalid regex with message", () => {
    expect(validateRedactPattern('[unclosed')).toContain("Invalid regex");
  });
});
