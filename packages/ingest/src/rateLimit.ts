/**
 * A provider refused the request for quota reasons and said, or implied, when
 * to come back. Thrown rather than retried inline: the sync records how far it
 * got and the job reschedules itself for when the window resets.
 */
export class RateLimited extends Error {
  constructor(provider: string, public readonly retryAfterMs: number) {
    super(`${provider} rate limit hit; retry in ${Math.round(retryAfterMs / 1000)}s`);
  }
}
