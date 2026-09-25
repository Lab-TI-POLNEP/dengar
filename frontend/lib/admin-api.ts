const backendOrigin = process.env.NEXT_PUBLIC_BACKEND_ORIGIN ?? "";

export async function adminRequest(path: string, init?: RequestInit): Promise<Response> {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const url = backendOrigin ? `${backendOrigin}${path}` : path;
  return fetch(url, {
    ...init,
    credentials: "include",
    headers,
  });
}

export async function getCsrfToken(): Promise<string> {
  const response = await adminRequest("/admin/csrf-token");
  if (!response.ok) {
    throw new Error(`CSRF token request failed (HTTP ${response.status})`);
  }
  const payload = (await response.json()) as { csrf_token: string };
  return payload.csrf_token;
}
