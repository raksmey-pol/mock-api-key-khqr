function preview(body: string, limit = 160) {
  const text = body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export async function readJsonResponse<T>(response: Response, label = "The request"): Promise<T> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    const snippet = preview(body);
    throw new Error(
      `${label} returned a non-JSON response (${status})${snippet ? `: ${snippet}` : " with an empty body"}.`,
    );
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `${label} failed (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}).`;
    throw new Error(message);
  }

  return parsed as T;
}
