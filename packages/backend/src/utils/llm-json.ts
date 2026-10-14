/**
 * The 3-tier LLM JSON parse, lifted out of `queue-classifier.ts` so the payment
 * problem classifier can use the same one rather than grow a third copy.
 *
 * Tier 1: a fenced ```json block. Tier 2: the whole string. Tier 3: the first
 * top-level `{…}`, found by brace counting that respects string literals, which is
 * what survives a model that prefixes "Here is the JSON:" or trails a sentence
 * after the closing brace.
 *
 * Behaviour is unchanged from the original: a total failure throws.
 */

/** The first top-level JSON object in `text`, or null when there is none. */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0,
    inString = false,
    escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.substring(start, i + 1));
    }
  }
  return null;
}

/** Markdown code block → full JSON parse → brace extraction. Throws if all three fail. */
export function parseLlmJson(text: string): unknown {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) return JSON.parse(jsonMatch[1]);
  try {
    return JSON.parse(text);
  } catch {
    const extracted = extractJsonObject(text);
    if (extracted !== null) return extracted;
    throw new Error('No JSON object found in LLM response');
  }
}
