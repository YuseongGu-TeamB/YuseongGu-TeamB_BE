/**
 * 모델 응답 문자열에서 JSON 객체를 꺼낸다.
 * Ollama 클라우드 등은 json_schema를 강제하지 않아 ```json 코드펜스로 감싸거나 앞뒤에 문장을 붙이기도 한다.
 * 꺼낸 값은 반드시 zod로 다시 검증한다(여기서는 형식만 본다).
 */
export function extractJsonObject(text: string | null | undefined): unknown {
  if (!text?.trim()) throw new Error('빈 응답');
  const trimmed = text.trim();

  const direct = tryParse(trimmed);
  if (isObject(direct)) return direct;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (isObject(fenced)) return fenced;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = tryParse(trimmed.slice(start, end + 1));
    if (isObject(sliced)) return sliced;
  }
  throw new Error('JSON 객체를 찾을 수 없음');
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
