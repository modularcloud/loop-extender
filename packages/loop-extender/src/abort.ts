export function makeAbortError(signal?: AbortSignal): Error {
  return (
    signal?.reason ||
    new DOMException("AbortError", "AbortError")
  );
}
