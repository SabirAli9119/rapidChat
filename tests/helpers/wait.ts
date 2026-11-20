export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Checks again and again until it returns true, or gives up. Returns whether it became true. */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<boolean> {
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt) {
    if (await check()) return true;
    await sleep(25);
  }
  return false;
}