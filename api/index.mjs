import { handleRequest } from "../server.mjs";

export const config = { maxDuration: 60 };

export default async function handler(request, response) {
  const requestUrl = new URL(request.url || "/", "https://aster.invalid");
  const routeValue = request.query?.path ?? requestUrl.searchParams.get("path");
  const route = Array.isArray(routeValue) ? routeValue.join("/") : routeValue;

  if (typeof route === "string" && route.length > 0) {
    if (!/^[A-Za-z0-9/_-]+$/.test(route) || route.split("/").some((part) => part === "." || part === "..")) {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "Invalid API route." }));
      return;
    }
    requestUrl.searchParams.delete("path");
    const query = requestUrl.searchParams.toString();
    request.url = `/api/${route}${query ? `?${query}` : ""}`;
  }

  await handleRequest(request, response);
}
