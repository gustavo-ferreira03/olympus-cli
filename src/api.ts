import { requireAuth } from "./auth.ts";

const DEFAULT_API_URL =
  process.env.OLYMPUS_API_URL || "https://shipd-mars-v2.convex.site";

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  /** Skip auth (e.g. for unauthenticated endpoints). */
  noAuth?: boolean;
}

export function getApiUrl(): string {
  return process.env.OLYMPUS_API_URL || DEFAULT_API_URL;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, params, noAuth } = opts;
  const baseUrl = getApiUrl();
  let url = `${baseUrl}${path}`;
  if (params) {
    const search = new URLSearchParams(params);
    url += `?${search.toString()}`;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!noAuth) {
    const { token } = requireAuth();
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) {
      console.error("Session expired. Run: olympus auth login");
      process.exit(1);
    }
    throw new Error(`API error (${response.status}): ${text}`);
  }
  return (await response.json()) as T;
}
