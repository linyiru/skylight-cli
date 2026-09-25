/** A request as seen by the fake fetch; tests only send string bodies and plain-object headers. */
export interface Call {
  target: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: RequestInit['redirect'];
}

export const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);

export function recordingFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, options: RequestInit = {}) => {
    const call: Call = {
      target: new URL(String(url)), method: options.method ?? 'GET', headers: options.headers as Record<string, string>,
      body: options.body as string | undefined, redirect: options.redirect,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}
