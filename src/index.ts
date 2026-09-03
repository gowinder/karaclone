export default {
  fetch(): Response {
    return new Response("phase0 scaffold", { status: 503 });
  },
} satisfies ExportedHandler<Env>;
