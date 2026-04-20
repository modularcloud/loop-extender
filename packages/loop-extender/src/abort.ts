export function makeAbortError(signal?: AbortSignal): Error {
  return (
    signal?.reason ||
    new DOMException("The operation was aborted.", "AbortError")
  );
}
