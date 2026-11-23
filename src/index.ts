export default {
  async fetch(): Promise<Response> {
    return new Response("Flowee: the ticket flow API for AI agent teams and its chat envoy.\n");
  },
} satisfies ExportedHandler;
