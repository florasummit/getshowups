// Anthropic structured-output limits (platform.claude.com/docs/en/build-with-claude/structured-outputs, 2026-11-15):
// ≤16 union-typed parameters (anyOf / type arrays), ≤24 optional parameters, no numeric/string-length constraints, every
// object closed. Above them the API answers 400 "Schema is too complex for compilation" before generating anything.
export function anthropicSchemaProblems(schema) {
  const problems = []
  let unions = 0
  let optional = 0
  const walk = (s, path) => {
    if (!s || typeof s !== 'object') return
    if (Array.isArray(s)) return s.forEach((x, i) => walk(x, `${path}[${i}]`))
    for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems']) if (k in s) problems.push(`${path}: ${k}`)
    if ('minItems' in s && s.minItems > 1) problems.push(`${path}: minItems > 1`)
    if (s.type === 'object') {
      if (s.additionalProperties !== false) problems.push(`${path}: object not closed`)
      for (const [k, v] of Object.entries(s.properties || {})) {
        if (v?.anyOf || Array.isArray(v?.type)) unions++
        if (!(s.required || []).includes(k)) optional++
      }
    }
    for (const [k, v] of Object.entries(s)) walk(v, `${path}.${k}`)
  }
  walk(schema, '$')
  if (unions > 16) problems.push(`${unions} union-typed parameters (limit 16)`)
  if (optional > 24) problems.push(`${optional} optional parameters (limit 24)`)
  return problems
}
