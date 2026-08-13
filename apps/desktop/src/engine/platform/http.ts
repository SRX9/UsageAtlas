import { ProviderError } from "../provider";

const MAXIMUM_RESPONSE_BYTES = 1_048_576;

export type FetchImplementation = typeof fetch;

export async function fetchProviderJson(
  providerName: string,
  url: string,
  init: RequestInit,
  fetchImplementation: FetchImplementation = fetch
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, { ...init, cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ProviderError("timeout", `${providerName} usage request timed out.`, true);
    }
    throw new ProviderError("network_error", `${providerName} usage request failed.`, true);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(
      "auth_required",
      `${providerName} rejected the local OAuth credential. Sign in with the provider CLI again.`
    );
  }
  if (!response.ok) {
    throw new ProviderError(
      "provider_error",
      `${providerName} usage request failed with HTTP ${response.status}.`,
      response.status >= 500
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_RESPONSE_BYTES) {
    throw invalidResponse(providerName);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_RESPONSE_BYTES) throw invalidResponse(providerName);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(providerName);
  }
}

function invalidResponse(providerName: string): ProviderError {
  return new ProviderError("invalid_response", `${providerName} returned an invalid usage response.`);
}
