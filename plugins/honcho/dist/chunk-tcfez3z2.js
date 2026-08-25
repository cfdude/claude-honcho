// src/redact.ts
var REDACTED = "[redacted]";
var BROAD_SECRET_WORDS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "credential",
  "bearer",
  "privatekey",
  "authorization",
  "cookie"
];
var SEGMENT_SECRET_WORDS = ["pwd", "auth", "session", "pat", "cred", "creds"];
function isSensitiveKeyName(name) {
  const lower = name.toLowerCase().replace(/^-+/, "");
  if (!lower)
    return false;
  const squashed = lower.replace(/[_\-.]/g, "");
  if (BROAD_SECRET_WORDS.some((w) => squashed.includes(w)))
    return true;
  return lower.split(/[_\-.]+/).some((seg) => SEGMENT_SECRET_WORDS.includes(seg));
}
var VALUE_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprse]-[A-Za-z0-9-]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  /\bhch[_-]?[A-Za-z0-9_-]{16,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g
];
function redactPemBlocks(input) {
  if (!input.includes("PRIVATE KEY"))
    return input;
  return input.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`).replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?![\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*/g, `-----BEGIN PRIVATE KEY----- ${REDACTED}`);
}
function redactHeaderFields(input) {
  return input.replace(/\b(authorization|proxy-authorization|set-cookie|cookie|x-api-key|api-key|x-auth-token)([ \t]*:[ \t]*)[^"'\n]+/gi, (_m, key) => `${key}: ${REDACTED}`);
}
function redactUrlCredentials(input) {
  return input.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]*)@/g, (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`);
}
function redactValueShapes(input) {
  let out = input;
  for (const re of VALUE_SHAPES)
    out = out.replace(re, REDACTED);
  return out;
}
function redactBearerTokens(input) {
  return input.replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`);
}
function redactSensitiveFlags(input) {
  let out = input.replace(/(--?[A-Za-z][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g, (m, flag) => isSensitiveKeyName(flag) ? `${flag}=${REDACTED}` : m);
  out = out.replace(/(--?[A-Za-z][A-Za-z0-9_.-]*)([ \t]+)("[^"]*"|'[^']*'|[^\s-][^\s]*)/g, (m, flag, gap) => isSensitiveKeyName(flag) ? `${flag}${gap}${REDACTED}` : m);
  return out;
}
function redactAssignments(input) {
  return input.replace(/(^|[\s;&|("'`])([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*("[^"]*"|'[^']*'|[^\s;&|)"'`]+)/g, (m, lead, key) => isSensitiveKeyName(key) ? `${lead}${key}=${REDACTED}` : m);
}
function redactColonFields(input) {
  return input.replace(/(^[ \t]*|[\n{,][ \t]*|["'`][ \t]*)([A-Za-z_][A-Za-z0-9_.-]*)(["'`]?)[ \t]*:[ \t]*("[^"]*"|'[^']*'|[^\s,;}"'`]+)/g, (m, lead, key, closeQuote) => isSensitiveKeyName(key) ? `${lead}${key}${closeQuote}: ${REDACTED}` : m);
}
function redactToolSpecificFlags(input) {
  let out = input;
  if (/\bmysql(?:dump|admin|show)?\b/.test(out)) {
    out = out.replace(/(\s|^)-p(?=\S)("[^"]*"|'[^']*'|\S+)/g, `$1-p${REDACTED}`);
  }
  if (/\bredis-cli\b/.test(out)) {
    out = out.replace(/(\s|^)-a[ \t]+("[^"]*"|'[^']*'|[^\s-][^\s]*)/g, `$1-a ${REDACTED}`);
  }
  out = out.replace(/(\s|^)(-u|--user)([ \t]+|=)(["']?)([^\s:"']+):([^\s"']*)/g, (_m, lead, flag, sep, quote, user) => `${lead}${flag}${sep}${quote}${user}:${REDACTED}`);
  return out;
}
function validateRedactPattern(source) {
  try {
    new RegExp(source);
    return null;
  } catch (e) {
    return `Invalid regex ${JSON.stringify(source)}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
function redactSecrets(input, extraPatterns) {
  if (!input)
    return input;
  let out = input;
  out = redactPemBlocks(out);
  out = redactUrlCredentials(out);
  out = redactHeaderFields(out);
  out = redactValueShapes(out);
  out = redactBearerTokens(out);
  out = redactSensitiveFlags(out);
  out = redactAssignments(out);
  out = redactColonFields(out);
  out = redactToolSpecificFlags(out);
  for (const source of extraPatterns ?? []) {
    try {
      out = out.replace(new RegExp(source, "gi"), REDACTED);
    } catch {
      continue;
    }
  }
  return out;
}

export { validateRedactPattern, redactSecrets };

//# debugId=4133F86532C0904364756E2164756E21
//# sourceMappingURL=chunk-tcfez3z2.js.map
