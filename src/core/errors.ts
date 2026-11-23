/** A refusal or failure with the HTTP status and the one-sentence message the agent sees. */
export class Fail extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
