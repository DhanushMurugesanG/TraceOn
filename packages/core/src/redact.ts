const REDACT_RULES = [
  { name: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'credit_card', pattern: /\b(?:\d[ -]*?){13,16}\b/g },
  { name: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'generic_secret', pattern: /(?:api[_-]?key|secret|token)["\s:=]+[A-Za-z0-9_-]{20,}/gi },
] as const;

export interface RedactionRecord {
  field_path: string;
  rule: string;
  count: number;
}

export function redactString(s: string, records: RedactionRecord[], fieldPath: string): string {
  let result = s;
  for (const rule of REDACT_RULES) {
    const matches = result.match(rule.pattern);
    if (matches && matches.length > 0) {
      records.push({ field_path: fieldPath, rule: rule.name, count: matches.length });
      result = result.replace(rule.pattern, `[REDACTED:${rule.name}]`);
    }
  }
  return result;
}

export interface RedactResult<T> {
  redacted: T;
  records: RedactionRecord[];
}

export function redactObject<T>(obj: T, path = '$'): RedactResult<T> {
  const records: RedactionRecord[] = [];

  const walk = (node: unknown, currentPath: string): unknown => {
    if (typeof node === 'string') return redactString(node, records, currentPath);
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${currentPath}[${i}]`));
    if (node !== null && typeof node === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        result[k] = walk(v, `${currentPath}.${k}`);
      }
      return result;
    }
    return node;
  };

  return { redacted: walk(obj, path) as T, records };
}
